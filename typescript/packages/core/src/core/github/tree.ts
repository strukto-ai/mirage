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
import { GitHubApiError, type GitHubTransport } from './client.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { LookupStatus } from '../../cache/index/config.ts'
import type { IndexEntry, IndexSnapshot, ListResult } from '../../cache/index/config.ts'
import { departed } from '../../cache/index/diff.ts'
import { withIndexLock } from '../../cache/index/lock.ts'
import type { GitHubTreeItem } from './client.ts'
import { indexEntryFromTree, makeTreeEntry, type TreeEntry } from './tree_entry.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { DEFER_STATUSES } from './constants.ts'

export function buildTreeMap(tree: GitHubTreeItem[]): Record<string, TreeEntry> {
  const map: Record<string, TreeEntry> = {}
  for (const item of tree) map[item.path] = makeTreeEntry(item)
  return map
}

export function populateIndex(
  index: IndexCacheStore,
  tree: Record<string, TreeEntry>,
  prefix: string,
  expiresAt?: Date,
  version: string | null = null,
): Promise<IndexSnapshot> {
  // Keyed by mount-absolute path, the way every other backend keys its
  // index, so the shared cache machinery can spell an eviction without
  // knowing which backend it is talking to. The tree itself stays
  // repo-relative; `prefix` is what lifts it.
  const stem = rstripSlash(prefix)
  const dirs = new Map<string, [string, IndexEntry][]>()
  // The repository root always exists, so it gets a row even when the tree
  // is empty. Without it an empty repository is byte for byte a dropped
  // index, and `ensureLiveSnapshot` would refetch on every read of one.
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
  // Seeded, not written per directory: a truncated tree names only some
  // children, and a complete write would evict the rest.
  const snapshot = snapshotOf(dirs, version)
  index.seed(
    snapshot.entries,
    snapshot.children,
    expiresAt ?? new Date(Date.now() + index.ttl * 1000),
    version,
  )
  return Promise.resolve(snapshot)
}

/** The rows `populateIndex` wrote, keyed the way the store keys them. */
function snapshotOf(
  dirs: ReadonlyMap<string, readonly [string, IndexEntry][]>,
  version: string | null,
): IndexSnapshot {
  const entries = new Map<string, IndexEntry>()
  const children = new Map<string, string[]>()
  for (const [parent, rows] of dirs) {
    const stem = parent === '/' ? '/' : `${parent}/`
    children.set(
      parent,
      rows.map(([name, entry]) => {
        entries.set(stem + name, entry)
        return stem + name
      }),
    )
  }
  return { entries, children, version }
}

/**
 * Write the accessor's tree into `index` under `prefix`, every listing
 * stamped with the head the tree was fetched at.
 *
 * Mirrors Python's `seed_index`.
 */
async function seedIndex(
  accessor: GitHubAccessor,
  index: IndexCacheStore,
  prefix: string,
): Promise<IndexSnapshot> {
  // A truncated response cannot establish that any listing is complete,
  // including an apparently empty directory. Readdir must fill it first.
  return populateIndex(
    index,
    accessor.tree,
    prefix,
    accessor.truncated ? new Date(0) : undefined,
    accessor.truncated ? null : accessor.treeVersion,
  )
}

/**
 * Replace the accessor's tree with one response, and its version. A
 * truncated tree is not the whole listing at that head, so it is versioned
 * by nothing.
 */
export function reseatTree(
  accessor: GitHubAccessor,
  tree: GitHubTreeItem[],
  truncated: boolean,
  head: string | null,
): Record<string, TreeEntry> {
  const current = buildTreeMap(tree)
  accessor.truncated = truncated
  accessor.tree = current
  accessor.treeVersion = truncated ? null : head
  return current
}

/**
 * Refetch the recursive tree, re-seed the index from it, return its rows.
 *
 * The mount fetches the whole tree once and seeds the index with it, so
 * the index is the listing rather than a cache in front of one. That makes
 * a cleared or expired index indistinguishable from an empty repository --
 * `ls` reported the mount root missing after an invalidation, and reported
 * nothing at all once the day-long TTL lapsed. This is the refill that
 * makes dropping the index mean "refetch", which is what invalidating it
 * was always supposed to mean.
 *
 * The rows are returned so a reader can answer from them when its re-read
 * of the store has already expired (it waited on the mutation lock past
 * the mount's ttl).
 *
 * Mirrors Python's `refill_snapshot`.
 *
 * Args:
 *   accessor (GitHubAccessor): the mount's accessor, holding the transport
 *     and the ref to refetch.
 *   index (IndexCacheStore | undefined): the index to re-seed.
 *
 * Returns:
 *   IndexSnapshot | null: the rows seeded; null when there is no index to
 *   seed, so a caller does not retry a lookup that cannot change.
 */
