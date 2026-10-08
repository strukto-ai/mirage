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

import { withIndexLock } from '@struktoai/mirage-core/cache/index/lock'
import { IndexEntry, type IndexSnapshot } from '@struktoai/mirage-core/cache/index/config'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { departed } from '@struktoai/mirage-core/cache/index/diff'
import { LookupStatus } from '@struktoai/mirage-core/cache/index/config'
import * as kp from '@struktoai/mirage-core/utils/key_prefix'
import { fnmatchcase } from '@struktoai/mirage-core/utils/fnmatch'
import type { HfHubAccessor, RowTables } from '../../accessor/hf_hub.ts'
import { HfHubError, apiUrl, hubGetResponse, hubPost, revSegment } from './client.ts'
import {
  GITATTRIBUTES,
  MAX_TREE_PAGES,
  TREE_PAGE_SIZE,
  TREE_PAGE_SIZE_EXPANDED,
} from './constants.ts'
import { headCommit, mountVersion } from './repo.ts'
import type { TreeEntry } from './tree_entry.ts'
import { isDirEntry } from './tree_entry.ts'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'

// `Link: <url>; rel="next"`, which is how the tree endpoint hands back its
// cursor. Bounded repetition on the URL body so a pathological header cannot
// backtrack quadratically.
const NEXT_LINK = /<([^>]{1,4096})>\s*;\s*rel="next"/

// The one refusal that means "nothing to list": the mount's key_prefix names
// no folder. Every other refusal (401 for a bad token or an unknown repo, 403
// for a gated one, 404 for a missing repo or revision) is an error, because
// this listing is seeded as the mount's whole index and an empty one would
// read every file as deleted.
const MISSING_SUBTREE = 'EntryNotFound'

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Turn one tree row into a TreeEntry. */
export function parseEntry(item: Record<string, unknown>): TreeEntry {
  const lfs = (item.lfs ?? {}) as Record<string, unknown>
  const commit = (item.lastCommit ?? {}) as Record<string, unknown>
  const size = item.size
  return {
    path: str(item.path),
    type: str(item.type, 'file'),
    oid: str(item.oid),
    size: typeof size === 'number' ? size : undefined,
    lastModified: str(commit.date),
    lastCommit: str(commit.id),
    lfsOid: str(lfs.oid),
    xetHash: str(item.xetHash),
  }
}

/**
 * The next page's URL, read out of the Link header.
 *
 * The Hub pages the tree with an opaque cursor rather than a page number, so
 * the only way to ask for page two is to follow the URL it handed back.
 */
export function nextCursor(headers: Record<string, string>): string {
  const link = headers.link ?? ''
  const match = link === '' ? null : NEXT_LINK.exec(link)
  return match === null ? '' : (match[1] ?? '')
}

/** Query for one tree page. */
export function pageParams(expand: boolean): Record<string, string> {
  return {
    recursive: 'true',
    expand: expand ? 'true' : 'false',
    limit: String(expand ? TREE_PAGE_SIZE_EXPANDED : TREE_PAGE_SIZE),
  }
}

/**
 * The tree endpoint for a revision and the mount's key prefix: the mount's
 * own revision unless one is given. A refill passes the commit its head
 * resolved to, so the rows it stores are the ones that version names.
 */
export function treeUrl(accessor: HfHubAccessor, revision?: string): string {
  let suffix = `/tree/${revSegment(revision ?? accessor.revision)}`
  // The prefix is normalized with a trailing slash, which the tree endpoint
  // reads as a path segment of its own.
  const stem = stripSlash(accessor.keyPrefix)
  if (stem !== '') suffix += `/${stem}`
  return apiUrl(accessor.endpoint, accessor.repoType, accessor.repoId, suffix)
}

/**
 * The paths-info endpoint for the mount's revision.
 *
 * Unlike the tree endpoint the key prefix does not ride the route: the segment
 * after `paths-info` is the whole revision, so the prefix goes into each
 * requested path instead.
 */
export function pathsInfoUrl(accessor: HfHubAccessor): string {
  return apiUrl(
    accessor.endpoint,
    accessor.repoType,
    accessor.repoId,
    `/paths-info/${revSegment(accessor.revision)}`,
  )
}

/**
 * The listing row for one mount-relative path, in one request.
 *
 * The row is folded by `collect`, the same as a tree page, so it keys and
 * carries the same oid a whole-tree walk would. Only a row naming exactly the
 * asked path counts: an answer about some other path is not an answer about
 * this one, and must not read as its absence.
 */
