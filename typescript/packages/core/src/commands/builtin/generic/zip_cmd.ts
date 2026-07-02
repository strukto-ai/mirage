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
import type { PathSpec } from '../../../types.ts'
import { deflateRaw } from '../../../utils/compress.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { lstripSlash } from '../../../utils/slash.ts'
import { gnuBasename } from '../../../utils/path.ts'

const ENC = new TextEncoder()

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.byteLength; i++) {
    c = (CRC_TABLE[((c ^ (data[i] ?? 0)) & 0xff) >>> 0] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function writeU16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
  buf[offset + 2] = (value >>> 16) & 0xff
  buf[offset + 3] = (value >>> 24) & 0xff
}

interface ZipItem {
  name: string
  data: Uint8Array
  compressed: Uint8Array
  crc: number
  method: number
  localOffset: number
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

function buildZip(items: ZipItem[]): Uint8Array {
  const parts: Uint8Array[] = []
  let offset = 0
  for (const item of items) {
    item.localOffset = offset
    const nameBytes = ENC.encode(item.name)
    const header = new Uint8Array(30 + nameBytes.byteLength)
    writeU32LE(header, 0, 0x04034b50)
    writeU16LE(header, 4, 20)
    writeU16LE(header, 6, 0)
    writeU16LE(header, 8, item.method)
    writeU16LE(header, 10, 0)
    writeU16LE(header, 12, 0)
    writeU32LE(header, 14, item.crc)
    writeU32LE(header, 18, item.compressed.byteLength)
    writeU32LE(header, 22, item.data.byteLength)
    writeU16LE(header, 26, nameBytes.byteLength)
    writeU16LE(header, 28, 0)
    header.set(nameBytes, 30)
    parts.push(header)
    parts.push(item.compressed)
    offset += header.byteLength + item.compressed.byteLength
  }
  const centralStart = offset
  for (const item of items) {
    const nameBytes = ENC.encode(item.name)
    const central = new Uint8Array(46 + nameBytes.byteLength)
    writeU32LE(central, 0, 0x02014b50)
    writeU16LE(central, 4, 20)
    writeU16LE(central, 6, 20)
    writeU16LE(central, 8, 0)
    writeU16LE(central, 10, item.method)
    writeU16LE(central, 12, 0)
    writeU16LE(central, 14, 0)
    writeU32LE(central, 16, item.crc)
    writeU32LE(central, 20, item.compressed.byteLength)
    writeU32LE(central, 24, item.data.byteLength)
    writeU16LE(central, 28, nameBytes.byteLength)
    writeU16LE(central, 30, 0)
    writeU16LE(central, 32, 0)
    writeU16LE(central, 34, 0)
    writeU16LE(central, 36, 0)
    writeU32LE(central, 38, 0)
    writeU32LE(central, 42, item.localOffset)
    central.set(nameBytes, 46)
    parts.push(central)
    offset += central.byteLength
  }
  const centralSize = offset - centralStart
  const end = new Uint8Array(22)
  writeU32LE(end, 0, 0x06054b50)
  writeU16LE(end, 4, 0)
  writeU16LE(end, 6, 0)
  writeU16LE(end, 8, items.length)
  writeU16LE(end, 10, items.length)
  writeU32LE(end, 12, centralSize)
  writeU32LE(end, 16, centralStart)
  writeU16LE(end, 20, 0)
  parts.push(end)
  return concat(parts)
}

export async function zipGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  if (paths.length < 2) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode('zip: usage: zip archive.zip file1 [file2 ...]\n'),
      }),
    ]
  }
  const archivePath = paths[0]
  const filePaths = paths.slice(1)
  if (archivePath === undefined) return [null, new IOResult()]
  const junkPaths = opts.flags.j === true
  const quiet = opts.flags.q === true

  const items: ZipItem[] = []
  const outputLines: string[] = []
  for (const p of filePaths) {
    const raw = await materialize(stream(p))
    const data = new Uint8Array(raw.byteLength)
    data.set(raw)
    const arcname = junkPaths ? gnuBasename(p.virtual) : lstripSlash(p.virtual)
    const compressed = await deflateRaw(data)
    items.push({
      name: arcname,
      data,
      compressed,
      crc: crc32(data),
      method: 8,
      localOffset: 0,
    })
    if (!quiet) outputLines.push(`  adding: ${arcname}`)
  }
  const archive = buildZip(items)
  await write(archivePath, archive)
  const stdout: ByteSource | null =
    outputLines.length > 0 ? ENC.encode(outputLines.join('\n') + '\n') : null
  return [stdout, new IOResult({ writes: { [archivePath.mountPath]: archive } })]
}
