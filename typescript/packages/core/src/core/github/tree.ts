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
import type { GitHubTreeItem } from './client.ts'
import { makeTreeEntry, type TreeEntry } from './tree_entry.ts'
import { stripSlash } from '../../utils/slash.ts'
import { DEFER_STATUSES } from './constants.ts'
import { DirListing, FileStat, FileType } from '../../types.ts'
import { enoent, enotdir } from '../../errors/fs.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { compareCodePoints } from '../../utils/sort.ts'

export function buildTreeMap(tree: GitHubTreeItem[]): Record<string, TreeEntry> {
  const map: Record<string, TreeEntry> = {}
  for (const item of tree) map[item.path] = makeTreeEntry(item)
  return map
}

/**
 * The row for one tree row, the same from every route: a file's carries its
 * blob sha as its fingerprint, and every row its sha.
 *
 * Mirrors Python's `row_of`.
 */
export function rowOf(entry: TreeEntry, name: string): FileStat {
  if (entry.type === 'tree') {
    return new FileStat({ name, type: FileType.DIRECTORY, extra: { sha: entry.sha } })
  }
  return new FileStat({
    name,
    size: entry.size,
    type: FileType.FILE,
    content: contentTypeForPath(name),
    fingerprint: entry.sha,
    extra: { sha: entry.sha },
  })
}

/**
 * Each folder's rows, keyed by its repo-relative path ('' the root). The
 * repository root always has a listing, even when the tree is empty, so an
 * empty repository lists as empty rather than missing.
 *
 * Mirrors Python's `tree_rows`.
 */
export function treeRows(tree: Record<string, TreeEntry>): Map<string, FileStat[]> {
  const folders = new Map<string, FileStat[]>([['', []]])
  for (const [path, entry] of Object.entries(tree)) {
    if (entry.type === 'tree' && !folders.has(path)) folders.set(path, [])
    const cut = path.lastIndexOf('/')
    const parent = cut < 0 ? '' : path.slice(0, cut)
    const rows = folders.get(parent) ?? []
    rows.push(rowOf(entry, path.slice(cut + 1)))
    folders.set(parent, rows)
  }
  for (const rows of folders.values()) rows.sort((a, b) => compareCodePoints(a.name, b.name))
  return folders
}

/**
 * The listing of the folder `rel` out of the whole tree, with every folder
 * below it as seeds, all at `version`.
 *
 * Mirrors Python's `tree_listing`.
 *
 * Throws:
 *   NotADirectoryError: a file is at `rel`.
 *   FileNotFoundError: nothing is.
 */
export function treeListing(
  tree: Record<string, TreeEntry>,
  rel: string,
  version: string | null,
  virtual: string,
): DirListing {
  const folders = treeRows(tree)
  const entries = folders.get(rel)
  if (entries === undefined) {
    if (rel in tree) throw enotdir(virtual)
    throw enoent(virtual)
  }
  const lead = rel === '' ? '' : `${rel}/`
  const seeds = new Map<string, FileStat[]>()
  for (const [folder, rows] of folders) {
    if (folder !== rel && folder.startsWith(lead)) seeds.set(folder.slice(lead.length), rows)
  }
  return new DirListing({ entries, seeds, version })
}

/**
 * Replace the accessor's tree with one response.
 */
export function reseatTree(
  accessor: GitHubAccessor,
  tree: Record<string, TreeEntry>,
  truncated: boolean,
): void {
  accessor.truncated = truncated
  accessor.tree = tree
}

/**
 * Fetch the ref's recursive tree and reseat the accessor on it.
 *
 * Mirrors Python's `refresh_tree`.
 *
 * Returns:
 *   { tree, version } | null: the tree, keyed by repo-relative path, and the
 *   head it was read at, taken from this response rather than the accessor a
 *   concurrent refresh may have reseated since; null when GitHub truncated
 *   it, which then names only some paths.
 */
export async function refreshTree(
  accessor: GitHubAccessor,
): Promise<{ tree: Record<string, TreeEntry>; version: string | null } | null> {
  const generation = accessor.generation
  const { tree, truncated, sha } = await fetchTree(
    accessor.account.transport,
    accessor.owner,
    accessor.repo,
    accessor.ref,
  )
  const current = buildTreeMap(tree)
  // A drop while GitHub answered may be for the very write this tree
  // predates, so it is handed back but not kept.
  if (generation === accessor.generation) reseatTree(accessor, current, truncated)
  return truncated ? null : { tree: current, version: sha }
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
    page = await fetchDirPage(accessor.account.transport, accessor.owner, accessor.repo, expression)
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
