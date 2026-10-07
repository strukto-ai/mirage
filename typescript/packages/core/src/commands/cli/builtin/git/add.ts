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

import { visibleEntries, matched, repoRelative } from './pathspec.ts'

import { IOResult } from '../../../../io/types.ts'
import type { LinkView, StatPath } from '../../../../ops/types.ts'
import { FileType, type FileStat } from '../../../../types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  GitError,
  IgnoredPathsError,
  NothingSpecifiedError,
  NoWorkspaceError,
  PathspecError,
  UnknownPathspecError,
} from './errors.ts'
import { type IgnoreStack, loadIgnores } from './ignore.ts'
import { readIndex, updateIndex, type StagedEntry } from './index_file.ts'
import { entryBytes } from './io.ts'

import { repoArgs, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { EXECUTABLE, OWNER_EXECUTE, REGULAR, SYMLINK } from './constants.ts'
import type { Dispatch, IndexEntry, IndexState, RepoLocation, WorkTree } from './types.ts'
import { checkSwitches, fatal, startPoint } from './util.ts'
import { scan, UNTRACKED_ALL, UNTRACKED_NO } from './worktree.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

const ENC = new TextEncoder()

/** The parsed shape of a `git add` invocation. */
interface AddFlags {
  /** `-A`, stage every change in the working tree. */
  readonly every: boolean
  /** `-u`, stage changes to tracked files only. */
  readonly update: boolean
  /** `-f`, stage a path an ignore rule covers. */
  readonly force: boolean
  /** `-v`, name each path as it is staged. */
  readonly verbose: boolean
}

/** Read the raw add flag kwargs into a frozen struct. */
function parseFlags(fl: FlagView): AddFlags {
  return {
    every: fl.asBool('all'),
    update: fl.asBool('update'),
    force: fl.asBool('force'),
    verbose: fl.asBool('verbose'),
  }
}

/** The mode git would record for a working-tree file. */
export function entryMode(info: FileStat): number {
  if (info.type === FileType.SYMLINK) return SYMLINK
  return info.mode !== null && (info.mode & OWNER_EXECUTE) !== 0 ? EXECUTABLE : REGULAR
}

/**
 * An index entry for a file just written into the object database.
 *
 * The stat fields git caches to avoid re-hashing (device, inode, timestamps) are
 * recorded as zero, because a mount serves none of them meaningfully. That is
 * not a corrupt entry: it is exactly what git calls a smudged one, and the only
 * consequence is that git re-hashes the file next time instead of trusting the
 * cache. A wrong value there would be far worse, since git would trust it.
 */
function stagedEntry(oid: string, info: FileStat, size: number): StagedEntry {
  return { oid, mode: entryMode(info), size }
}

/**
 * Drop the paths an ignore rule covers, keeping tracked ones.
 *
 * Ignore rules govern untracked files only, so a file already in the index stays
 * stageable however the rules read.
 */
function keepAddable(
  paths: Iterable<string>,
  tracked: ReadonlySet<string>,
  ignores: IgnoreStack,
): Set<string> {
  return new Set([...paths].filter((path) => tracked.has(path) || !ignores.isIgnored(path)))
}

/**
 * Which tracked paths `-u` operands select.
 *
 * `-u` restages what the index already holds, so an operand narrows that set
 * rather than adding to it: an untracked file under one is still not staged. git
 * tells two misses apart and so does this. An operand naming nothing at all is a
 * fatal about the pathspec, and one naming something the working tree has but
 * the index does not is a fatal about git not knowing it. Pinned against git
 * 2.50.1.
 */
function updateScope(
  location: RepoLocation,
  start: string,
  operands: readonly string[],
  tracked: ReadonlySet<string>,
  present: ReadonlySet<string>,
): Set<string> {
  const selected = new Set<string>()
  for (const operand of operands) {
    const target = repoRelative(location, start, operand)
    const hits = matched(tracked, target)
    if (hits.size === 0 && matched(present, target).size === 0) {
      throw new PathspecError(operand)
    }
    if (hits.size === 0) throw new UnknownPathspecError(operand, true)
    for (const path of hits) selected.add(path)
  }
  return selected
}

/**
 * Turn path operands into the paths to stage and to unstage.
 *
 * An operand that names nothing in either the working tree or the index is git's
 * fatal. Naming an ignored file outright is a different refusal, and only
 * applies when it is named outright: expanding a directory quietly leaves its
 * ignored files alone, because asking for a directory is not asking for the
 * things in it that were excluded.
 */
async function resolve(
  statPath: StatPath,
  location: RepoLocation,
  start: string,
  operands: readonly string[],
  found: WorkTree,
  tracked: ReadonlySet<string>,
  ignores: IgnoreStack,
  force: boolean,
): Promise<[Set<string>, Set<string>]> {
  const present = new Set(found.files.keys())
  const stage = new Set<string>()
  const remove = new Set<string>()
  const ignored: string[] = []
  for (const operand of operands) {
    const target = repoRelative(location, start, operand)
    const gone = [...matched(tracked, target)].filter((path) => !present.has(path))
    if (present.has(target)) {
      if (force || tracked.has(target) || !ignores.isIgnored(target)) stage.add(target)
      else ignored.push(target)
      continue
    }
    const hits = matched(present, target)
    if (hits.size > 0 || gone.length > 0) {
      for (const path of force ? hits : keepAddable(hits, tracked, ignores)) stage.add(path)
      for (const path of gone) remove.add(path)
      continue
    }
    const info = await statPath(location.worktree.join(target))
    if (info === null || info.type === FileType.DIRECTORY) throw new PathspecError(operand)
    found.files.set(target, info)
    stage.add(target)
  }
  if (ignored.length > 0) throw new IgnoredPathsError(ignored)
  return [stage, remove]
}

/**
 * Hash the staged paths into blobs, leaving the index to the caller.
 *
 * Returns the entries to write and what `-v` prints, in git's order: first the
 * paths the index already held whose content or mode changed, a removal among
 * them, then the new paths, each group sorted. A path restaged unchanged is not
 * named (pinned against git 2.50).
 */
export async function stageChanges(
  repo: Repo,
  dispatch: Dispatch,
  entries: ReadonlyMap<string, IndexEntry>,
  found: WorkTree,
  stage: ReadonlySet<string>,
  remove: ReadonlySet<string>,
): Promise<[Map<string, StagedEntry>, string[]]> {
  const staged = new Map<string, StagedEntry>()
  const changed: [string, string][] = []
  const added: string[] = []
  for (const path of [...stage].sort(compareCodePoints)) {
    const info = found.files.get(path)
    if (info === undefined) continue
    const data = await entryBytes(dispatch, repo.location.worktree.join(path), info)
    const oid = await git.writeBlob({ ...repoArgs(repo), blob: data })
    const entry = stagedEntry(oid, info, data.length)
    const before = entries.get(path)
    if (before === undefined) added.push(path)
    else if (before.oid !== entry.oid || before.mode !== entry.mode) changed.push([path, 'add'])
    staged.set(path, entry)
  }
  for (const path of remove) changed.push([path, 'remove'])
  changed.sort((a, b) => compareCodePoints(a[0], b[0]))
  return [
    staged,
    [
      ...changed.map(([path, verb]) => `${verb} '${path}'`),
      ...added.map((path) => `add '${path}'`),
    ],
  ]
}

/**
 * Restage every path the index holds from the working tree.
 *
 * What `add -u` does with no pathspec and `commit -a` does first: a modified
 * file is hashed again, a deleted one leaves the index, and an untracked one
 * stays untracked. `state` is updated to match; the caller writes the returned
 * entries and removals with `updateIndex` once it means to keep them.
 */
export async function stageTracked(
  repo: Repo,
  dispatch: Dispatch,
  statPath: StatPath,
  state: IndexState,
  links: LinkView | null,
): Promise<[Map<string, StagedEntry>, Set<string>]> {
  const tracked = new Set(visibleEntries(repo.location, state.entries).keys())
  const found = await scan(dispatch, statPath, repo.location, tracked, UNTRACKED_NO, links)
  const present = new Set(found.files.keys())
  const kept = new Set([...tracked].filter((path) => present.has(path)))
  const removed = new Set([...tracked].filter((path) => !present.has(path)))
  const [staged] = await stageChanges(repo, dispatch, state.entries, found, kept, removed)
  for (const path of removed) state.entries.delete(path)
  for (const [path, entry] of staged) state.entries.set(path, { path, ...entry, stage: 0 })
  return [staged, removed]
}

/**
 * Stage working-tree content into the index.
 *
 * Every path is hashed and written as a loose object, then recorded in the
 * index. Staging a path that is gone records the removal instead, which is what
 * makes `git add <deleted>` and `git add -A` stage a deletion without a separate
 * verb.
 *
 * `-A` and `-u` both narrow to the pathspecs when any are given, and differ in
 * what they will stage: `-A` takes untracked files too, `-u` only what the index
 * already holds.
 */
export async function add(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  try {
    const dispatch = doors.dispatch
    const statPath = doors.statPath
    if (statPath === undefined || dispatch === undefined) {
      throw new NoWorkspaceError()
    }
    checkSwitches(inv, texts)
    const parsed = parseFlags(fl)
    if (texts.length === 0 && !parsed.every && !parsed.update) throw new NothingSpecifiedError()
    const repo: Repo = await opened(fl, doors, true)
    const state = await readIndex(repo, dispatch)
    const tracked = new Set(visibleEntries(repo.location, state.entries).keys())
    const found = await scan(
      dispatch,
      statPath,
      repo.location,
      tracked,
      UNTRACKED_ALL,
      doors.ns?.links ?? null,
    )
    const ignores = await loadIgnores(dispatch, repo.location.commondir, repo.location.worktree)
    const present = new Set(found.files.keys())
    let stage: Set<string>
    let remove: Set<string>
    if (parsed.update) {
      const scope =
        texts.length > 0
          ? updateScope(repo.location, startPoint(fl).virtual, texts, tracked, present)
          : tracked
      stage = new Set([...scope].filter((path) => present.has(path)))
      remove = new Set([...scope].filter((path) => !present.has(path)))
    } else if (parsed.every && texts.length === 0) {
      stage = keepAddable(present, tracked, ignores)
      remove = new Set([...tracked].filter((path) => !present.has(path)))
    } else {
      ;[stage, remove] = await resolve(
        statPath,
        repo.location,
        startPoint(fl).virtual,
        texts,
        found,
        tracked,
        ignores,
        parsed.force,
      )
    }
    const [staged, lines] = await stageChanges(repo, dispatch, state.entries, found, stage, remove)
    await updateIndex(repo, staged, remove)
    if (!parsed.verbose || lines.length === 0) return [null, new IOResult()]
    return [ENC.encode(lines.map((line) => `${line}\n`).join('')), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
