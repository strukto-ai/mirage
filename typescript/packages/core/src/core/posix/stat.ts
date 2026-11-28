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

import { singleQuote } from '../../utils/quote.ts'
import { FIND, ENTRY_FORMAT } from './constants.ts'
import type { PosixEntry } from './types.ts'

/**
 * The find that lists `scope` and what is below it, links followed, one
 * `ENTRY_FORMAT` record per entry.
 *
 * @param scope the path where the files are.
 * @param depth how deep to list: 0 for the scope alone (a stat), 1 for its
 *   children too (a listing), null for all.
 */
export function treeCommand(scope: string, depth: number | null = null): string {
  const bound = depth === null ? '' : ` -maxdepth ${String(depth)}`
  return `${FIND} ${singleQuote(scope)}${bound} -printf ${singleQuote(ENTRY_FORMAT)}`
}

/**
 * A `%T@` time, seconds with a fraction, in epoch milliseconds, rounded as
 * `msToRfc3339` rounds; exact, with no float between. Mirrors Python's
 * `_milliseconds`.
 *
 * @param stamp what find printed, such as `1700000000.1234567890`.
 */
function milliseconds(stamp: string): number {
  const [whole = '', fraction = ''] = stamp.split('.')
  const negative = whole.startsWith('-')
  const seconds = BigInt(negative ? whole.slice(1) : whole)
  let nanoseconds = seconds * 1_000_000_000n + BigInt(`${fraction}000000000`.slice(0, 9))
  if (negative) nanoseconds = -nanoseconds
  const shifted = nanoseconds + 500_000n
  const ms = shifted / 1_000_000n
  return Number(shifted % 1_000_000n < 0n ? ms - 1n : ms)
}

/**
 * The records a `treeCommand` printed, null when the output is not whole
 * records.
 *
 * @param out find's output.
 * @param askedNs this host's wall clock when find was asked, kept on each
 *   entry; absent keeps none.
 */
export function parseEntries(out: Uint8Array, askedNs?: bigint): PosixEntry[] | null {
  if (out[out.length - 1] !== 0) return null
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const entries: PosixEntry[] = []
  let start = 0
  for (let end = out.indexOf(0); end !== -1; end = out.indexOf(0, start)) {
    let fields: string[]
    try {
      fields = decoder.decode(out.subarray(start, end)).split(' ')
    } catch (error) {
      console.debug(`find record unread: ${String(error)}`)
      return null
    }
    start = end + 1
    const [
      kind = '',
      mode = '',
      size = '',
      mtime = '',
      atime = '',
      uid = '',
      gid = '',
      nlink = '',
      blocks = '',
    ] = fields
    if (
      fields.length < 10 ||
      !/^[0-7]+$/.test(mode) ||
      ![size, uid, gid, nlink, blocks].every((n) => /^\d+$/.test(n))
    )
      return null
    if (![mtime, atime].every((t) => /^-?\d+(\.\d*)?$/.test(t))) return null
    entries.push({
      kind,
      mode: Number.parseInt(mode, 8),
      size: Number(size),
      mtime: Number(mtime.split('.')[0]),
      atime: Number(atime.split('.')[0]),
      mtimeMs: milliseconds(mtime),
      atimeMs: milliseconds(atime),
      uid: Number(uid),
      gid: Number(gid),
      nlink: Number(nlink),
      blocks: Number(blocks),
      rel: fields.slice(9).join(' '),
      ...(askedNs !== undefined ? { askedNs } : {}),
    })
  }
  return entries
}
