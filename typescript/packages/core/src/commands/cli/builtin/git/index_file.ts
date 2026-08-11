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

import { GitIndexManager } from 'isomorphic-git/managers'
import { FileSystem } from 'isomorphic-git/models'

import { exists, under } from './io.ts'
import type { Repo } from './repo.ts'
import type { ConflictedEntry, Dispatch, IndexEntry, IndexState } from './types.ts'

const MERGE_HEAD = 'MERGE_HEAD'

/** The raw shape isomorphic-git keeps one index row in. */
interface RawEntry {
  path: string
  oid: string
  mode: number
  size: number
  stage?: number
  flags?: { stage?: number }
}

/** What a mutation hands back to the index, before the stat cache is filled. */
export interface StagedEntry {
  readonly oid: string
  readonly mode: number
  readonly size: number
}

function stageOf(entry: RawEntry): number {
  return entry.stage ?? entry.flags?.stage ?? 0
}

function toEntry(entry: RawEntry): IndexEntry {
  return {
    path: entry.path,
    oid: entry.oid,
    mode: entry.mode,
    size: entry.size,
    stage: stageOf(entry),
  }
}

/**
 * Run a closure against the live index, writing it back if it was changed.
 *
 * A fresh cache per call on purpose: the index is re-read every time rather than
 * memoized, because a mirage mutation between two verbs happens outside
 * isomorphic-git's knowledge and a shared cache would replay the old one.
 *
 * The index lives in `gitdir`, never `commondir`: a linked worktree stages its
 * own content, and pointing this at the shared directory would show one
 * checkout's staged changes in another.
 */
async function withIndex<T>(
  repo: Repo,
  closure: (index: {
    entriesFlat: RawEntry[]
    insert(args: { filepath: string; stats: object; oid: string; stage?: number }): void
    delete(args: { filepath: string }): void
  }) => T,
): Promise<T> {
  // Wrapped rather than passed raw: the public API wraps every fs it is given
  // before handing it to a manager, and a manager calls the wrapper's own
  // methods (`lstat`, `readdir` returning null on a miss) rather than the plain
  // ones the plugin declares.
  return GitIndexManager.acquire(
    { fs: new FileSystem(repo.fs) as never, gitdir: repo.location.gitdir, cache: {} },
    closure as never,
  ) as Promise<T>
}

/**
 * Read `.git/index` through the dispatcher.
 *
 * The index is the third thing `status` compares, and the only one that is a
 * single file: HEAD's tree is assembled from objects and the working tree is
 * walked, but staged content is one binary blob.
 *
 * An absent index is not an error. `git init` writes none until the first
 * `git add`, and every path is then untracked, which is what an empty table
 * already says.
 */
export async function readIndex(repo: Repo, dispatch: Dispatch): Promise<IndexState> {
  const merging = await exists(dispatch, under(repo.location.gitdir, MERGE_HEAD))
  const entries = new Map<string, IndexEntry>()
  const conflicts = new Map<string, ConflictedEntry>()
  const rows = await withIndex(repo, (index) => index.entriesFlat.map(toEntry))
  for (const row of rows) {
    if (row.stage === 0) {
      entries.set(row.path, row)
      continue
    }
    // Conflicted paths are carried apart rather than dropped, because a dropped
    // one reads as unmodified: the file would compare equal to nothing and
    // vanish from the report while git is refusing to commit because of it.
    const held = conflicts.get(row.path) ?? { ancestor: null, this: null, other: null }
    conflicts.set(row.path, {
      ancestor: row.stage === 1 ? row : held.ancestor,
      this: row.stage === 2 ? row : held.this,
      other: row.stage === 3 ? row : held.other,
    })
  }
  return { entries, conflicts, merging }
}

/**
 * Replace the staged entries, leaving conflicts alone.
 *
 * The stat cache is written zeroed, which git reads as "do not trust it": it
 * then compares content rather than believing a size or an mtime mirage cannot
 * promise is meaningful. A zeroed `size` therefore means "not stated" to every
 * reader here, never "empty".
 *
 * @param repo the opened repository
 * @param staged the paths to set, mapped to what should be recorded for them
 * @param removed the paths to drop from the index entirely
 */
export async function updateIndex(
  repo: Repo,
  staged: ReadonlyMap<string, StagedEntry>,
  removed: Iterable<string> = [],
): Promise<void> {
  await withIndex(repo, (index) => {
    for (const path of removed) index.delete({ filepath: path })
    for (const [path, entry] of staged) {
      index.insert({
        filepath: path,
        oid: entry.oid,
        stats: {
          ctimeSeconds: 0,
          ctimeNanoseconds: 0,
          mtimeSeconds: 0,
          mtimeNanoseconds: 0,
          dev: 0,
          ino: 0,
          mode: entry.mode,
          uid: 0,
          gid: 0,
          size: entry.size,
        },
      })
    }
  })
}
