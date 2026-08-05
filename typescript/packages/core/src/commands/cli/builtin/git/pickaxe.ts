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
import { treeEntries } from './tree.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })

/** How many times a string appears in one blob. */
async function occurrences(repo: Repo, oid: string | null, needle: string): Promise<number> {
  if (oid === null) return 0
  let data: Uint8Array
  try {
    data = (await git.readBlob({ ...repoArgs(repo), oid })).blob
  } catch {
    return 0
  }
  const text = DEC.decode(data)
  if (needle === '') return 0
  let count = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * Whether a commit changed the number of occurrences of a string.
 *
 * This is git's `-S` (pickaxe), and it is deliberately not a grep: a commit that
 * merely moves a line containing the string does not change how many times the
 * string appears, so it is not reported. The commit that *introduced* the string
 * is, which is what makes `-S <name> --reverse` answer "where did this come
 * from".
 *
 * Compared against the first parent, or against nothing for a root commit, so
 * the objects a root commit adds all count as introduced.
 */
export async function touches(
  repo: Repo,
  oid: string,
  parents: readonly string[],
  needle: string,
): Promise<boolean> {
  const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
  const after = await treeEntries(repo, commit.tree)
  const first = parents[0]
  let before = new Map<string, { oid: string; mode: string }>()
  if (first !== undefined) {
    const parent = await git.readCommit({ ...repoArgs(repo), oid: first })
    before = await treeEntries(repo, parent.commit.tree)
  }
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path)?.oid ?? null
    const now = after.get(path)?.oid ?? null
    if (old === now) continue
    if ((await occurrences(repo, old, needle)) !== (await occurrences(repo, now, needle))) {
      return true
    }
  }
  return false
}
