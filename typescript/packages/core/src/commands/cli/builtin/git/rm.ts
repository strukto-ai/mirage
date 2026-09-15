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

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIInvocation } from '../../types.ts'
import { DELETED, headEntries, MODIFIED, workChanges } from './changes.ts'
import {
  GitError,
  NoPathspecRemoveError,
  NotRecursiveError,
  NoWorkspaceError,
  PathspecError,
  RemovalRefusedError,
  RemovePathError,
  UnknownSwitchError,
} from './errors.ts'
import { readIndex, updateIndex } from './index_file.ts'
import { removeEmptyParents, removeFile, under } from './io.ts'
import { matched, repoRelative } from './pathspec.ts'
import { opened, type Repo } from './repo.ts'
import type { TreeEntry } from './tree.ts'
import type { Dispatch, IndexEntry, RepoLocation, WorkTree } from './types.ts'
import { checkOperands, escaped, fatal, startPoint, switches } from './util.ts'
import { scan, UNTRACKED_NO } from './worktree.ts'
import type { LinkView, MountView, StatPath } from '../../../../ops/types.ts'
import { FileType } from '../../../../types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

const ENC = new TextEncoder()

/** The parsed shape of a `git rm` invocation. */
export interface RmFlags {
  /** `-r`, allow a directory operand. */
  readonly recursive: boolean
  /** `--cached`, unstage only and keep the file. */
  readonly cached: boolean
  /** `-f`, remove even over uncommitted changes. */
  readonly force: boolean
  /** `-q`, print no `rm` line per path. */
  readonly quiet: boolean
  /** `--ignore-unmatch`, an operand naming nothing is not an error. */
  readonly ignoreUnmatch: boolean
}

/** Read the raw rm flag kwargs into a frozen struct. */
function parseFlags(fl: FlagView): RmFlags {
  return {
    recursive: fl.asBool('r'),
    cached: fl.asBool('cached'),
    force: fl.asBool('force'),
    quiet: fl.asBool('quiet'),
    ignoreUnmatch: fl.asBool('ignore_unmatch'),
  }
}

/**
 * Which tracked paths the operands remove, in index order.
 *
 * Every operand is checked before anything is removed, which is git's order
 * too: a line with one bad operand removes nothing. A directory is refused
 * without `-r` rather than expanded, and an operand that names nothing tracked
 * is a fatal unless `--ignore-unmatch` says otherwise. An untracked file is
 * "nothing tracked": git has nothing to remove it from.
 */
export function select(
  location: RepoLocation,
  start: string,
  operands: readonly string[],
  tracked: ReadonlySet<string>,
  flags: RmFlags,
): string[] {
  const selected = new Set<string>()
  for (const operand of operands) {
    const target = repoRelative(location, start, operand)
    if (tracked.has(target)) {
      selected.add(target)
      continue
    }
    const hits = matched(tracked, target)
    if (hits.size === 0) {
      if (flags.ignoreUnmatch) continue
      throw new PathspecError(operand)
    }
    if (!flags.recursive) throw new NotRecursiveError(operand)
    for (const path of hits) selected.add(path)
  }
  return [...selected].sort(compareCodePoints)
}

/**
 * Which absent paths a link above them is only hiding.
 *
 * git lstats a tracked path to decide whether it still has local work to lose,
 * and that lstat resolves every component above the file, so a symlink standing
 * where a directory was does not hide the file: it points the check at whatever
 * lies at the other end, which is some other file entirely and therefore a
 * local change. The walk answers the opposite way on purpose, because git's own
 * diff refuses to follow a leading link and reports the path deleted, which is
 * why `git status` says `D` here and `git rm` still refuses. Nothing is
 * compared: two files agreeing byte for byte are still two files, and git
 * refuses that case too. Pinned against git 2.50.1.
 *
 * @param links the name plane's link facts, null when no namespace is wired
 * @param worktree absolute virtual path of the working tree root
 * @param paths the selected paths that hold an index entry
 * @param missing what the walk said about each path
 */
export async function shadowed(
  links: LinkView | null,
  worktree: string,
  paths: readonly string[],
  missing: ReadonlyMap<string, string>,
): Promise<Set<string>> {
  const found = new Set<string>()
  if (links === null) return found
  for (const path of paths) {
    if (missing.get(path) !== DELETED) continue
    const absolute = under(worktree, path)
    if (links.resolve(absolute) === absolute) continue
    if (await links.exists(absolute)) found.add(path)
  }
  return found
}

/**
 * Refuse a removal that would throw away uncommitted work.
 *
 * git's own three-way test per path: whether the index differs from HEAD, and
 * whether the working tree differs from the index. A path that differs both
 * ways is refused outright; one that differs one way is refused unless
 * `--cached` keeps the file. A file already gone from the working tree has no
 * local change to lose, which is what makes `git rm <deleted>` the way to stage
 * a deletion. Pinned against git 2.50.1.
 */
