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

import type { PosixStat } from '../stat.ts'
import type { VFSEntry, VFSStat } from '../types.ts'
import { S_IFCHR, S_IFMT } from '../../utils/stat_view.ts'
import { ALL_RIGHTS, FT_CHR, FT_DIR, FT_REG, FT_SYMLINK, FT_UNKNOWN } from './constants.ts'

/**
 * The preview1 filetype for one stat or listing row.
 *
 * @param row - the row to classify; a listing row with no mode is one
 *   the file adapter could not classify.
 */
export function filetypeOf(row: VFSStat | VFSEntry): number {
  if (row.isLink === true) return FT_SYMLINK
  if (row.isDir) return FT_DIR
  if (row.mode === undefined) return FT_UNKNOWN
  return (row.mode & S_IFMT) === S_IFCHR ? FT_CHR : FT_REG
}

/**
 * Encode a prestat record for a preopened directory.
 *
 * @param nameLength - byte length of the preopen's guest path.
 */
export function packPrestat(nameLength: number): Uint8Array {
  const record = new Uint8Array(8)
  new DataView(record.buffer).setUint32(4, nameLength, true)
  return record
}

/**
 * Encode an fdstat record reporting full rights.
 *
 * @param filetype - preview1 filetype of the descriptor.
 */
export function packFdstat(filetype: number): Uint8Array {
  const record = new Uint8Array(24)
  const view = new DataView(record.buffer)
  view.setUint8(0, filetype)
  view.setBigUint64(8, ALL_RIGHTS, true)
  view.setBigUint64(16, ALL_RIGHTS, true)
  return record
}

/** Epoch milliseconds as the nanoseconds preview1 asks in, to the
 * microsecond: the product alone is past 2**53, and a millisecond float
 * this far from the epoch holds no finer digit. */
function nanoseconds(ms: number): bigint {
  const whole = Math.floor(ms)
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1000)) * 1000n
}

/**
 * Encode a filestat record from the stat every runtime shares.
 *
 * @param st - the path's stat.
 * @param filetype - preview1 filetype.
 */
export function packFilestat(st: PosixStat, filetype: number): Uint8Array {
  const record = new Uint8Array(64)
  const view = new DataView(record.buffer)
  view.setBigUint64(0, BigInt(st.dev), true)
  view.setBigUint64(8, BigInt(st.ino), true)
  view.setUint8(16, filetype)
  view.setBigUint64(24, BigInt(st.nlink), true)
  view.setBigUint64(32, BigInt(st.size), true)
  view.setBigUint64(40, nanoseconds(st.atimeMs), true)
  view.setBigUint64(48, nanoseconds(st.mtimeMs), true)
  view.setBigUint64(56, nanoseconds(st.ctimeMs), true)
  return record
}
