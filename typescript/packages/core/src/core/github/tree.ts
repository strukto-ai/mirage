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

import type { GitHubAccessor } from '../../accessor/github.ts'
import { fetchTree } from './_client.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { GitHubTreeItem } from './_client.ts'
import { indexEntryFromTree, makeTreeEntry, type TreeEntry } from './tree_entry.ts'

export function buildTreeMap(tree: GitHubTreeItem[]): Record<string, TreeEntry> {
  const map: Record<string, TreeEntry> = {}
  for (const item of tree) map[item.path] = makeTreeEntry(item)
  return map
}

export async function populateIndex(index: IndexCacheStore, tree: GitHubTreeItem[]): Promise<void> {
  const dirs = new Map<string, [string, IndexEntry][]>()
  for (const item of tree) {
    const parts = item.path.split('/')
    const name = parts[parts.length - 1] ?? item.path
    const parent = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '/'
    const arr = dirs.get(parent) ?? []
    arr.push([name, indexEntryFromTree(item)])
    dirs.set(parent, arr)
  }
  await Promise.all([...dirs].map(([parent, entries]) => index.setDir(parent, entries)))
}

/**
 * Refetch the recursive tree and re-seed the index from it.
 *
 * The mount fetches the whole tree once and seeds the index with it, so
 * the index is the listing rather than a cache in front of one. That makes
 * a cleared or expired index indistinguishable from an empty repository --
 * `ls` reported the mount root missing after an invalidation, and reported
 * nothing at all once the day-long TTL lapsed. This is the refill that
 * makes dropping the index mean "refetch", which is what invalidating it
 * was always supposed to mean.
 *
 * Args:
 *   accessor (GitHubAccessor): the mount's accessor, holding the transport
 *     and the ref to refetch.
 *   index (IndexCacheStore | undefined): the index to re-seed.
 *
 * Returns:
 *   boolean: whether a refill happened; false when there is no index to
 *   seed, so a caller does not retry a lookup that cannot change.
 */
export async function refillIndex(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
): Promise<boolean> {
  if (index === undefined) return false
  const { tree, truncated } = await fetchTree(
    accessor.transport,
    accessor.owner,
    accessor.repo,
    accessor.ref,
  )
  accessor.truncated = truncated
  accessor.tree = buildTreeMap(tree)
  await populateIndex(index, tree)
  return true
}