export async function refuseLostWork(
  repo: Repo,
  dispatch: Dispatch,
  tree: ReadonlyMap<string, TreeEntry>,
  entries: ReadonlyMap<string, IndexEntry>,
  found: WorkTree,
  paths: readonly string[],
  cached: boolean,
  links: LinkView | null,
): Promise<void> {
  const chosen = new Map<string, IndexEntry>()
  for (const path of paths) {
    const entry = entries.get(path)
    if (entry !== undefined) chosen.set(path, entry)
  }
  const unstaged = await workChanges(repo, dispatch, repo.location.worktree, chosen, found)
  const hidden = await shadowed(links, repo.location.worktree, paths, unstaged)
  const both: string[] = []
  const staged: string[] = []
  const local: string[] = []
  for (const [path, entry] of chosen) {
    const recorded = tree.get(path)
    const stagedChanges =
      recorded?.oid !== entry.oid || Number.parseInt(recorded.mode, 8) !== entry.mode
    const localChanges = unstaged.get(path) === MODIFIED || hidden.has(path)
    if (localChanges && stagedChanges) both.push(path)
    else if (!cached) {
      if (stagedChanges) staged.push(path)
      if (localChanges) local.push(path)
    }
  }
  if (both.length > 0 || staged.length > 0 || local.length > 0) {
    throw new RemovalRefusedError(both, staged, local)
  }
}

/**
 * Delete every selected path from the working tree.
 *
 * A directory standing where a tracked file was is the one deletion a mount
 * cannot make: `unlink` is not the call that empties a tree, and git reports
 * the strerror rather than removing what it never tracked. It reports it in
 * index order and only while nothing has been deleted yet; once one path is
 * gone the rest of the loop tolerates a failure and the line still succeeds.
 * That is git's own rule rather than a reading of it, and it is observable both
 * ways: `git rm slot z.txt` is fatal with the index untouched, while
 * `git rm a.txt slot` exits 0 with both entries unstaged and the directory
 * still on disk. Pinned against git 2.50.1.
 *
 * A tracked symlink to a directory is not this case and must not be read as
 * one: it is removed as the link it is, which is why the namespace is asked
 * before the type.
 *
 * @param dispatch workspace op dispatcher
 * @param statPath the data plane's stat, which dereferences
 * @param worktree absolute virtual path of the working tree root
 * @param selected the paths to delete, in index order
 * @param lines the `rm` lines already printed, for a refusal to carry on stdout
 *   the way git prints them anyway
 * @param links the name plane's link facts, null when no namespace is wired
 * @param mounts the name plane's mount boundaries, null when none is wired
 */
export async function clearWorktree(
  dispatch: Dispatch,
  statPath: StatPath,
  worktree: string,
  selected: readonly string[],
  lines: string,
  links: LinkView | null,
  mounts: MountView | null,
): Promise<void> {
  let removed = false
  for (const path of selected) {
    const absolute = under(worktree, path)
    if ((links?.statAt(absolute) ?? null) === null) {
      const info = await statPath(absolute)
      if (info !== null && info.type === FileType.DIRECTORY) {
        if (!removed) throw new RemovePathError(path, lines)
        continue
      }
    }
    await removeFile(dispatch, absolute)
    await removeEmptyParents(dispatch, absolute, worktree, mounts)
    removed = true
  }
}

/**
 * Remove paths from the index, and from the working tree too.
 *
 * `--cached` leaves the file where it is and only stops tracking it. Without
 * `-f` a path carrying uncommitted work is refused rather than deleted, which is
 * the one check that makes the verb safe to hand an agent: there is no reflog
 * here to recover a file from.
 */
export async function rm(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  let flags: RmFlags
  let selected: string[]
  try {
    const dispatch = doors.dispatch
    const statPath = doors.statPath
    if (statPath === undefined || dispatch === undefined) {
      throw new NoWorkspaceError()
    }
    checkOperands(texts, UnknownSwitchError, escaped(inv.argv), switches(inv))
    flags = parseFlags(fl)
    if (texts.length === 0) throw new NoPathspecRemoveError()
    const repo = await opened(fl, doors)
    const state = await readIndex(repo, dispatch)
    const tracked = new Set([...state.entries.keys(), ...state.conflicts.keys()])
    selected = select(repo.location, startPoint(fl), texts, tracked, flags)
    if (!flags.force) {
      const checkable = selected.filter((path) => state.entries.has(path))
      const found = await scan(
        dispatch,
        statPath,
        repo.location,
        tracked,
        UNTRACKED_NO,
        doors.ns?.links ?? null,
      )
      const tree = (await headEntries(repo)) ?? new Map<string, TreeEntry>()
      await refuseLostWork(
        repo,
        dispatch,
        tree,
        state.entries,
        found,
        checkable,
        flags.cached,
        doors.ns?.links ?? null,
      )
    }
    const lines = flags.quiet ? '' : selected.map((path) => `rm '${path}'\n`).join('')
    if (!flags.cached) {
      await clearWorktree(
        dispatch,
        statPath,
        repo.location.worktree,
        selected,
        lines,
        doors.ns?.links ?? null,
        doors.ns?.mounts ?? null,
      )
    }
    // Last, because the deletions above can fail: git writes the index only
    // once the working tree is done with, so a refused deletion leaves the
    // entry staged exactly as it stood rather than staging a removal that
    // never happened.
    await updateIndex(repo, new Map(), selected)
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  if (flags.quiet) return [null, new IOResult()]
  return [ENC.encode(selected.map((path) => `rm '${path}'\n`).join('')), new IOResult()]
}
