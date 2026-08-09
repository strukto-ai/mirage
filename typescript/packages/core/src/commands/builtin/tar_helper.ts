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

const BLOCK_SIZE = 512
const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// A ustar typeflag byte, restricted to the three kinds mirage records.
const REGTYPE = 0x30
const SYMTYPE = 0x32
const DIRTYPE = 0x35

export interface TarEntry {
  name: string
  data: Uint8Array
  isFile: boolean
  // Directories carry no content and a trailing slash; a symlink carries
  // its target in the header's linkname field instead of any content.
  isDir?: boolean
  linkname?: string
}

function writeOctalField(buf: Uint8Array, offset: number, length: number, value: number): void {
  const str = value.toString(8).padStart(length - 1, '0')
  const bytes = ENC.encode(str)
  buf.set(bytes, offset)
  buf[offset + length - 1] = 0
}

function writeStringField(buf: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = ENC.encode(value)
  const len = Math.min(bytes.byteLength, length)
  buf.set(bytes.subarray(0, len), offset)
}

function computeChecksum(header: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i] ?? 0
  return sum
}

function buildHeader(entry: TarEntry, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE)
  header.fill(0)
  const isDir = entry.isDir === true
  const isLink = entry.linkname !== undefined && entry.linkname !== ''
  // A directory member is spelled with a trailing slash; that slash is
  // what tells every extractor it holds no content.
  const name = isDir && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name
  writeStringField(header, 0, 100, name)
  writeOctalField(header, 100, 8, isDir ? 0o755 : isLink ? 0o777 : 0o644)
  writeOctalField(header, 108, 8, 0) // uid
  writeOctalField(header, 116, 8, 0) // gid
  writeOctalField(header, 124, 12, size)
  writeOctalField(header, 136, 12, Math.floor(Date.now() / 1000))
  // checksum placeholder: spaces
  for (let i = 148; i < 156; i++) header[i] = 0x20
  header[156] = isDir ? DIRTYPE : isLink ? SYMTYPE : REGTYPE
  if (isLink) writeStringField(header, 157, 100, entry.linkname ?? '')
  writeStringField(header, 257, 6, 'ustar\0')
  writeStringField(header, 263, 2, '00')
  const checksum = computeChecksum(header)
  writeOctalField(header, 148, 7, checksum)
  header[155] = 0x20
  return header
}

function readOctalField(buf: Uint8Array, offset: number, length: number): number {
  const bytes = buf.subarray(offset, offset + length)
  let str = ''
  for (const b of bytes) {
    if (b === 0 || b === 0x20) break
    str += String.fromCharCode(b)
  }
  if (str === '') return 0
  return Number.parseInt(str, 8)
}

function readStringField(buf: Uint8Array, offset: number, length: number): string {
  const bytes = buf.subarray(offset, offset + length)
  let end = 0
  while (end < bytes.byteLength && bytes[end] !== 0) end += 1
  return DEC.decode(bytes.subarray(0, end))
}

export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const entry of entries) {
    // A directory and a symlink record their identity in the header and
    // occupy no data blocks, whatever the caller put in `data`.
    const carries = entry.isDir !== true && (entry.linkname ?? '') === ''
    const data = carries ? entry.data : new Uint8Array(0)
    blocks.push(buildHeader(entry, data.byteLength))
    if (data.byteLength > 0) blocks.push(data)
    const padding = (BLOCK_SIZE - (data.byteLength % BLOCK_SIZE)) % BLOCK_SIZE
    if (padding > 0) blocks.push(new Uint8Array(padding))
  }
  blocks.push(new Uint8Array(BLOCK_SIZE * 2))
  return concat(blocks)
}

export function readTar(data: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  while (offset + BLOCK_SIZE <= data.byteLength) {
    const header = data.subarray(offset, offset + BLOCK_SIZE)
    let allZero = true
    for (let i = 0; i < BLOCK_SIZE; i++) {
      if (header[i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break
    const name = readStringField(header, 0, 100)
    const size = readOctalField(header, 124, 12)
    const typeflag = header[156]
    const isFile = typeflag === 0 || typeflag === REGTYPE
    // A trailing slash marks a directory even on an archive written
    // before ustar typeflags (GNU tar has always spelled it that way).
    const isDir = typeflag === DIRTYPE || name.endsWith('/')
    const linkname = typeflag === SYMTYPE ? readStringField(header, 157, 100) : ''
    offset += BLOCK_SIZE
    const fileData = data.subarray(offset, offset + size)
    entries.push({
      name,
      data: new Uint8Array(fileData),
      isFile: isFile && !isDir,
      isDir,
      linkname,
    })
    const padded = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    offset += padded
  }
  return entries
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