export async function refillSnapshot(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<IndexSnapshot | null> {
  if (index === undefined) return null
  // Only a complete tree can say what is gone; a first fetch compares
  // against the empty tree the accessor starts with, and a truncated one
  // names only some paths.
  const previous = accessor.truncated ? null : { ...accessor.tree }
  const { tree, truncated, sha } = await fetchTree(
    accessor.transport,
    accessor.owner,
    accessor.repo,
    accessor.ref,
  )
  const current = reseatTree(accessor, tree, truncated, sha)
  // A refill replaces this mount's snapshot, including paths now absent.
  await index.invalidatePrefix(rstripSlash(prefix) || '/')
  const snapshot = await seedIndex(accessor, index, prefix)
  if (previous !== null && !truncated) {
    await index.reportGone(
      departed(Object.entries(previous), Object.keys(current), prefix, isFolder),
    )
  }
  return snapshot
}

function isFolder(entry: TreeEntry): boolean {
  return entry.type === 'tree'
}

/**
 * Refetch when the index holds no live root listing.
 *
 * Every reader here treats a missing listing as a real absence, which is
 * right against a *live* index and wrong against one that was never filled
 * or has been dropped, and invalidation drops rather than expires:
 * `invalidateDir` removes the directory's row outright, so the EXPIRED
 * probe each reader already runs never fires. An expired root counts as not
 * live too: the tree is written whole, so it means the whole tree aged out,
 * and find, du and grep read that tree rather than the listing.
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
 * Mirrors Python's `ensure_live_snapshot`.
 *
 * Args:
 *   accessor (GitHubAccessor): the mount's accessor.
 *   index (IndexCacheStore | undefined): the index to check and fill.
 *   prefix (string): the mount prefix the index keys are built against.
 *
 * Returns:
 *   IndexSnapshot | null: the refill's rows, or null when none was needed
 *   or possible.
 */
export async function ensureLiveSnapshot(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<IndexSnapshot | null> {
  if (index === undefined) return null
  // The liveness probe comes before anything on the accessor, so a live
  // index still answers every read without one.
  const root = rstripSlash(prefix) === '' ? '/' : rstripSlash(prefix)
  return refillUnlessLive(accessor, index, prefix, await index.listDir(root))
}

/**
 * `ensureLiveSnapshot` for a root listing the caller already read through the
 * gate, under the index lock.
 *
 * Mirrors Python's `_refill_unless_live`.
 */
async function refillUnlessLive(
  accessor: GitHubAccessor,
  index: IndexCacheStore,
  prefix: string,
  root: ListResult,
): Promise<IndexSnapshot | null> {
  if (root.status !== LookupStatus.NOT_FOUND && root.status !== LookupStatus.EXPIRED) return null
  // A truncated tree is not the whole listing, so the invariant this rests
  // on does not hold and readdir's per-directory fallback owns the miss.
  if (accessor.truncated) return null
  return refillSnapshot(accessor, index, prefix)
}

/**
 * Probe before walking accessor.tree. Call outside any non-reentrant index
 * lock.
 *
 * A live index can still be newer than the tree: another mount sharing the
 * index refills it, which moves its root listing to a newer head while this
 * accessor holds the tree it fetched earlier. Listings answer from the index
 * and never notice; a walker of `accessor.tree` would read the old tree, so
 * it refills when the root listing's version differs from the tree's. The
 * root listing is the one the liveness probe just read through the gate,
 * under the same lock, so its version is the one the gate approved and the
 * index is not read again. A truncated tree keeps readdir's per-directory
 * fallback instead.
 */
export async function ensureTree(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<void> {
  if (index === undefined) return
  const root = rstripSlash(prefix) === '' ? '/' : rstripSlash(prefix)
  await withIndexLock(index, root, async () => {
    const listing = await index.listDir(root)
    const refilled = await refillUnlessLive(accessor, index, prefix, listing)
    if (refilled !== null || accessor.truncated) return
    if (listing.entries == null || (listing.version ?? null) === accessor.treeVersion) return
    await refillSnapshot(accessor, index, prefix)
  })
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
    page = await fetchDirPage(accessor.transport, accessor.owner, accessor.repo, expression)
  } catch (err) {
    if (err instanceof GitHubApiError && DEFER_STATUSES.has(err.status)) return null
    throw err
  }
  const row = page.tree.find((item) => item.path === name)
  return { entry: row === undefined ? null : makeTreeEntry(row), truncated: page.truncated }
}

/**
 * Fetch the recursive tree of `ref`, and the head it answered at.
 *
 * A tree asked by a branch, a tag or a commit sha names the commit it
 * resolved to as its top-level `sha` (measured against GitHub, 2026-09-30),
 * so the rows and the version come from one response.
 *
 * Returns:
 *   { tree, truncated, sha }: the rows, GitHub's `truncated` flag, and the
 *   head commit sha, or null when the response names none.
 */
export async function fetchTree(
  transport: GitHubTransport,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ tree: GitHubTreeItem[]; truncated: boolean; sha: string | null }> {
  const data = (await transport.get(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`,
    {
      recursive: '1',
    },
  )) as { tree?: GitHubTreeItem[]; truncated?: boolean; sha?: unknown }
  return {
    tree: dropSubmodules(data.tree ?? []),
    truncated: data.truncated === true,
    sha: headOf(data),
  }
}

/**
 * Ask which commit `ref` resolves to, with one shallow request: the shallow
 * tree of the root answers the same top-level `sha` as the recursive one, at
 * a fraction of the size.
 *
 * Returns:
 *   string | null: the head commit sha, or null when the response names none.
 */
export async function fetchHead(
  transport: GitHubTransport,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  const data = (await transport.get(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`,
  )) as { sha?: unknown }
  return headOf(data)
}

export function headOf(data: { sha?: unknown }): string | null {
  return typeof data.sha === 'string' && data.sha !== '' ? data.sha : null
}

// Submodule gitlinks (type "commit") have no size and no blob to read;
// exclude them from the tree entirely.
export function dropSubmodules(tree: GitHubTreeItem[]): GitHubTreeItem[] {
  return tree.filter((item) => item.type !== 'commit')
}

/**
 * Fetch one directory's tree (non-recursive), and whether GitHub cut it.
 *
 * Args:
 *   treeSha (string): a raw tree sha, ref, or `{ref}:{dir}` expression.
 *
 * Returns:
 *   { tree, truncated }: the rows, submodule gitlinks excluded, and
 *   GitHub's `truncated` flag.
 *
 * Throws:
 *   GitHubApiError: the response carries no tree, which must not read as
 *   an empty directory.
 */
export async function fetchDirPage(
  transport: GitHubTransport,
  owner: string,
  repo: string,
  treeSha: string,
): Promise<{ tree: GitHubTreeItem[]; truncated: boolean }> {
  const data = (await transport.get(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(treeSha)}`,
  )) as {
    tree?: GitHubTreeItem[]
    truncated?: boolean
  }
  if (data.tree === undefined) {
    throw new GitHubApiError(
      `GitHub tree response for ${owner}/${repo} ${treeSha} carries no tree`,
      0,
    )
  }
  return { tree: dropSubmodules(data.tree), truncated: data.truncated === true }
}

/**
 * Fetch a single directory's whole tree (non-recursive).
 *
 * Used as fallback when the recursive tree was truncated, where the listing
 * is cached as complete, so a directory GitHub cut short is refused rather
 * than returned: a name past the cut would otherwise read as absent, which a
 * `read: fresh` probe or a drift check takes as gone.
 *
 * Mirrors Python's `fetch_dir_tree`.
 *
 * Throws:
 *   GitHubApiError: GitHub truncated the listing, or sent no tree.
 */
export async function fetchDirTree(
  transport: GitHubTransport,
  owner: string,
  repo: string,
  treeSha: string,
): Promise<GitHubTreeItem[]> {
  const page = await fetchDirPage(transport, owner, repo, treeSha)
  if (page.truncated) {
    throw new GitHubApiError(`GitHub truncated the tree listing of ${owner}/${repo} ${treeSha}`, 0)
  }
  return page.tree
}
