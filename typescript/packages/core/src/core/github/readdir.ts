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
import { enoent, enotdir } from '../../errors/fs.ts'
import { DirListing, FileType, type FileStat, type PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { GitHubApiError } from './client.ts'
import { DEFER_STATUSES } from './constants.ts'
import { fetchDirTree, refreshTree, rowOf, treeListing } from './tree.ts'
import { makeTreeEntry } from './tree_entry.ts'

/**
 * A folder's listing, with every folder below it as seeds.
 *
 * One recursive tree answers the whole repository at the head it names, so
 * the listing carries that head as its version. A tree GitHub truncated names
 * only some paths; the folder is then read from its own tree, asked by its
 * path at the ref so it is as current as the request (a sha from an older
 * parent listing is not), and once a mount has seen its tree truncated it asks
 * no recursive tree again.
 *
 * Mirrors Python's `readdir`.
 *
 * Throws:
 *   NotADirectoryError: a file is at the path.
 *   FileNotFoundError: nothing is.
 */
export async function readdir(
  accessor: GitHubAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): Promise<DirListing> {
  const rel = stripSlash((path.pattern !== null ? path.dir : path).mountPath)
  if (!accessor.truncated) {
    const fetched = await refreshTree(accessor)
    if (fetched !== null) return treeListing(fetched.tree, rel, fetched.version, path.virtual)
  }
  if (rel !== '' && (entry === undefined || entry === null)) throw enoent(path.virtual)
  if (entry != null && entry.type !== FileType.DIRECTORY) throw enotdir(path.virtual)
  const expression = rel === '' ? accessor.ref : `${accessor.ref}:${rel}`
  let rows: Awaited<ReturnType<typeof fetchDirTree>>
  try {
    rows = await fetchDirTree(accessor.transport, accessor.owner, accessor.repo, expression)
  } catch (err) {
    if (err instanceof GitHubApiError && DEFER_STATUSES.has(err.status)) throw enoent(path.virtual)
    throw err
  }
  return new DirListing({ entries: rows.map((row) => rowOf(makeTreeEntry(row), row.path)) })
}
