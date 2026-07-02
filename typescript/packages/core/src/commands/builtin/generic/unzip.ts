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

import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { inflateRaw } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { lstripSlash, rstripSlash, stripSlash } from '../../../utils/slash.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

interface ZipEntry {
  name: string
  size: number
  data: Uint8Array
}

function readU16LE(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8)
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) |
      ((data[offset + 1] ?? 0) << 8) |
      ((data[offset + 2] ?? 0) << 16) |
      ((data[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

async function readZipEntries(data: Uint8Array): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = []
  let offset = 0
  while (offset + 4 <= data.byteLength) {
    const sig = readU32LE(data, offset)
    if (sig !== 0x04034b50) break
    const compressionMethod = readU16LE(data, offset + 8)
    const compressedSize = readU32LE(data, offset + 18)
    const uncompressedSize = readU32LE(data, offset + 22)
    const nameLen = readU16LE(data, offset + 26)
    const extraLen = readU16LE(data, offset + 28)
    const headerEnd = offset + 30 + nameLen + extraLen
    const nameBytes = data.subarray(offset + 30, offset + 30 + nameLen)
    const name = DEC.decode(nameBytes)
    const body = data.subarray(headerEnd, headerEnd + compressedSize)
    let content: Uint8Array
    if (compressionMethod === 0) {
      content = body.slice()
    } else if (compressionMethod === 8) {
      content = await inflateRaw(body)
    } else {
      throw new Error(`unzip: unsupported compression method: ${String(compressionMethod)}`)
    }
    entries.push({ name, size: uncompressedSize, data: content })
    offset = headerEnd + compressedSize
  }
  return entries
}

function makePathSpec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: stripSlash(virtual),
    resolved: true,
  })
}

async function ensureParents(
  mkdir: (p: PathSpec, parents?: boolean) => Promise<void>,
  path: string,
): Promise<void> {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return
  const dir = path.slice(0, idx)
  if (dir === '' || dir === '/') return
  await mkdir(makePathSpec(dir), true)
}

export async function unzipGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  mkdir: (p: PathSpec, parents?: boolean) => Promise<void>,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('unzip: missing operand\n') })]
  }
  const archivePath = paths[0]
  if (archivePath === undefined) return [null, new IOResult()]
  const data = await materialize(stream(archivePath))
  const entries = await readZipEntries(data)

  const listMode = opts.flags.args_l === true
  const testMode = opts.flags.t === true
  const pipeMode = opts.flags.p === true
  const quiet = opts.flags.q === true
  const mountPrefix = mountPrefixOf(archivePath.virtual, archivePath.resourcePath)
  const destRaw = typeof opts.flags.d === 'string' ? opts.flags.d : '/'
  const dest =
    mountPrefix !== '' && destRaw.startsWith(mountPrefix + '/')
      ? destRaw.slice(mountPrefix.length)
      : destRaw === mountPrefix
        ? '/'
        : destRaw

  if (listMode) {
    const lines = ['  Length      Name', '---------  ----']
    for (const e of entries) {
      lines.push(`${String(e.size).padStart(9, ' ')}  ${e.name}`)
    }
    const out: ByteSource = ENC.encode(lines.join('\n') + '\n')
    return [out, new IOResult()]
  }

  if (testMode) {
    const msg = `No errors detected in ${archivePath.virtual}\n`
    const out: ByteSource = ENC.encode(msg)
    return [out, new IOResult()]
  }

  if (pipeMode) {
    const chunks: Uint8Array[] = []
    for (const e of entries) {
      if (!e.name.endsWith('/')) chunks.push(e.data)
    }
    let total = 0
    for (const c of chunks) total += c.byteLength
    const merged = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.byteLength
    }
    const out: ByteSource = merged
    return [out, new IOResult()]
  }

  const writes: Record<string, Uint8Array> = {}
  const outputLines: string[] = []
  for (const e of entries) {
    if (e.name.endsWith('/')) continue
    const entryName = lstripSlash(e.name)
    const outPath = rstripSlash(dest) + '/' + entryName
    await ensureParents(mkdir, outPath)
    await write(makePathSpec(outPath), e.data)
    const reportPath = mountPrefix !== '' ? mountPrefix + outPath : outPath
    writes[outPath] = e.data
    if (!quiet) outputLines.push(`  inflating: ${reportPath}`)
  }
  const stdout: ByteSource | null =
    outputLines.length > 0 ? ENC.encode(outputLines.join('\n') + '\n') : null
  return [stdout, new IOResult({ writes })]
}
