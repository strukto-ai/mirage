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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { gzip, gunzip, getCompressionCodec } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readTar, writeTar, type TarEntry } from '../tar_helper.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { COMPRESSION_SIGNATURES } from './tar/constants.ts'
import { planCreate, type DirProbe, type StatFn, type WalkFn } from './tar/create.ts'
import type { Compression, CompressionKind, CreateResult } from './tar/types.ts'

const ENC = new TextEncoder()

// What tar needs from the mount it runs on. `stat` and `walk` are what
// make a directory operand archivable at all; `isDir` answers on two
// channels so a prefix-store directory (no object of its own) is not
// mistaken for an absent one.
export interface TarDeps {
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>
  write: (p: PathSpec, data: Uint8Array) => Promise<void>
  mkdir: (p: PathSpec, parents?: boolean) => Promise<void>
  stat: StatFn
  walk: WalkFn
  isDir: DirProbe
}

function makePathSpec(virtual: string, prefix: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: mountKey(virtual, prefix),
    resolved: true,
  })
}

function detectCompression(data: Uint8Array): Compression {
  for (const kind of Object.keys(COMPRESSION_SIGNATURES) as CompressionKind[]) {
    const signature = COMPRESSION_SIGNATURES[kind]
    if (
      data.byteLength >= signature.length &&
      signature.every((byte, index) => data[index] === byte)
    ) {
      return kind
    }
  }
  return null
}

function compressionOf(opts: CommandOpts): Compression {
  const fl = new FlagView(opts.flags, specOf('tar'))
  if (fl.asBool('z')) return 'gzip'
  if (fl.asBool('j')) return 'bzip2'
  if (fl.asBool('J')) return 'xz'
  return null
}

async function compress(raw: Uint8Array, kind: Compression): Promise<Uint8Array> {
  if (kind === null) return raw
  if (kind === 'gzip') return gzip(raw)
  const codec = getCompressionCodec(kind)
  if (codec?.compress === undefined) throw new Error(`tar: ${kind} not supported`)
  return codec.compress(raw)
}

// gzip is built in; bzip2 (-j) / xz (-J) need a codec registered by the
// runtime package, and a codec may be decompress-only (bzip2 is), which only
// rules out creating an archive. Answers the kind that cannot be served, so
// the caller names it.
function unsupportedKind(compression: Compression, create: boolean): CompressionKind | null {
  if (compression !== 'bzip2' && compression !== 'xz') return null
  const codec = getCompressionCodec(compression)
  if (codec === undefined) return compression
  return create && codec.compress === undefined ? compression : null
}

async function decompress(data: Uint8Array, kind: Compression): Promise<Uint8Array> {
  const detected = kind ?? detectCompression(data)
  if (detected === null) return data
  if (detected === 'gzip') return gunzip(data)
  const codec = getCompressionCodec(detected)
  if (codec === undefined) return data
  return codec.decompress(data)
}

function stderrOf(lines: readonly string[]): Uint8Array | null {
  return lines.length > 0 ? ENC.encode(`${lines.join('\n')}\n`) : null
}

async function writeArchive(
  plan: CreateResult,
  archivePath: string,
  mountPrefix: string,
  compression: Compression,
  verbose: boolean,
  deps: TarDeps,
): Promise<CommandFnResult> {
  const entries: TarEntry[] = []
  const names: string[] = []
  for (const member of plan.members) {
    const data =
      member.path !== null ? await materialize(deps.stream(member.path)) : new Uint8Array(0)
    entries.push({
      name: member.name,
      data,
      isFile: member.kind === 'file',
      isDir: member.kind === 'dir',
      linkname: member.kind === 'link' ? member.target : '',
    })
    names.push(member.name)
  }
  const raw = await writeTar(entries)
  const archive = await compress(raw, compression)
  await deps.write(makePathSpec(archivePath, mountPrefix), archive)
  const stderr = stderrOf(plan.notices)
  const stdout = verbose && names.length > 0 ? ENC.encode(`${names.join('\n')}\n`) : null
  return [
    stdout,
    new IOResult({
      writes: { [archivePath]: archive },
      exitCode: plan.exitCode,
      ...(stderr !== null ? { stderr } : {}),
    }),
  ]
}

