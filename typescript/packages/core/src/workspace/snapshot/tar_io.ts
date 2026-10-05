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

import { createTarDecoder, createTarPacker } from 'modern-tar'
import {
  readTar as unpackEntries,
  writeTar as packEntries,
  type TarEntry,
} from '../../commands/builtin/tar_helper.ts'
import { VFSName } from '../../types.ts'
import { gzip, gunzip } from '../../utils/compress.ts'
import {
  copyFileInto,
  fileReadable,
  fileSize,
  readFileBytes,
  stagedPath,
  writeStreamToFile,
} from './fs.ts'
import { MountKey, StateKey, VFSStateKey } from './keys.ts'
import { resolveManifest } from './manifest.ts'
import { BLOB_REF_KEY, isSafeBlobPath } from './utils.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

const MANIFEST_NAME = 'manifest.json'

export type CompressMode = null | 'gz'

/**
 * The tar as one buffer, for a caller that needs bytes (an agents SDK that
 * stores snapshots as buffers). A blob that is a host path is read in;
 * `writeTar` streams to a file instead.
 */
export async function writeSnapshotTar(
  manifest: Record<string, unknown>,
  blobs: Record<string, Uint8Array | string>,
  compress: CompressMode = null,
): Promise<Uint8Array> {
  const manifestBytes = ENC.encode(JSON.stringify(manifest, null, 2))
  const entries: TarEntry[] = [{ name: MANIFEST_NAME, data: manifestBytes, isFile: true }]
  for (const [path, data] of Object.entries(blobs)) {
    entries.push({
      name: path,
      data: typeof data === 'string' ? await readFileBytes(data) : data,
      isFile: true,
    })
  }
  const tarBytes = await packEntries(entries)
  if (compress === 'gz') return gzip(tarBytes)
  return tarBytes
}

export async function readSnapshotTar(
  data: Uint8Array,
  compress: CompressMode = null,
): Promise<unknown> {
  const tarBytes = compress === 'gz' ? await gunzip(data) : data
  const entries = await unpackEntries(tarBytes)
  const byName = new Map<string, Uint8Array>()
  for (const e of entries) byName.set(e.name, e.data)
  const manifestRaw = byName.get(MANIFEST_NAME)
  if (manifestRaw === undefined) {
    throw new Error(`${MANIFEST_NAME} missing or unreadable`)
  }
  const manifest = JSON.parse(DEC.decode(manifestRaw)) as Record<string, unknown>
  const reader = (blobPath: string): Uint8Array => {
    if (!isSafeBlobPath(blobPath)) {
      throw new Error(`Unsafe blob path: ${String(blobPath)}`)
    }
    const blob = byName.get(blobPath)
    if (blob === undefined) throw new Error(`Manifest references missing blob: ${blobPath}`)
    return blob
  }
  return resolveManifest(manifest, reader)
}

/**
 * Write manifest + blobs as a tar at `target`, streaming: a blob that is a
 * host path (a disk mount's file) is copied in chunks, so the tar never
 * holds more than one chunk of it in memory. Returns the tar's size.
 */
export async function writeTar(
  target: string,
  manifest: Record<string, unknown>,
  blobs: Record<string, Uint8Array | string>,
): Promise<number> {
  const { readable, controller } = createTarPacker()
  const written = writeStreamToFile(target, readable)
  try {
    const entries: [string, Uint8Array | string][] = [
      [MANIFEST_NAME, ENC.encode(JSON.stringify(manifest, null, 2))],
      ...Object.entries(blobs),
    ]
    for (const [name, data] of entries) {
      const size = typeof data === 'string' ? await fileSize(data) : data.byteLength
      const writer = controller.add({ name, size, type: 'file', mode: 0o644 }).getWriter()
      if (typeof data === 'string') await copyFileInto(data, writer, size)
      else await writer.write(data)
      await writer.close()
    }
    controller.finalize()
  } catch (error) {
    controller.error(error)
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
  const reader = fileReadable(source).pipeThrough(createTarDecoder()).getReader()
  let manifest: Record<string, unknown> | null = null
  let diskBlobs = new Set<string>()
  const staged = new Map<string, string>()
  const byName = new Map<string, Uint8Array>()
  // A failed read leaves the source open until it is cancelled.
  let finished = false
  try {
    for (;;) {
      const { done, value: entry } = await reader.read()
      if (done) break
      const name = entry.header.name
      if (manifest === null) {
        if (name !== MANIFEST_NAME) throw new Error(`${MANIFEST_NAME} missing or unreadable`)
        const text = DEC.decode(await new Response(entry.body).bytes())
        manifest = JSON.parse(text) as Record<string, unknown>
        diskBlobs = new Set(diskFileRefs(manifest).map(([, , blobPath]) => blobPath))
        continue
      }
      if (!isSafeBlobPath(name)) throw new Error(`Unsafe blob path: ${String(name)}`)
      if (diskBlobs.has(name)) {
        const target = await stagedPath(staging, name)
        await writeStreamToFile(target, entry.body)
        staged.set(name, target)
      } else {
        byName.set(name, await new Response(entry.body).bytes())
      }
    }
    finished = true
  } finally {
    if (!finished) await reader.cancel()
  }
  if (manifest === null) throw new Error(`${MANIFEST_NAME} missing or unreadable`)
  for (const [files, rel, blobPath] of diskFileRefs(manifest)) {
    const path = staged.get(blobPath)
    if (path === undefined) throw new Error(`Manifest references missing blob: ${blobPath}`)
    files[rel] = path
  }
  return resolveManifest(manifest, (blobPath: string): Uint8Array => {
    if (!isSafeBlobPath(blobPath)) throw new Error(`Unsafe blob path: ${String(blobPath)}`)
    const blob = byName.get(blobPath)
    if (blob === undefined) throw new Error(`Manifest references missing blob: ${blobPath}`)
    return blob
  })
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
    const vfsState = mount[MountKey.VFS_STATE] as Record<string, unknown>
    if (vfsState[VFSStateKey.TYPE] !== VFSName.DISK) continue
    const files = (vfsState[VFSStateKey.FILES] as Record<string, unknown> | undefined) ?? {}
    for (const [rel, ref] of Object.entries(files)) {
      const blobPath = (ref as Record<string, string | undefined>)[BLOB_REF_KEY]
      if (blobPath !== undefined) refs.push([files, rel, blobPath])
    }
  }
  return refs
}
