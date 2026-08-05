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

import git from 'isomorphic-git'

import { repoArgs, type Repo } from './repo.ts'

/** One tree entry, flattened to a repository-relative path. */
export interface TreeEntry {
  readonly oid: string
  /** git's own octal spelling, e.g. `100644`. */
  readonly mode: string
}

/**
 * Every blob a tree holds, keyed by repository-relative path.
 *
 * Flattened rather than walked per directory because every caller here compares
 * two whole trees; git's own diff does the same on the paths it has already
 * expanded. A submodule (`160000`) is carried through as an entry rather than
 * descended into: it names a commit in another repository.
 */
export async function treeEntries(
  repo: Repo,
  treeOid: string,
  prefix = '',
): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>()
  const { tree } = await git.readTree({ ...repoArgs(repo), oid: treeOid })
  for (const entry of tree) {
    const path = prefix === '' ? entry.path : `${prefix}/${entry.path}`
    if (entry.type === 'tree') {
      for (const [key, value] of await treeEntries(repo, entry.oid, path)) out.set(key, value)
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode })
    }
  }
  return out
}

/**
 * Every blob a commit's tree holds, or an empty map for no commit at all.
 *
 * An empty map is what an unborn HEAD means: nothing is committed yet, so every
 * staged path reads as an addition.
 */
export async function commitEntries(
  repo: Repo,
  commitOid: string | null,
): Promise<Map<string, TreeEntry>> {
  if (commitOid === null) return new Map()
  const { commit } = await git.readCommit({ ...repoArgs(repo), oid: commitOid })
  return treeEntries(repo, commit.tree)
}
