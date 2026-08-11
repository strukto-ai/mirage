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

import type { FileStat } from '../../../../types.ts'
import type { CommandDispatch } from '../../../config.ts'

/**
 * The workspace op dispatcher, as every module here consumes it.
 *
 * PathSpec-typed and tuple-returning, which is the dispatcher's own contract
 * rather than the Workspace facade's: a CLI leaf is handed the same callable a
 * mount command receives.
 */
export type Dispatch = CommandDispatch

/**
 * A resolved repository: where the objects live, and over what.
 *
 * `gitdir` and `worktree` are separate for the same reason they are in git: the
 * two need not be nested, and a bare repository has no worktree at all.
 *
 * `commondir` is the third: a linked worktree (`git worktree add`) gets its own
 * gitdir holding HEAD and the index, while the object database, packed-refs and
 * branches stay in the repository it was cut from. The two are the same
 * directory for an ordinary checkout, which is why one field carried both until
 * worktrees turned up.
 */
export interface RepoLocation {
  /** This checkout's git directory, which holds HEAD and the index. */
  readonly gitdir: string
  /**
   * The shared git directory, which holds objects and branches. Equal to
   * `gitdir` unless this is a linked worktree.
   */
  readonly commondir: string
  /** The working tree root. */
  readonly worktree: string
  /** The mount prefix both live under, which bounded the discovery walk. */
  readonly mountRoot: string
}

/** What HEAD points at: a branch, some other ref, or a raw commit. */
export interface HeadRef {
  /** Short branch name when HEAD is a symbolic ref under `refs/heads`. */
  readonly branch: string | null
  /** The full ref name HEAD names, null when detached. */
  readonly ref: string | null
  /** The object id HEAD holds directly, set only on a detached HEAD. */
  readonly commit: string | null
}

/** One `~` or `^` suffix of a revision. */
export interface AncestryStep {
  /**
   * True for `~n` (walk n generations along first parents), false for `^n`
   * (take the n-th parent).
   */
  readonly firstParent: boolean
  /** The number after the suffix, 1 when it was bare. */
  readonly count: number
}

/**
 * One entry of `.git/index`.
 *
 * The stat fields are what git calls the stat cache; zeroing them means "do not
 * trust it", which is safe. A zeroed `size` is therefore read as "not stated"
 * rather than "empty", which is what lets a restored entry carry no length.
 */
export interface IndexEntry {
  readonly path: string
  readonly oid: string
  readonly mode: number
  readonly size: number
  /** 1, 2 or 3 for a conflicted entry; 0 for an ordinary one. */
  readonly stage: number
}

/** Whichever of the three merge stages a conflicted path has. */
export interface ConflictedEntry {
  readonly ancestor: IndexEntry | null
  readonly this: IndexEntry | null
  readonly other: IndexEntry | null
}

/**
 * What `.git/index` says, split by whether a path is in conflict.
 *
 * Conflicted paths are carried apart rather than dropped, because a dropped one
 * reads as unmodified: the file would compare equal to nothing and vanish from
 * the report while git is refusing to commit because of it.
 */
export interface IndexState {
  /** Staged content, keyed by repository-relative path. */
  readonly entries: Map<string, IndexEntry>
  /** Paths left unmerged, each holding whichever of the three stages exist. */
  readonly conflicts: Map<string, ConflictedEntry>
  /**
   * Whether `MERGE_HEAD` is present, which is what distinguishes a merge in
   * progress from its leftovers.
   */
  readonly merging: boolean
}

/**
 * One path's status, in the two columns git reports it in.
 *
 * The pair is git's own model, not a convenience: the left column is HEAD
 * against the index and the right is the index against the working tree, so a
 * file edited, staged, then edited again is `MM` and appears in both sections of
 * the long format. Collapsing the two into one verdict is what makes a status
 * report unable to say that.
 */
export interface StatusEntry {
  /** Repository-relative path. */
  readonly path: string
  /** The left column, one character. */
  readonly indexStatus: string
  /** The right column, one character. */
  readonly treeStatus: string
  /** The path renamed from, set only for `R`. */
  readonly original: string | null
}

/** What one walk of the working tree found. */
export interface WorkTree {
  /**
   * Every non-ignored file that is not under an untracked collapsed directory,
   * mapped to what the mount said about it. The whole stat is kept rather than
   * the size alone because the comparison reads the mode too, and the walk has
   * already paid for it.
   */
  readonly files: Map<string, FileStat>
  /** Paths to report as untracked, already collapsed to `dir/` where git would. */
  readonly untracked: string[]
}