export async function fetchPath(
  accessor: HfHubAccessor,
  rel: string,
): Promise<Map<string, TreeEntry>> {
  const asked = accessor.repoPath(rel)
  const answer = await hubPost(
    accessor.token,
    pathsInfoUrl(accessor),
    { paths: [asked], expand: accessor.expandCommits === true },
    undefined,
    accessor.timeoutMs,
  )
  // Only an empty list says the path is missing; an answer of any other shape
  // is one the client cannot read, not an absence.
  if (!Array.isArray(answer)) {
    throw new HfHubError(`paths-info answered no list for ${asked}`, 0, 'InvalidResponse')
  }
  const rows: unknown[] = answer
  const matching = rows.filter(
    (row) =>
      typeof row === 'object' && row !== null && (row as Record<string, unknown>).path === asked,
  )
  if (rows.length > 0 && matching.length === 0) {
    throw new HfHubError(`paths-info answered no row for ${asked}`, 0, 'PathMismatch')
  }
  const into = new Map<string, TreeEntry>()
  collect(matching, accessor.keyPrefix, into)
  return into
}

/** Fold one page of tree rows into the mount's listing. */
export function collect(rows: unknown, prefix: string, into: Map<string, TreeEntry>): void {
  const stem = rstripSlash(prefix)
  for (const item of Array.isArray(rows) ? rows : []) {
    if (typeof item !== 'object' || item === null) continue
    const entry = parseEntry(item as Record<string, unknown>)
    if (entry.path === '') continue
    // A prefix mount lists its own subtree, and the row naming that directory
    // is not a child of anything. `kp.strip` cannot drop it on its own: the
    // prefix is normalized with a trailing slash, so the bare directory path
    // does not start with it and comes back unchanged, which would key the
    // prefix itself under the mount root.
    if (stem !== '' && entry.path === stem) continue
    const rel = prefix === '' ? entry.path : kp.strip(prefix, entry.path)
    if (rel !== '') into.set(rel, entry)
  }
}

/** Follow the cursor from one page to the last, folding as it goes. */
/**
 * The refusal for a listing the page ceiling cut short.
 *
 * Thrown rather than returned because this listing is not a cache in front
 * of the Hub, it is seeded as the mount's whole index: a partial one reads
 * as a complete one, so every file past the ceiling becomes a confident
 * false absence and `hf download` silently omits it. An error the caller
 * can see is the lesser failure.
 */
export function truncated(repoId: string): HfHubError {
  return new HfHubError(`hf: ${repoId}: listing exceeds ${String(MAX_TREE_PAGES)} pages`, 0)
}

export async function walkPages(
  accessor: HfHubAccessor,
  url: string,
  params: Record<string, string> | undefined,
  into: Map<string, TreeEntry>,
  limit: number = MAX_TREE_PAGES,
): Promise<string> {
  let target = url
  let query = params
  for (let page = 0; page < limit; page += 1) {
    let response
    try {
      response = await hubGetResponse(accessor.token, target, query, accessor.timeoutMs)
    } catch (err) {
      // Only a request carrying first-page params can learn that the subtree
      // is missing; a cursor page failing means the listing broke part way,
      // and keeping what came before would pass a partial tree off as whole.
      if (
        query !== undefined &&
        err instanceof HfHubError &&
        err.status === 404 &&
        err.errorCode === MISSING_SUBTREE
      ) {
        return ''
      }
      throw err
    }
    collect(response.data, accessor.keyPrefix, into)
    target = nextCursor(response.headers)
    if (target === '') return ''
    // The cursor URL carries the whole query already; sending the first
    // page's params alongside it duplicates them.
    query = undefined
  }
  return target
}

/**
 * Every path under the mount's subtree, in one paged walk.
 *
 * `recursive=true` returns the whole subtree. Size, oid and the LFS and Xet
 * hashes all ride the bare row, so the only thing `expand=true` adds is the
 * commit that last touched each path -- a Hub file's only mtime -- and it
 * costs a twentyfold drop in page size (1000 rows to 50, with any explicit
 * limit above 100 refused).
 *
 * Which one is used is the mount's call, and its default is neither: ask for
 * one expanded page, and if the whole repository fit in it, that page is the
 * answer and the mtimes came free. Only a repository too big for one page
 * falls back to the bare walk, and pays one wasted request for the attempt.
 */
