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

import { callerSignal } from '../../context/session_context.ts'
import { enoent } from '../../errors/fs.ts'
import { FileType, type FileStat, type PathSpec } from '../../types.ts'
import { resolveGlobWith } from '../../utils/glob_walk.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { listingAt, treeKey, type SlugTree } from './tree.ts'

export function validateQuery(query: string, topK: number): void {
  if (query === '') throw new Error('query is required')
  if (query.length > 250) throw new Error('query cannot exceed 250 characters')
  if (topK <= 0) throw new Error('top-k must be positive')
}

/** Every file a search scope covers, keyed by its slug. */
export async function targetEntries<A>(
  tree: SlugTree<A>,
  accessor: A,
  paths: readonly PathSpec[],
): Promise<Map<string, FileStat>> {
  const rows = await tree.load(accessor)
  const targets = new Map<string, FileStat>()
  for (const path of paths) {
    const key = treeKey(path)
    if (rows.has(key)) {
      const stem = key === '/' ? '' : key
      for (const [folder, children] of rows) {
        if (folder !== key && !folder.startsWith(stem + '/')) continue
        for (const row of children) {
          if (row.type !== FileType.DIRECTORY) {
            targets.set(stripSlash(`${folder === '/' ? '' : folder}/${row.name}`), row)
          }
        }
      }
      continue
    }
    const cut = key.lastIndexOf('/')
    const name = key.slice(cut + 1)
    const found = (rows.get(key.slice(0, cut) || '/') ?? []).find((row) => row.name === name)
    if (found === undefined) throw enoent(path.virtual)
    targets.set(stripSlash(key), found)
  }
  return targets
}

/**
 * The paths a batch search covers and the prefix its hits print under. A
 * scope at the mount root covers the whole collection, which the backend
 * searches unfiltered, so it resolves to no paths at all. Globs expand
 * against one load of the tree.
 */
export async function searchScope<A>(
  tree: SlugTree<A>,
  accessor: A,
  paths: readonly PathSpec[],
): Promise<[PathSpec[], string]> {
  const first = paths[0]
  if (first === undefined) throw new Error('at least one scope is required')
  const prefix = mountPrefixOf(first.virtual, first.vfsPath)
  if (paths.some((p) => stripSlash(p.vfsPath) === '')) return [[], prefix]
  const signal = callerSignal() ?? null
  const rows = await tree.load(accessor)
  const listed = (_accessor: A, path: PathSpec): Promise<string[]> => {
    const base = rstripSlash(path.virtual)
    return Promise.resolve(listingAt(rows, path).entries.map((row) => `${base}/${row.name}`))
  }
  return [
    await resolveGlobWith(
      listed,
      accessor,
      paths,
      undefined,
      -1,
      undefined,
      undefined,
      undefined,
      undefined,
      signal,
    ),
    prefix,
  ]
}
