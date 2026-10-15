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
import { ListingCheckStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'
import { GitHubApiError } from './client.ts'
import { fetchDirTree, fetchHead, pointRow, refreshTree, rowOf } from './tree.ts'
import { makeTreeEntry } from './tree_entry.ts'

/**
 * Every entry under a directory of the repository, each as its row, from one
 * recursive tree. Null when GitHub truncates that tree, which then names only
 * some paths, or when `path` is no directory in it, so the walk's readdir and
 * stat report what is there. Mirrors `tree` in `mirage/core/github/stat.py`.
 */
export async function tree(
  accessor: GitHubAccessor,
  path: PathSpec,
): Promise<Map<string, FileStat> | null> {
  if (accessor.truncated) return null
  const fetched = await refreshTree(accessor)
  if (fetched === null) return null
  const base = stripSlash(path.mountPath)
  if (base !== '' && fetched.tree[base]?.type !== 'tree') return null
  const lead = base === '' ? '' : `${base}/`
  const found = new Map<string, FileStat>()
  for (const [key, entry] of Object.entries(fetched.tree)) {
    if (key === base || !key.startsWith(lead)) continue
    found.set(key.slice(lead.length), rowOf(entry, key.slice(key.lastIndexOf('/') + 1)))
  }
  return found
}

/**
 * Stat one path in the repository.
 *
 * A path answers with its row, as its folder's listing names it. The gate's
 * check is handed no listed row, so it asks for the one path with one
 * directory listing, its parent's; a parent it cannot see, and a truncated
 * listing without the name, are no answer, so the whole tree is asked
 * instead, and one GitHub truncates is walked down from the ref one directory
 * at a time.
 *
 * Mirrors Python's `stat`.
 */
export async function stat(
  accessor: GitHubAccessor,
  path: PathSpec,
  entry?: FileStat | null,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const rel = stripSlash(path.mountPath)
  if (rel === '') {
    return new FileStat({
      name: '/',
      type: FileType.DIRECTORY,
      fingerprint: await rootVersion(accessor, index),
    })
  }
  if (entry !== undefined && entry !== null) return entry
  if (!(index instanceof ListingCheckStore)) throw enoent(path.virtual)
  const answer = await pointRow(accessor, rel)
  if (answer !== null) {
    if (answer.entry !== null) return rowOf(answer.entry, answer.entry.path)
    if (!answer.truncated) throw enoent(path.virtual)
  }
  if (!accessor.truncated) {
    const whole = await refreshTree(accessor)
    if (whole !== null) {
      const row = whole.tree[rel]
      if (row === undefined) throw enoent(path.virtual)
      return rowOf(row, rel.slice(rel.lastIndexOf('/') + 1))
    }
  }
  const found = await walked(accessor, rel)
  if (found === null) throw enoent(path.virtual)
  return found
}

/**
 * The row at `rel`, walked down from the ref one directory at a time; null
 * when a level does not name it. Mirrors Python's `_walked`.
 */
async function walked(accessor: GitHubAccessor, rel: string): Promise<FileStat | null> {
  let sha = accessor.ref
  const names = rel.split('/')
  for (const [depth, name] of names.entries()) {
    const rows = await fetchDirTree(accessor.transport, accessor.owner, accessor.repo, sha)
    const found = rows.find((row) => row.path === name)
    if (found === undefined) return null
    if (depth === names.length - 1) return rowOf(makeTreeEntry(found), name)
    if (found.type !== 'tree') return null
    sha = found.sha
  }
  return null
}

/**
 * The version of the whole mount: the head commit its ref is at.
 *
 * Only the gate's `ListingCheckStore` asks for it, with one shallow request.
 * Every other index (the mount's own, an undefined index) names no version
 * and reads nothing, neither the index nor the backend, so a getattr of the
 * root never pays a check or a store round trip: nothing reads a root
 * fingerprint off a mount-view stat. Nothing here refills the index: a
 * refused head names no version rather than falling into a lookup.
 *
 * Mirrors Python's `_root_version`.
 */
async function rootVersion(
  accessor: GitHubAccessor,
  index: IndexCacheStore | undefined,
): Promise<string | null> {
  if (!(index instanceof ListingCheckStore)) return null
  try {
    return await fetchHead(accessor.transport, accessor.owner, accessor.repo, accessor.ref)
  } catch (err) {
    // An answer that refuses the head is no answer about the version, the
    // way pointRow reads a refusal; anything else propagates.
    if (!(err instanceof GitHubApiError)) throw err
    console.warn(`head of ${accessor.owner}/${accessor.repo} not answered: ${String(err)}`)
    return null
  }
}