export async function fetchTree(
  accessor: HfHubAccessor,
  revision?: string,
): Promise<Map<string, TreeEntry>> {
  const url = treeUrl(accessor, revision)
  const expand = accessor.expandCommits
  let result = new Map<string, TreeEntry>()
  if (expand !== false) {
    // One page, and no cursor followed: whether a second page exists is
    // exactly the question being asked.
    const left = await walkPages(accessor, url, pageParams(true), result, 1)
    if (left === '') return result
    if (expand === true) {
      if ((await walkPages(accessor, left, undefined, result)) !== '') {
        throw truncated(accessor.repoId)
      }
      return result
    }
    // Too big to expand. The bare walk restarts from the first page rather
    // than continuing from this cursor, because the cursor belongs to the
    // expanded query and its rows carry a different page size.
    result = new Map<string, TreeEntry>()
  }
  if ((await walkPages(accessor, url, pageParams(false), result)) !== '') {
    throw truncated(accessor.repoId)
  }
  return result
}

/**
 * Bucket a Hub tree by parent directory.
 *
 * Keyed by mount-absolute path, the way every other backend keys its index,
 * so the shared cache machinery can spell an eviction without knowing which
 * backend it is talking to. The tree itself stays mount-relative; `prefix` is
 * what lifts it. This is the one shape both storage paths are built from, so
 * the seeded index and the derived tables cannot disagree.
 */
export function indexDirs(
  tree: Map<string, TreeEntry>,
  prefix: string,
): Map<string, [string, IndexEntry][]> {
  const stem = rstripSlash(prefix)
  const dirs = new Map<string, [string, IndexEntry][]>()
  // The repository root always exists, so it gets a row even when the tree is
  // empty. Without it an empty repo is byte for byte a dropped index and every
  // read would refetch.
  dirs.set(stem === '' ? '/' : stem, [])
  for (const [path, entry] of tree) {
    const cut = path.lastIndexOf('/')
    const parent = cut === -1 ? (stem === '' ? '/' : stem) : `${stem}/${path.slice(0, cut)}`
    const name = cut === -1 ? path : path.slice(cut + 1)
    const extra: Record<string, unknown> = { oid: entry.oid }
    if (entry.lastCommit !== '') extra.last_commit = entry.lastCommit
    if (entry.lfsOid !== '') extra.lfs_oid = entry.lfsOid
    if (entry.xetHash !== '') extra.xet_hash = entry.xetHash
    const row = new IndexEntry({
      id: entry.oid,
      name,
      resourceType: isDirEntry(entry) ? 'folder' : 'file',
      remoteTime: entry.lastModified,
      size: isDirEntry(entry) ? null : (entry.size ?? null),
      extra,
    })
    const bucket = dirs.get(parent)
    if (bucket === undefined) dirs.set(parent, [[name, row]])
    else bucket.push([name, row])
    // A tree row names its parent directories implicitly. The Hub's recursive
    // listing does emit a row per directory, but a page boundary can deliver a
    // child before its parent, so the parent's bucket is created here too and
    // merged with its own row's.
    let head = cut === -1 ? '' : path.slice(0, cut)
    while (head !== '') {
      const key = `${stem}/${head}`
      if (!dirs.has(key)) dirs.set(key, [])
      const up = head.lastIndexOf('/')
      head = up === -1 ? '' : head.slice(0, up)
    }
  }
  listImplied(dirs, stem === '' ? '/' : stem)
  return dirs
}

/**
 * Give every directory the tree only implies a row in its parent.
 *
 * A directory seen only as some path's parent has a listing of its own but no
 * row naming it, so its parent would not list it and a stat of it would find
 * no entry. Every listed path must have a row: a lookup that finds a listed
 * name with none takes it as evicted and refills.
 */
function listImplied(dirs: Map<string, [string, IndexEntry][]>, root: string): void {
  const named = new Set<string>()
  for (const [parent, rows] of dirs) {
    const base = rstripSlash(parent)
    for (const [name] of rows) named.add(`${base}/${name}`)
  }
  for (const key of [...dirs.keys()].sort(compareCodePoints)) {
    if (key === root || named.has(key)) continue
    const cut = key.lastIndexOf('/')
    const name = key.slice(cut + 1)
    const parent = dirs.get(key.slice(0, cut) || '/')
    parent?.push([name, new IndexEntry({ id: '', name, resourceType: 'folder' })])
  }
}

