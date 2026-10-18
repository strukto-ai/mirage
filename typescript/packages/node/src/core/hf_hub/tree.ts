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

// Path filtering follows huggingface_hub 1.16.4 (Apache-2.0; see
// licenses/third_party/huggingface_hub.txt).

import * as kp from '@struktoai/mirage-core/utils/key_prefix'
import { fnmatchcase } from '@struktoai/mirage-core/utils/fnmatch'
import { enoent, enotdir } from '@struktoai/mirage-core/errors/fs'
import { DirListing, FileStat, FileType } from '@struktoai/mirage-core/types'
import { contentTypeForPath } from '@struktoai/mirage-core/utils/filetype'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { HfHubError, apiUrl, hubGetResponse, hubPost, revSegment } from './client.ts'
import {
  GITATTRIBUTES,
  MAX_TREE_PAGES,
  TREE_PAGE_SIZE,
  TREE_PAGE_SIZE_EXPANDED,
} from './constants.ts'
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
  const answer = await hubPost(accessor.account, pathsInfoUrl(accessor), {
    paths: [asked],
    expand: accessor.expandCommits === true,
  })
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
      response = await hubGetResponse(accessor.account, target, query)
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
 * The row for one tree row, the same from every route.
 *
 * Size is the row's, which is the Hub's *content* length even for an LFS
 * file; the 135-byte pointer never reaches here. `modified` is null unless the
 * mount asked for commit expansion: a Hub file's only mtime is the commit that
 * last touched it. git is content-addressed, so the object id is the file's
 * fingerprint. Mirrors Python's `row_of`.
 */
export function rowOf(entry: TreeEntry, name: string): FileStat {
  const modified = entry.lastModified === '' ? null : entry.lastModified
  if (isDirEntry(entry)) return new FileStat({ name, type: FileType.DIRECTORY, modified })
  const extra: Record<string, unknown> = { oid: entry.oid }
  if (entry.lastCommit !== '') extra.last_commit = entry.lastCommit
  if (entry.lfsOid !== '') extra.lfs_oid = entry.lfsOid
  if (entry.xetHash !== '') extra.xet_hash = entry.xetHash
  return new FileStat({
    name,
    size: entry.size ?? null,
    modified,
    type: FileType.FILE,
    content: contentTypeForPath(name),
    fingerprint: entry.oid === '' ? null : entry.oid,
    extra,
  })
}

/**
 * Each folder's rows, keyed by its mount-relative path ('' the root).
 *
 * The mount root always has a listing, even when the tree is empty, so an
 * empty repository lists as empty rather than missing. A tree row names its
 * parent folders implicitly, and a page boundary can deliver a child before
 * its parent's own row, so every folder above a path gets a listing and a row
 * in its parent; the folder's own row, when the tree has one, takes that
 * place. Mirrors Python's `tree_rows`.
 */
export function treeRows(tree: ReadonlyMap<string, TreeEntry>): Map<string, FileStat[]> {
  const folders = new Map<string, Map<string, FileStat>>([['', new Map()]])
  const rowsAt = (folder: string): Map<string, FileStat> => {
    let rows = folders.get(folder)
    if (rows === undefined) {
      rows = new Map()
      folders.set(folder, rows)
    }
    return rows
  }
  for (const [path, entry] of tree) {
    const cut = path.lastIndexOf('/')
    let parent = cut === -1 ? '' : path.slice(0, cut)
    const name = path.slice(cut + 1)
    rowsAt(parent).set(name, rowOf(entry, name))
    if (isDirEntry(entry)) rowsAt(path)
    while (parent !== '') {
      const up = parent.lastIndexOf('/')
      const above = up === -1 ? '' : parent.slice(0, up)
      const folder = parent.slice(up + 1)
      const rows = rowsAt(above)
      if (!rows.has(folder))
        rows.set(folder, new FileStat({ name: folder, type: FileType.DIRECTORY }))
      parent = above
    }
  }
  return new Map(
    [...folders].map(([folder, rows]) => [
      folder,
      [...rows.values()].sort((a, b) => compareCodePoints(a.name, b.name)),
    ]),
  )
}

/**
 * The listing of the folder `rel` out of the whole tree, with every folder
 * below it as seeds, all at `version`. Mirrors Python's `tree_listing`.
 *
 * Throws:
 *   NotADirectoryError: a file is at `rel` or above it.
 *   FileNotFoundError: nothing is.
 */
export function treeListing(
  tree: ReadonlyMap<string, TreeEntry>,
  rel: string,
  version: string | null,
  virtual: string,
): DirListing {
  const folders = treeRows(tree)
  const entries = folders.get(rel)
  if (entries === undefined) {
    const parts = rel.split('/')
    for (let depth = parts.length; depth > 0; depth--) {
      const found = tree.get(parts.slice(0, depth).join('/'))
      if (found !== undefined && !isDirEntry(found)) throw enotdir(virtual)
    }
    throw enoent(virtual)
  }
  const lead = rel === '' ? '' : `${rel}/`
  const seeds = new Map<string, FileStat[]>()
  for (const [folder, rows] of folders) {
    if (folder !== rel && folder.startsWith(lead)) seeds.set(folder.slice(lead.length), rows)
  }
  return new DirListing({ entries, seeds, version })
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
