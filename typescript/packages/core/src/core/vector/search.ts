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

import type { Accessor } from '../../accessor/base.ts'
import type { PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { floatOption, intOption, textOption, validateOptions } from '../../vfs/search.ts'
import type { SearchOps, SearchQuery } from '../../vfs/types.ts'
import type { VectorTree } from './types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function targetTable(pinned: string | null, paths: PathSpec[]): string | null {
  if (pinned !== null) return pinned
  for (const path of paths) {
    const key = stripSlash(path.mountPath)
    if (key !== '') return key.split('/')[0] ?? null
  }
  return null
}

/** Rank a table's rows and render each hit under its canonical path. */
export async function searchRowsOutput<A extends Accessor>(
  tree: VectorTree<A>,
  accessor: A,
  query: string,
  paths: PathSpec[],
  topK: number,
  threshold: number,
  mountPrefix: string,
): Promise<Uint8Array> {
  if (query === '') throw new Error('search: query is required')
  if (topK <= 0) throw new Error('search: top-k must be positive')
  const pinned = tree.pinned(accessor)
  const table = targetTable(pinned, paths)
  if (table === null) throw new Error('search: no table to search')
  const blocks: string[] = []
  for (const row of await tree.searchRows(accessor, table, query, topK)) {
    const rank = row[tree.rankKey]
    const ranked = rank !== null && rank !== undefined
    if (threshold > 0 && ranked && tree.drops(Number(rank), threshold)) continue
    const [segments, body] = tree.hit(accessor, row)
    const path = [rstripSlash(mountPrefix), ...(pinned === null ? [table] : []), ...segments].join(
      '/',
    )
    const header = ranked ? `${path}:${Number(rank).toFixed(4)}` : path
    blocks.push(`${header}\n${DEC.decode(body).replace(/\n+$/, '')}`)
  }
  return blocks.length === 0 ? new Uint8Array() : ENC.encode(blocks.join('\n') + '\n')
}

/** Build a store's ranked search, one native ranking per batch. */
export function makeSearch<A extends Accessor>(
  tree: VectorTree<A>,
): Required<Pick<SearchOps<A>, 'search' | 'searchMany'>> {
  async function searchMany(accessor: A, paths: PathSpec[], query: SearchQuery): Promise<string[]> {
    validateOptions(query, ['top_k', 'threshold', 'method'])
    const topK = intOption(query, 'top_k', tree.searchLimit(accessor))
    const first = paths[0]
    if (first === undefined) throw new Error('search: at least one scope is required')
    const method = textOption(query, 'method', 'semantic')
    const threshold = floatOption(query, 'threshold', 0)
    if (method !== 'semantic') throw new Error("search: only the 'semantic' method is supported")
    const output = await searchRowsOutput(
      tree,
      accessor,
      query.query,
      paths,
      topK,
      threshold,
      mountPrefixOf(first.virtual, first.vfsPath),
    )
    return output.length === 0 ? [] : DEC.decode(output).replace(/\n$/, '').split('\n')
  }
  return { search: (accessor, path, query) => searchMany(accessor, [path], query), searchMany }
}