export async function tarGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  deps: TarDeps,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('tar'))
  const create = fl.asBool('c')
  const extract = fl.asBool('x')
  const list = fl.asBool('t')
  const compression = compressionOf(opts)
  const verbose = fl.asBool('v')
  const missing = unsupportedKind(compression, create)
  if (missing !== null) {
    return [
      null,
      new IOResult({ exitCode: 1, stderr: ENC.encode(`tar: ${missing} not supported\n`) }),
    ]
  }
  const fFlag = fl.asStr('f') ?? null
  const CFlags = fl.asList('C')
  // Only the last -C is a destination; create checks every one.
  const CFlag = CFlags.length > 0 ? (CFlags[CFlags.length - 1] ?? null) : null
  const stripN = fl.asInt('strip_components') ?? 0
  const exclude = fl.asStr('exclude') ?? null
  const mountPrefix = opts.mountPrefix ?? ''
  const archivePath = fFlag
  const destPath = CFlag ?? '/'
  const verboseLines: string[] = []

  if (create) {
    if (archivePath === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tar: -f is required\n') })]
    }
    const plan = await planCreate(paths, {
      archive: makePathSpec(archivePath, mountPrefix),
      exclude,
      dereference: fl.asBool('h'),
      stat: deps.stat,
      walk: deps.walk,
      isDir: deps.isDir,
      directories: CFlags.map((c) => makePathSpec(c, mountPrefix)),
      links: opts.links ?? null,
      mounts: opts.mounts ?? null,
    })
    if (!plan.write) {
      const stderr = stderrOf(plan.notices)
      return [
        null,
        new IOResult({
          exitCode: plan.exitCode,
          ...(stderr !== null ? { stderr } : {}),
        }),
      ]
    }
    return writeArchive(plan, archivePath, mountPrefix, compression, verbose, deps)
  }

  if (list) {
    if (archivePath === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tar: -f is required\n') })]
    }
    const raw = await materialize(deps.stream(makePathSpec(archivePath, mountPrefix)))
    const data = await decompress(raw, compression)
    const entries = await readTar(data)
    const out: ByteSource = ENC.encode(
      entries.map((e) => (e.isDir === true ? `${rstripSlash(e.name)}/` : e.name)).join('\n') + '\n',
    )
    return [out, new IOResult()]
  }

  if (extract) {
    if (archivePath === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tar: -f is required\n') })]
    }
    const raw = await materialize(deps.stream(makePathSpec(archivePath, mountPrefix)))
    const data = await decompress(raw, compression)
    const writes: Record<string, Uint8Array> = {}
    for (const entry of await readTar(data)) {
      // A symlink member has no bytes to write and no namespace to write
      // into from here (links are workspace state, not the backend's),
      // so extraction skips it rather than dropping an empty file where
      // a link belongs.
      const isDir = entry.isDir === true
      if (!entry.isFile && !isDir) continue
      const nameParts = rstripSlash(entry.name).split('/')
      const stripped = stripN > 0 ? nameParts.slice(stripN) : nameParts
      if (stripped.length === 0 || (stripped.length === 1 && stripped[0] === '')) continue
      const outPath = `${rstripSlash(destPath)}/${stripped.join('/')}`
      if (isDir) {
        // A directory member is the only record an empty directory
        // leaves, so it has to be recreated even though nothing is
        // written inside it.
        await deps.mkdir(makePathSpec(outPath, mountPrefix), true)
        if (verbose) verboseLines.push(`${rstripSlash(entry.name)}/`)
        continue
      }
      const parent = outPath.slice(0, outPath.lastIndexOf('/')) || '/'
      if (parent !== '/') await deps.mkdir(makePathSpec(parent, mountPrefix), true)
      await deps.write(makePathSpec(outPath, mountPrefix), entry.data)
      writes[outPath] = entry.data
      if (verbose) verboseLines.push(entry.name)
    }
    const stdout = verbose ? ENC.encode(verboseLines.join('\n') + '\n') : null
    return [stdout, new IOResult({ writes })]
  }

  return [
    null,
    new IOResult({ exitCode: 1, stderr: ENC.encode('tar: must specify -c, -x, or -t\n') }),
  ]
}
