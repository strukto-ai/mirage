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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { gzip, gunzip, getCompressionCodec } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readTar, writeTar, type TarEntry } from '../tar_helper.ts'
import { lstripSlash, rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'

const ENC = new TextEncoder()

type Compression = 'gzip' | 'bzip2' | 'xz' | null

function makePathSpec(original: string, prefix: string): PathSpec {
  return new PathSpec({ original, directory: original, resolved: true, prefix })
}

function detectCompression(data: Uint8Array): Compression {
  if (data.byteLength >= 2 && data[0] === 0x1f && data[1] === 0x8b) return 'gzip'
  if (data.byteLength >= 3 && data[0] === 0x42 && data[1] === 0x5a && data[2] === 0x68)
    return 'bzip2'
  if (
    data.byteLength >= 6 &&
    data[0] === 0xfd &&
    data[1] === 0x37 &&
    data[2] === 0x7a &&
    data[3] === 0x58 &&
    data[4] === 0x5a &&
    data[5] === 0x00
  ) {
    return 'xz'
  }
  return null
}

function compressionOf(opts: CommandOpts): Compression {
  if (opts.flags.z === true) return 'gzip'
  if (opts.flags.j === true) return 'bzip2'
  if (opts.flags.J === true) return 'xz'
  return null
}

async function compress(raw: Uint8Array, kind: Compression): Promise<Uint8Array> {
  if (kind === null) return raw
  if (kind === 'gzip') return gzip(raw)
  const codec = getCompressionCodec(kind)
  if (codec === undefined) throw new Error(`tar: ${kind} not supported`)
  return codec.compress(raw)
}

async function decompress(data: Uint8Array, kind: Compression): Promise<Uint8Array> {
  const detected = kind ?? detectCompression(data)
  if (detected === null) return data
  if (detected === 'gzip') return gunzip(data)
  const codec = getCompressionCodec(detected)
  if (codec === undefined) return data
  return codec.decompress(data)
}

export async function tarGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  mkdir: (p: PathSpec) => Promise<void>,
): Promise<CommandFnResult> {
  const create = opts.flags.c === true
  const extract = opts.flags.x === true
  const list = opts.flags.t === true
  const compression = compressionOf(opts)
  const verbose = opts.flags.v === true
  // gzip is built in; bzip2 (-j) / xz (-J) need a codec registered by the
  // runtime package. Unregistered (e.g. browser core) -> not supported.
  if (
    (compression === 'bzip2' || compression === 'xz') &&
    getCompressionCodec(compression) === undefined
  ) {
    return [
      null,
      new IOResult({ exitCode: 1, stderr: ENC.encode('tar: bzip2/xz not supported\n') }),
    ]
  }
  const fFlag = typeof opts.flags.f === 'string' ? opts.flags.f : null
  const CFlag = typeof opts.flags.C === 'string' ? opts.flags.C : null
  const stripN =
    typeof opts.flags.strip_components === 'string'
      ? Number.parseInt(opts.flags.strip_components, 10)
      : 0
  const exclude = typeof opts.flags.exclude === 'string' ? opts.flags.exclude : null
  const mountPrefix = opts.mountPrefix ?? ''
  const archivePath = fFlag
  const destPath = CFlag ?? '/'
  const verboseLines: string[] = []

  if (create) {
    if (archivePath === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tar: -f is required\n') })]
    }
    const filtered =
      exclude !== null
        ? paths.filter((p) => {
            const name = p.original.split('/').pop() ?? ''
            return !fnmatch(name, exclude)
          })
        : paths
    const entries: TarEntry[] = []
    for (const p of filtered) {
      const data = await materialize(stream(p))
      const name = lstripSlash(p.original)
      entries.push({ name, data, isFile: true })
      if (verbose) verboseLines.push(name)
    }
    const raw = writeTar(entries)
    const archive = await compress(raw, compression)
    await write(makePathSpec(archivePath, mountPrefix), archive)
    const stdout = verbose ? ENC.encode(verboseLines.join('\n') + '\n') : null
    return [stdout, new IOResult({ writes: { [archivePath]: archive } })]
  }

  if (list) {
    if (archivePath === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tar: -f is required\n') })]
    }
    const raw = await materialize(stream(makePathSpec(archivePath, mountPrefix)))
    const data = await decompress(raw, compression)
    const entries = readTar(data)
    const out: ByteSource = ENC.encode(entries.map((e) => e.name).join('\n') + '\n')
    return [out, new IOResult()]
  }

  if (extract) {
    if (archivePath === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tar: -f is required\n') })]
    }
    const raw = await materialize(stream(makePathSpec(archivePath, mountPrefix)))
    const data = await decompress(raw, compression)
    const writes: Record<string, Uint8Array> = {}
    for (const entry of readTar(data)) {
      if (!entry.isFile) continue
      const nameParts = entry.name.split('/')
      const stripped = stripN > 0 ? nameParts.slice(stripN) : nameParts
      if (stripped.length === 0) continue
      const outPath = rstripSlash(destPath) + '/' + stripped.join('/')
      const parts = stripSlash(outPath).split('/')
      for (let pi = 1; pi < parts.length; pi++) {
        const d = '/' + parts.slice(0, pi).join('/')
        try {
          await mkdir(makePathSpec(d, mountPrefix))
        } catch {
          // already exists
        }
      }
      await write(makePathSpec(outPath, mountPrefix), entry.data)
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
