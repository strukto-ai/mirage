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
import { FIND, TREE_FORMAT } from './constants.ts'
import type { TreeRow } from './types.ts'

/**
 * The find that lists `scope` and what is below it, links followed, one
 * `TREE_FORMAT` record per entry.
 *
 * @param scope the path where the files are.
 * @param depth how deep to list: 0 for the scope alone (a stat), 1 for its
 *   children too (a listing), null for all.
 */
export function treeCommand(scope: string, depth: number | null = null): string {
  const bound = depth === null ? '' : ` -maxdepth ${String(depth)}`
  return `${FIND} ${singleQuote(scope)}${bound} -printf ${singleQuote(TREE_FORMAT)}`
}

/**
 * The records a `treeCommand` printed, null when the output is not whole
 * records.
 *
 * @param out find's output.
 */
export function parseTree(out: Uint8Array): TreeRow[] | null {
  if (out[out.length - 1] !== 0) return null
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const rows: TreeRow[] = []
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
    const [kind = '', mode = '', size = '', mtime = '', atime = '', user = '', group = ''] = fields
    if (fields.length < 8 || !/^[0-7]+$/.test(mode) || !/^\d+$/.test(size)) return null
    if (![mtime, atime].every((t) => /^-?\d+(\.\d*)?$/.test(t))) return null
    rows.push({
      kind,
      mode: Number.parseInt(mode, 8),
      size: Number(size),
      mtime: Number(mtime.split('.')[0]),
      atime: Number(atime.split('.')[0]),
      user,
      group,
      rel: fields.slice(7).join(' '),
    })
  }
  return rows
}
