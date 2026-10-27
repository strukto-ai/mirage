// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { util } from 'zod'
import { drain } from '../../io/stream.ts'
import { closeStream, openStream, serveRequests, type Served } from '../../rs/stream.ts'
import { byteView, textView } from '../../shell/bytes.ts'
import { VFSName } from '../../types.ts'
import { concat } from '../../utils/bytes.ts'
import { fileChunks, fileSize, regularChunks, stagedPath, writeStreamToFile } from './fs.ts'
import { MountKey, StateKey, VFSStateKey } from './keys.ts'
import { resolveManifest } from './manifest.ts'
import { BLOB_REF_KEY, isSafeBlobPath } from './utils.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

const MANIFEST_NAME = 'manifest.json'
// The name the archive goes by inside the tar engine.
const ARCHIVE = 'snapshot.tar'

export type CompressMode = null | 'gz'

/**
 * The tar as one buffer, for a caller that needs bytes (an agents SDK that
 * stores snapshots as buffers). A blob that is a host path is read through
 * `regularChunks`, refused if a link has replaced it.
 */
export async function writeSnapshotTar(
  manifest: Record<string, unknown>,
  blobs: Record<string, Uint8Array | string>,
  compress: CompressMode = null,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  await pack(manifest, blobs, compress, (data) => {
    parts.push(data)
    return Promise.resolve()
  })
  return concat(parts)
}

export async function readSnapshotTar(
  data: Uint8Array,
  compress: CompressMode = null,
): Promise<unknown> {
  return unpack(once(data), null, compress)
}

/**
 * Write manifest + blobs as a tar at `target`, streaming: a blob that is a
 * host path (a disk mount's file) is read a chunk at a time, opened only
 * while it is read. Returns the tar's size.
 */
export async function writeTar(
  target: string,
  manifest: Record<string, unknown>,
  blobs: Record<string, Uint8Array | string>,
): Promise<number> {
  const [writer, written] = fileWriter(target)
  try {
    await pack(manifest, blobs, null, (data) => writer.write(data))
    await writer.close()
  } catch (error) {
    await writer.abort(error)
    await written.catch(() => undefined)
    throw error
  }
  return written
}

/**
 * Read a tar written by `writeTar` from the file at `source`, streaming.
 * Each disk mount's files are extracted under `staging` and come back as
 * host paths, so a restore copies them into place instead of holding them
 * in memory; the caller removes the directory once the state is loaded.
 */
export async function readTar(source: string, staging: string): Promise<unknown> {
  return unpack(fileChunks(source), staging, null)
}

/**
 * Run mirage-rs's tar to its end, `serve` answering each request; a refusal
 * throws in tar's own words.
 */
async function run(
  config: Record<string, util.JSONType>,
  serve: (request: Readonly<Record<string, util.JSONType>>, data: Uint8Array) => Promise<Served>,
): Promise<void> {
  const stream = await openStream('tar', config)
  const errors: Uint8Array[] = []
  const host = {
    errors: {
      append: (data: Uint8Array) => {
        errors.push(data)
        return Promise.resolve()
      },
    },
    serve,
  }
  try {
    await drain(serveRequests(stream, host))
    if (stream.status() !== 0) throw new Error(DEC.decode(concat(errors)).trim())
  } finally {
    await closeStream(stream)
  }
}

/** The manifest, then each blob, as tar's -c writes them to `write`. */
async function pack(
  manifest: Record<string, unknown>,
  blobs: Record<string, Uint8Array | string>,
  compress: CompressMode,
  write: (data: Uint8Array) => Promise<void>,
): Promise<void> {
  const entries: [string, Uint8Array | string][] = [
    [MANIFEST_NAME, ENC.encode(JSON.stringify(manifest, null, 2))],
    ...Object.entries(blobs),
  ]
  const members: util.JSONType[] = []
  for (const [index, [name, data]] of entries.entries()) {
    const size = typeof data === 'string' ? await fileSize(data) : data.byteLength
    members.push({ name: byteView(name), path: byteView(name), operand: index + 2, size })
  }
  const inputs = new Map<number, AsyncGenerator<Uint8Array>>()
  try {
    await run(
      {
        mode: 'create',
        archive: ARCHIVE,
        output: ARCHIVE,
        codec: compress === 'gz' ? 'gzip' : null,
        members,
      },
      async (request, data) => {
        if (request.op === 'write') await write(data)
        if (request.op !== 'read') return { reply: {} }
        const fd = request.fd as number
        if (typeof request.operand === 'number') {
          const blob = entries[request.operand - 2]?.[1] ?? new Uint8Array()
          inputs.set(fd, typeof blob === 'string' ? regularChunks(blob) : once(blob))
        }
        const next = await inputs.get(fd)?.next()
        if (next === undefined || next.done === true) {
          inputs.delete(fd)
          return { reply: { end: true } }
        }
        return { reply: {}, data: next.value }
      },
    )
  } finally {
    for (const input of inputs.values()) await input.return(undefined)
  }
}

/**
 * Read a snapshot tar from `source` in one pass: the manifest first, then
 * each blob it names, a disk mount's file written under `staging` when there
 * is one, every other blob held in memory; a member it names no blob for is
 * read past.
 */
