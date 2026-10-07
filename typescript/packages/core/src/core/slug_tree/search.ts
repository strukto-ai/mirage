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

import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { DEFAULT_MAX_GLOB_MATCHES, resolveGlobWith } from '../../utils/glob_walk.ts'
import { mountPrefixOf, rekey } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { SlugTree } from './tree.ts'

export function validateQuery(query: string, topK: number): void {
  if (query === '') throw new Error('search: query is required')
  if (query.length > 250) throw new Error('search: query cannot exceed 250 characters')
  if (topK <= 0) throw new Error('search: top-k must be positive')
}

/** Every file a search scope covers, keyed by entry id. */
export async function targetEntries<A>(
  tree: SlugTree<A>,
  accessor: A,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<Map<string, IndexEntry>> {
  const targets = new Map<string, IndexEntry>()
  for (const path of paths) {
    const resolved = await tree.resolve(accessor, path, index)
    if (!resolved.isDir) {
      targets.set(resolved.entry.id, resolved.entry)
      continue
    }
    for (const child of await tree.walk(accessor, path, index)) {
      const childSpec = PathSpec.fromStrPath(child, rekey(path.virtual, path.vfsPath, child))
      const childResolved = await tree.resolve(accessor, childSpec, index)
      if (!childResolved.isDir) targets.set(childResolved.entry.id, childResolved.entry)
    }
  }
  return targets
}

/**
 * The paths a batch search covers and the prefix its hits print under. A
 * scope at the mount root covers the whole collection, which the backend
 * searches unfiltered, so it resolves to no paths at all.
 */
export async function searchScope<A>(
  tree: SlugTree<A>,
  accessor: A,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<[PathSpec[], string]> {
  const first = paths[0]
  if (first === undefined) throw new Error('search: at least one scope is required')
  const prefix = mountPrefixOf(first.virtual, first.vfsPath)
  if (paths.some((p) => stripSlash(p.vfsPath) === '')) return [[], prefix]
  return [
    await resolveGlobWith(tree.readdir, accessor, paths, index, DEFAULT_MAX_GLOB_MATCHES),
    prefix,
  ]
}
