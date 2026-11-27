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

import { ResolveIndexError } from './errors.ts'
import { isEacces } from '../../../../errors/fs.ts'
import { exists, lstat } from './io.ts'
import { Digest } from '../../../../utils/hash.ts'

import type { Repo } from './repo.ts'
import type { ConflictedEntry, IndexEntry, IndexState } from './types.ts'
import type { FileStat, PathSpec } from '../../../../types.ts'
import type { Files } from '../../../../workspace/files.ts'

const MERGE_HEAD = 'MERGE_HEAD'

/** What a mutation hands back to the index, before the stat cache is filled. */
export interface StagedEntry {
  readonly oid: string
  readonly mode: number
  readonly size: number
  /** The fingerprint the entry keeps, as `withFingerprint` sets it; 0 for none. */
  readonly dev?: number
  readonly ino?: number
}

/**
 * The `dev` and `ino` an entry keeps a fingerprint as: the first eight bytes
 * of its SHA-1. Mirrors Python's `_kept`.
 */
function kept(fingerprint: string): readonly [number, number] {
  const digest = new Digest('sha1')
  digest.update(new TextEncoder().encode(fingerprint))
  const hex = digest.digest()
  return [Number.parseInt(hex.slice(0, 8), 16), Number.parseInt(hex.slice(8, 16), 16)]
}

/**
 * `entry` keeping what the mount says of the file it was read from or written
 * to, so a later comparison can find it unchanged unread.
 *
 * git caches a file's stat (device, inode, times, size) in its entry to the
 * same end. A mount has no inode or device a later stat could be held
 * against, but it has a fingerprint that moves whenever the file's bytes
 * change, so the entry keeps that in the two fields instead. A mount that
 * answers none leaves them zero, which git reads as nothing cached, and the
 * file is read next time. Mirrors Python's `with_fingerprint`.
 *
 * @param entry the entry for the file's bytes
 * @param info the mount's stat of the file, taken before it was read or
 *   after it was written
 */
export function withFingerprint(entry: StagedEntry, info: FileStat): StagedEntry {
  if (info.fingerprint === null || info.fingerprint === '') return { ...entry, dev: 0, ino: 0 }
  const [dev, ino] = kept(info.fingerprint)
  return { ...entry, dev, ino }
}

/**
 * The backend's own stat of a file just read, when it still gives the
 * fingerprint `info` had before the read; null when it gives another, none, or
 * refuses the stat.
 *
 * A fingerprint kept with a blob has to describe the bytes hashed, and a stat
 * from before the read may be older than they are: a kept listing's row, or a
 * file another writer changed in between. One more stat after the read catches
 * either; a file that changed and changed back within the read is the window
 * that remains. Mirrors Python's `still_stats`.
 *
 * @param vfs the session's files
 * @param path absolute virtual path of the file
 * @param info the stat taken before the read
 */
export async function stillStats(
  vfs: Files,
  path: PathSpec,
  info: FileStat,
): Promise<FileStat | null> {
  let after: FileStat | null
  try {
    after = await lstat(vfs, path, true)
  } catch (err) {
    if (isEacces(err)) return null
    throw err
  }
  if (after === null || (after.fingerprint ?? '') === '') return null
  return after.fingerprint === info.fingerprint ? after : null
}

/**
 * Whether the mount says the file is still the one `entry` kept, which
 * settles it without reading the file. Mirrors Python's `unchanged`.
 *
 * @param entry what the index records for the path
 * @param info what the mount says about it now
 */
export function unchanged(entry: StagedEntry, info: FileStat): boolean {
  const dev = entry.dev ?? 0
  const ino = entry.ino ?? 0
  if (info.fingerprint === null || info.fingerprint === '' || (dev === 0 && ino === 0)) {
    return false
  }
  const [keptDev, keptIno] = kept(info.fingerprint)
  return keptDev === dev && keptIno === ino
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
    /** Each row in the raw shape isomorphic-git keeps it in. */
    entriesFlat: {
      path: string
      oid: string
      mode: number
      size: number
      dev: number
      ino: number
      stage?: number
      flags?: { stage?: number }
    }[]
    insert(args: { filepath: string; stats: object; oid: string; stage?: number }): void
    delete(args: { filepath: string }): void
  }) => T,
): Promise<T> {
  // Wrapped rather than passed raw: the public API wraps every fs it is given
  // before handing it to a manager, and a manager calls the wrapper's own
  // methods (`lstat`, `readdir` returning null on a miss) rather than the plain
  // ones the plugin declares.
  return GitIndexManager.acquire(
    { fs: new FileSystem(repo.fs) as never, gitdir: repo.location.gitdir.virtual, cache: {} },
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
export async function readIndex(repo: Repo, vfs: Files): Promise<IndexState> {
  const merging = await exists(vfs, repo.location.gitdir.join(MERGE_HEAD))
  const entries = new Map<string, IndexEntry>()
  const conflicts = new Map<string, ConflictedEntry>()
  const rows = await withIndex(repo, (index) =>
    index.entriesFlat.map((entry): IndexEntry => ({
      path: entry.path,
      oid: entry.oid,
      mode: entry.mode,
      size: entry.size,
      dev: entry.dev,
      ino: entry.ino,
      stage: entry.stage ?? entry.flags?.stage ?? 0,
    })),
  )
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
 * The times are written zeroed, which git reads as "do not trust them": a
 * mount serves none git could hold a later stat against. `dev` and `ino` keep
 * the fingerprint `withFingerprint` set, zero for none. A zeroed `size` means
 * "not stated" to every reader here, never "empty".
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
          dev: entry.dev ?? 0,
          ino: entry.ino ?? 0,
          mode: entry.mode,
          uid: 0,
          gid: 0,
          size: entry.size,
        },
      })
    }
  })
}

/**
 * Refuse a branch move while the index still records conflict stages.
 *
 * Every collision check a checkout makes reads stage 0, so a path held only as
 * stages 1-3 is invisible to all of them, and git refuses before it reads
 * either tree. The refusal is not the moving side's alone: `git switch
 * <current>` and `git checkout <current>` move nothing and still die on it, so
 * a line that answers "Already on" out of a shortcut has to ask the index
 * first. Pinned against git 2.50.1, where `git switch -c <new>` is the one line
 * that survives an unresolved index, because it writes a ref and nothing else.
 */
export function refuseUnresolved(state: IndexState): void {
  if (state.conflicts.size === 0) return
  throw new ResolveIndexError([...state.conflicts.keys()])
}