async function unpack(
  source: AsyncGenerator<Uint8Array>,
  staging: string | null,
  compress: CompressMode,
): Promise<unknown> {
  const held = new Map<string, Uint8Array[]>()
  const staged = new Map<string, string>()
  const files = new Map<string, [WritableStreamDefaultWriter<Uint8Array>, Promise<number>]>()
  let manifest: Record<string, unknown> | null = null
  let wanted = new Set<string>()
  let diskBlobs = new Set<string>()
  const begin = async (name: string): Promise<void> => {
    if (name === MANIFEST_NAME) {
      held.set(name, [])
      return
    }
    if (manifest === null) {
      manifest = manifestOf(held)
      wanted = new Set([...blobPaths(manifest)].map(memberName))
      diskBlobs = new Set(diskFileRefs(manifest).map(([, , blobPath]) => memberName(blobPath)))
    }
    if (!wanted.has(name)) return
    if (staging === null || !diskBlobs.has(name)) {
      held.set(name, [])
      return
    }
    const target = await stagedPath(staging, name)
    files.set(name, fileWriter(target))
    staged.set(name, target)
  }
  const serve = async (
    request: Readonly<Record<string, util.JSONType>>,
    data: Uint8Array,
  ): Promise<Served> => {
    if (request.op === 'read') {
      const next = await source.next()
      return next.done === true ? { reply: { end: true } } : { reply: {}, data: next.value }
    }
    if (request.op === 'stat') return { reply: { kind: 'dir' } }
    if ((request.op !== 'write' && request.op !== 'flush') || typeof request.path !== 'string') {
      return { reply: {} }
    }
    const name = textView(request.path).replace(/^\/+/, '')
    if (request.create === true || request.whole === true) await begin(name)
    const file = files.get(name)
    if (file === undefined) {
      held.get(name)?.push(data)
      return { reply: {} }
    }
    await file[0].write(data)
    if (request.op === 'flush' || request.whole === true) {
      files.delete(name)
      await file[0].close()
      await file[1]
    }
    return { reply: {} }
  }
  try {
    await run(
      { mode: 'extract', archive: ARCHIVE, base: '', codec: compress === 'gz' ? 'gzip' : null },
      serve,
    )
  } finally {
    for (const [writer, written] of files.values()) {
      await writer.abort()
      await written.catch(() => undefined)
    }
    await source.return(undefined)
  }
  manifest ??= manifestOf(held)
  for (const [map, rel, blobPath] of diskFileRefs(manifest)) {
    const path = staged.get(memberName(blobPath))
    if (path !== undefined) map[rel] = path
  }
  return resolveManifest(manifest, (blobPath: string): Uint8Array => {
    if (!isSafeBlobPath(blobPath)) throw new Error(`Unsafe blob path: ${String(blobPath)}`)
    const blob = held.get(memberName(blobPath))
    if (blob === undefined) throw new Error(`Manifest references missing blob: ${blobPath}`)
    return concat(blob)
  })
}

/** A writer into a new file at `path`, whose writes fail once the copy into the file does. */
function fileWriter(path: string): [WritableStreamDefaultWriter<Uint8Array>, Promise<number>] {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const written = writeStreamToFile(path, readable)
  void written.catch((error: unknown) => writer.abort(error))
  return [writer, written]
}

/** The name tar's -x gives the member a blob path was written under: the path without its empty and `.` components. */
function memberName(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/')
}

/** Every blob path the manifest names, each checked safe. */
function blobPaths(manifest: Record<string, unknown>): Set<string> {
  const paths = new Set<string>()
  resolveManifest(manifest, (path) => {
    paths.add(path)
    return new Uint8Array()
  })
  return paths
}

async function* once(data: Uint8Array): AsyncGenerator<Uint8Array> {
  await Promise.resolve()
  yield data
}

/** The manifest, the archive's first member, parsed. */
function manifestOf(held: Map<string, Uint8Array[]>): Record<string, unknown> {
  const raw = held.get(MANIFEST_NAME)
  if (raw === undefined) throw new Error(`${MANIFEST_NAME} missing or unreadable`)
  return JSON.parse(DEC.decode(concat(raw))) as Record<string, unknown>
}

/**
 * Every disk mount file's blob reference in the manifest, as the files map
 * holding it, its key and its tar path: what a restore stages on disk.
 */
function diskFileRefs(
  manifest: Record<string, unknown>,
): [Record<string, unknown>, string, string][] {
  const refs: [Record<string, unknown>, string, string][] = []
  for (const mount of (manifest[StateKey.MOUNTS] as Record<string, unknown>[] | undefined) ?? []) {
    const vfsState = mount[MountKey.VFS_STATE] as Record<string, unknown> | undefined
    if (vfsState?.[VFSStateKey.TYPE] !== VFSName.DISK) continue
    const files = (vfsState[VFSStateKey.FILES] as Record<string, unknown> | undefined) ?? {}
    for (const [rel, ref] of Object.entries(files)) {
      const blobPath = (ref as Record<string, string | undefined>)[BLOB_REF_KEY]
      if (blobPath !== undefined) refs.push([files, rel, blobPath])
    }
  }
  return refs
}
