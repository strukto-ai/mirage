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

import type { FileStat } from '../../types.ts'
import { FileType } from '../../types.ts'
import { FILE_MIME_MAP } from './constants.ts'

export function detectFileType(header: Uint8Array, stat: FileStat): FileType {
  if (stat.type !== null && stat.type !== FileType.BINARY) return stat.type
  const magic: [number[], FileType][] = [
    [[0x89, 0x50, 0x4e, 0x47], FileType.IMAGE_PNG],
    [[0xff, 0xd8, 0xff], FileType.IMAGE_JPEG],
    [[0x47, 0x49, 0x46, 0x38], FileType.IMAGE_GIF],
    [[0x50, 0x4b, 0x03, 0x04], FileType.ZIP],
    [[0x1f, 0x8b], FileType.GZIP],
    [[0x25, 0x50, 0x44, 0x46], FileType.PDF],
    [[0x7b, 0x0a], FileType.JSON],
    [[0x5b, 0x7b], FileType.JSON],
  ]
  for (const [sig, ftype] of magic) {
    if (startsWith(header, sig)) return ftype
  }
  const sample = header.subarray(0, 256)
  let printable = true
  for (const b of sample) {
    if (b !== 0 && b >= 128) {
      printable = false
      break
    }
  }
  return printable ? FileType.TEXT : FileType.BINARY
}

function startsWith(data: Uint8Array, sig: number[]): boolean {
  if (data.byteLength < sig.length) return false
  for (let i = 0; i < sig.length; i++) {
    if (data[i] !== sig[i]) return false
  }
  return true
}

export function formatFileResult(
  pathOriginal: string,
  // A FileType, or a ready-made description (a symlink line) that
  // passes through as-is. FileType is a string union, so one `string`
  // covers both.
  result: string,
  brief: boolean,
  mime: boolean,
): string {
  const key = result
  const desc = mime ? (FILE_MIME_MAP[key] ?? key) : key
  return brief ? desc : `${pathOriginal}: ${desc}`
}