/** The entry and children tables a no-index mount reads, from the buckets. */
export function indexRows(tree: Map<string, TreeEntry>, prefix: string): RowTables {
  return rowsOf(indexDirs(tree, prefix))
}

/** The entry and child tables of directories `indexDirs` built. */
function rowsOf(dirs: ReadonlyMap<string, readonly [string, IndexEntry][]>): RowTables {
  const entries = new Map<string, IndexEntry>()
  const children = new Map<string, string[]>()
  for (const [parent, rows] of dirs) {
    const base = rstripSlash(parent)
    for (const [name, row] of rows) entries.set(`${base}/${name}`, row)
    children.set(parent, rows.map(([name]) => `${base}/${name}`).sort(compareCodePoints))
  }
  return { entries, children }
}

/**
 * Write one fetched tree into `index` under `prefix`, and return the rows
 * written, built from the same walk.
 *
 * The tree is the caller's own fetch, never `accessor.tree` re-read after an
 * await: the watcher replaces that with no lock, and its rows may be at
 * another head than the `version` stamped here.
 *
 * One `setDir` per directory, the way the shared store spells a whole
 * listing; the year-long expiry is what makes the index the listing rather
 * than a cache in front of one.
 */
export async function seedIndex(
  tree: Map<string, TreeEntry>,
  index: IndexCacheStore,
  prefix: string,
  version: string | null = null,
): Promise<RowTables> {
  const dirs = indexDirs(tree, prefix)
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  // Every folder carries the head the tree was walked at, not just the root:
  // a nested listing is served on that version as much as the root is.
  await Promise.all(
    [...dirs].map(([parent, rows]) => index.setDir(parent, rows, expires, { version })),
  )
  return rowsOf(dirs)
}

/**
 * Refetch the tree and re-seed the index from it.
 *
 * The mount fetches the whole tree once and seeds the index with it, so the
 * index *is* the listing rather than a cache in front of one. That makes a
 * cleared or expired index indistinguishable from an empty repository, which
 * is why dropping the index has to mean "refetch".
 */
export async function refillIndex(
  accessor: HfHubAccessor,
  index: IndexCacheStore,
  prefix: string,
): Promise<boolean> {
  await refillSnapshot(accessor, index, prefix)
  return true
}

/**
 * `refillIndex`, returning the rows it wrote: a reader answers from them
 * when its re-read of the store has already expired. Mirrors Python's
 * `refill_snapshot`.
 */
export async function refillSnapshot(
  accessor: HfHubAccessor,
  index: IndexCacheStore,
  prefix: string,
): Promise<IndexSnapshot> {
  const previous = accessor.treeLoaded ? new Map(accessor.tree) : null
  // The head first, and the tree walked at the commit it names: the version
  // stored is then the one these rows are at, never a later one a commit
  // landing between the two requests would give. The head failing is the
  // refill failing. '' (a Hub that names none) walks the branch and stores
  // no version. Mirrors Python's `refill_snapshot`.
  const head = (await headCommit(accessor)) || null
  const tree = await fetchTree(accessor, head ?? undefined)
  accessor.tree = tree
  accessor.treeLoaded = true
  accessor.rowsCache = null
  accessor.refills += 1
  // Refilling replaces the snapshot; merging would retain deleted paths.
  await index.invalidatePrefix(rstripSlash(prefix) || '/')
  const snapshot = await seedIndex(tree, index, prefix, mountVersion(head, accessor.keyPrefix))
  if (previous !== null) await index.reportGone(departed(previous, tree.keys(), prefix, isDirEntry))
  return snapshot
}

/**
 * Refetch when the root listing is missing or expired, returning the rows of
 * the refill it made.
 *
 * Every reader treats a missing listing as a real absence, which is right
 * against a *live* index and wrong against one that was never filled or has
 * been dropped. The root listing is what tells the two apart, in one lookup
 * and no request: the tree is written whole, so while the index is live the
 * mount root always has a row. Mirrors Python's `ensure_live_snapshot`.
 */
export async function ensureLiveSnapshot(
  accessor: HfHubAccessor,
  index: IndexCacheStore,
  prefix: string,
): Promise<IndexSnapshot | null> {
  const root = rstripSlash(prefix)
  const listing = await index.listDir(root === '' ? '/' : root)
  if (listing.status !== LookupStatus.NOT_FOUND && listing.status !== LookupStatus.EXPIRED)
    return null
  return refillSnapshot(accessor, index, prefix)
}

