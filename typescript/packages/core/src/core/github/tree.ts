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
import { fetchDirTreePage, fetchTree, GitHubApiError } from './client.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { LookupStatus } from '../../cache/index/config.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { GitHubTreeItem } from './client.ts'
import { indexEntryFromTree, makeTreeEntry, type TreeEntry } from './tree_entry.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'

// A point request answering these did not see the parent directory: it is
// missing, the ref is gone, the repository is hidden (GitHub answers 404 for
// all three) or a component of the path is a file (422). None of them is an
// answer about the file, so the caller asks the whole tree instead, where a
// real absence is honest and a refusal raises.
const DEFER_STATUSES: ReadonlySet<number> = new Set([404, 422])

export function buildTreeMap(tree: GitHubTreeItem[]): Record<string, TreeEntry> {
  const map: Record<string, TreeEntry> = {}
  for (const item of tree) map[item.path] = makeTreeEntry(item)
  return map
}

export async function populateIndex(
  index: IndexCacheStore,
  tree: Record<string, TreeEntry>,
  prefix: string,
  expiresAt?: Date,
): Promise<void> {
  // Keyed by mount-absolute path, the way every other backend keys its
  // index, so the shared cache machinery can spell an eviction without
  // knowing which backend it is talking to. The tree itself stays
  // repo-relative; `prefix` is what lifts it.
  const stem = rstripSlash(prefix)
  const dirs = new Map<string, [string, IndexEntry][]>()
  // The repository root always exists, so it gets a row even when the tree
  // is empty. Without it an empty repository is byte for byte a dropped
  // index, and `ensureLiveIndex` would refetch on every read of one.
  dirs.set(stem === '' ? '/' : stem, [])
  for (const item of Object.values(tree)) {
    if (item.type === 'tree' && !dirs.has(`${stem}/${item.path}`)) {
      dirs.set(`${stem}/${item.path}`, [])
    }
    const parts = item.path.split('/')
    const name = parts[parts.length - 1] ?? item.path
    const parent =
      parts.length > 1 ? `${stem}/${parts.slice(0, -1).join('/')}` : stem === '' ? '/' : stem
    const arr = dirs.get(parent) ?? []
    arr.push([name, indexEntryFromTree(item)])
    dirs.set(parent, arr)
  }
  await Promise.all([...dirs].map(([parent, entries]) => index.setDir(parent, entries, expiresAt)))
}

/**
 * Write the accessor's tree into `index` under `prefix`.
 *
 * Mirrors Python's `seed_index`.
 */
async function seedIndex(
  accessor: GitHubAccessor,
  index: IndexCacheStore,
  prefix: string,
): Promise<void> {
  // A truncated response cannot establish that any listing is complete,
  // including an apparently empty directory. Readdir must fill it first.
  await populateIndex(index, accessor.tree, prefix, accessor.truncated ? new Date(0) : undefined)
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
  prefix: string,
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
  accessor.refills += 1
  // A refill replaces this mount's snapshot, including paths now absent.
  await index.invalidatePrefix(rstripSlash(prefix) || '/')
  await seedIndex(accessor, index, prefix)
  return true
}

/**
 * Refetch when the index holds no listing at all.
 *
 * Every reader here treats a missing listing as a real absence, which is
 * right against a *live* index and wrong against one that was never filled
 * or has been dropped, and invalidation drops rather than expires:
 * `invalidateDir` removes the directory's row outright, so the EXPIRED
 * probe each reader already runs never fires. An external change (a watch
 * event is the only thing that invalidates a mount with no write ops)
 * therefore left the whole mount answering ENOENT permanently, since the
 * seeded expiry is a year out.
 *
 * The root listing is what tells live from not, in one lookup and no
 * request: the tree is written whole, so while the index is live every
 * directory has a row and the mount root always does. One refill makes it
 * live again, so this cannot cost a fetch per miss, which is what kept the
 * readers from probing on absence in the first place.
 *
 * Not live always **refetches**, and never re-seeds the tree the mount was
 * built with. That tree is only true at build time: the first read of a
 * mount can come long after it, and reusing it then served an index built
 * from a repository five external writes ago. It is still what
 * `accessor.tree` starts as, so find and du have something to read before
 * any listing happens, and every refill reseats it.
 *
 * Mirrors Python's `ensure_live_index`.
 *
 * Args:
 *   accessor (GitHubAccessor): the mount's accessor.
 *   index (IndexCacheStore | undefined): the index to check and fill.
 *   prefix (string): the mount prefix the index keys are built against.
 *
 * Returns:
 *   boolean: whether the index was filled.
 */
export async function ensureLiveIndex(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<boolean> {
  if (index === undefined) return false
  // The liveness probe comes before anything on the accessor, so a live
  // index still answers every read without one.
  const root = rstripSlash(prefix) === '' ? '/' : rstripSlash(prefix)
  if ((await index.listDir(root)).status !== LookupStatus.NOT_FOUND) return false
  // A truncated tree is not the whole listing, so the invariant this rests
  // on does not hold and readdir's per-directory fallback owns the miss.
  if (accessor.truncated) return false
  return refillIndex(accessor, index, prefix)
}

/**
 * Look one path up in its parent directory's listing, with one request.
 *
 * Asks `git/trees/{ref}:{parent}`, whose rows are exactly the recursive
 * tree's for that directory: the same sha, and a symlink's own length rather
 * than its target's, which the contents API reports instead. The expression
 * is encoded as a single segment: Octokit reads an unencoded `:src` in a
 * path as a template placeholder and drops it, which asked for the root
 * tree instead, and a `/` in the parent or the ref would split the segment.
 *
 * Mirrors Python's `point_row`.
 *
 * Args:
 *   accessor (GitHubAccessor): the mount's accessor.
 *   rel (string): the path as the mount sees it.
 *
 * Returns:
 *   { entry, truncated } | null: the row (null when the listing has no such
 *   name) and whether GitHub truncated the listing, or null when the parent
 *   could not be seen and the whole tree has to answer.
 */
export async function pointRow(
  accessor: GitHubAccessor,
  rel: string,
): Promise<{ entry: TreeEntry | null; truncated: boolean } | null> {
  const trimmed = stripSlash(rel)
  const cut = trimmed.lastIndexOf('/')
  const parent = cut < 0 ? '' : trimmed.slice(0, cut)
  const name = cut < 0 ? trimmed : trimmed.slice(cut + 1)
  const expression = parent === '' ? accessor.ref : `${accessor.ref}:${parent}`
  let page: { tree: GitHubTreeItem[]; truncated: boolean }
  try {
    page = await fetchDirTreePage(
      accessor.transport,
      accessor.owner,
      accessor.repo,
      encodeURIComponent(expression),
    )
  } catch (err) {
    if (err instanceof GitHubApiError && DEFER_STATUSES.has(err.status)) return null
    throw err
  }
  const row = page.tree.find((item) => item.path === name)
  return { entry: row === undefined ? null : makeTreeEntry(row), truncated: page.truncated }
}