/**
 * Fetch the tree if this mount has not got one yet.
 *
 * Hydration is tracked by `treeLoaded`, never by whether the tree holds
 * anything: an empty repository hydrates to an empty map, and reading that as
 * "not hydrated" refetches it on every call forever.
 */
export async function ensureTree(
  accessor: HfHubAccessor,
  index?: IndexCacheStore,
  prefix = '',
): Promise<void> {
  if (accessor.treeLoaded) return
  if (accessor.hydrating !== null) {
    await accessor.hydrating
    return
  }
  const run = (async () => {
    if (index !== undefined) {
      await withIndexLock(index, rstripSlash(prefix) || '/', async () => {
        if (!accessor.treeLoaded) await refillIndex(accessor, index, prefix)
      })
      return
    }
    accessor.tree = await fetchTree(accessor)
    accessor.treeLoaded = true
    accessor.rowsCache = null
  })()
  accessor.hydrating = run
  try {
    await run
  } finally {
    accessor.hydrating = null
  }
}

/**
 * The index tables built straight from the accessor's tree.
 *
 * What a mount with no index wired reads instead. Every reader has an index
 * inside a workspace, but a backend constructed on its own has NULL_INDEX,
 * whose every lookup is a miss -- so without this, readdir answered ENOENT for
 * a repository it could list perfectly well. Built by the same `indexRows` the
 * seeded path uses, so the two cannot disagree.
 */
export async function localRows(accessor: HfHubAccessor, prefix: string): Promise<RowTables> {
  await ensureTree(accessor)
  const cached = accessor.rowsCache
  if (cached !== null && cached.prefix === prefix) return cached.rows
  const rows = indexRows(accessor.tree, prefix)
  accessor.rowsCache = { prefix, rows }
  return rows
}

/** The file paths of a tree, sorted, its directories left out. */
export function repoFiles(tree: Map<string, TreeEntry>): string[] {
  return [...tree.entries()]
    .filter(([, entry]) => !isDirEntry(entry))
    .map(([path]) => path)
    .sort(compareCodePoints)
}

/**
 * Keep the repo paths an allowlist and a denylist of upstream patterns admit.
 *
 * huggingface_hub's `filter_repo_objects`, the one rule its `--include`,
 * `--exclude` and `--delete` share: a pattern is a CPython fnmatch glob over
 * the whole path, so `*` crosses a `/` (`data/*.json` holds
 * `data/sub/x.json`), `[^a]` is `^` or `a` rather than bash's negation, and a
 * pattern ending in `/` names a folder and matches everything under it. An
 * empty list puts no constraint on the paths.
 */
export function filterRepoPaths(
  paths: readonly string[],
  include: readonly string[],
  exclude: readonly string[] = [],
): string[] {
  const allow = include.map(folderWildcard)
  const deny = exclude.map(folderWildcard)
  return paths.filter(
    (path) =>
      (allow.length === 0 || allow.some((pattern) => fnmatchcase(path, pattern))) &&
      !deny.some((pattern) => fnmatchcase(path, pattern)),
  )
}

function folderWildcard(pattern: string): string {
  return pattern.endsWith('/') ? `${pattern}*` : pattern
}

/**
 * The repo files a set of deletion patterns names, as upstream computes them.
 *
 * huggingface_hub's `_prepare_folder_deletions`: the patterns match the
 * repository's listing, not paths of their own, so `**` or `*.txt` deletes the
 * files it matches and a pattern matching nothing deletes nothing. They match
 * relative to `pathInRepo`, the folder an upload lands in (normalized: no
 * leading or trailing slash, '' for the root), and `.gitattributes` always
 * survives, because the Hub needs it to serve the repo.
 */
export function deletionsFor(
  files: readonly string[],
  patterns: readonly string[],
  pathInRepo = '',
): string[] {
  if (patterns.length === 0) return []
  const folder = pathInRepo === '' ? '' : `${pathInRepo}/`
  const relative = new Map<string, string>()
  for (const file of files) {
    if (file.startsWith(folder)) relative.set(file.slice(folder.length), file)
  }
  return filterRepoPaths([...relative.keys()], patterns)
    .map((rel) => relative.get(rel) ?? rel)
    .filter((file) => file !== GITATTRIBUTES)
}
