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

import { IOResult } from '../../../../io/types.ts'
import type { StatPath } from '../../../../ops/types.ts'
import { FileType, type FileStat } from '../../../../types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  GitError,
  IgnoredPathsError,
  NothingSpecifiedError,
  NoWorkspaceError,
  PathspecError,
  UnknownPathspecError,
  UnknownSwitchError,
} from './errors.ts'
import type { IgnoreStack } from './ignore.ts'
import { loadIgnores } from './ignore.ts'
import { readIndex, updateIndex, type StagedEntry } from './index_file.ts'
import { readFile, under } from './io.ts'
import { matched, repoRelative } from './pathspec.ts'
import { opened, repoArgs, type Repo } from './repo.ts'
import type { RepoLocation, WorkTree } from './types.ts'
import { checkOperands, fatal, startPoint } from './util.ts'
import { scan, UNTRACKED_ALL } from './worktree.ts'

// git records one of two modes for a regular file and reads only the owner
// execute bit to choose. A mount that reports no mode at all stages the ordinary
// one, which is what the file will read back as.
const REGULAR = 0o100644
const EXECUTABLE = 0o100755
const OWNER_EXECUTE = 0o100

/** The parsed shape of a `git add` invocation. */
interface AddFlags {
  /** `-A`, stage every change in the working tree. */
  readonly every: boolean
  /** `-u`, stage changes to tracked files only. */
  readonly update: boolean
  /** `-f`, stage a path an ignore rule covers. */
  readonly force: boolean
}

/** Read the raw add flag kwargs into a frozen struct. */
function parseFlags(fl: FlagView): AddFlags {
  return { every: fl.asBool('all'), update: fl.asBool('update'), force: fl.asBool('force') }
}

/** The mode git would record for a working-tree file. */
function entryMode(info: FileStat): number {
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
    const info = await statPath(under(location.worktree, target))
    if (info === null || info.type === FileType.DIRECTORY) throw new PathspecError(operand)
    found.files.set(target, info)
    stage.add(target)
  }
  if (ignored.length > 0) throw new IgnoredPathsError(ignored)
  return [stage, remove]
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
  // The mount doors ride the one record; `opts` keeps its name so
  // the body reads the same as when they were a parameter.
  const opts = inv.ops ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  try {
    const dispatch = opts.dispatch
    const statPath = opts.statPath
    if (statPath === undefined || opts.mountRoot === undefined || dispatch === undefined) {
      throw new NoWorkspaceError()
    }
    checkOperands(texts, UnknownSwitchError)
    const parsed = parseFlags(fl)
    if (texts.length === 0 && !parsed.every && !parsed.update) throw new NothingSpecifiedError()
    const repo: Repo = await opened(fl, statPath, opts.mountRoot, dispatch)
    const state = await readIndex(repo, dispatch)
    const tracked = new Set(state.entries.keys())
    const found = await scan(dispatch, statPath, repo.location, tracked, UNTRACKED_ALL)
    const ignores = await loadIgnores(dispatch, repo.location.gitdir, repo.location.worktree)
    const present = new Set(found.files.keys())
    let stage: Set<string>
    let remove: Set<string>
    if (parsed.update) {
      const scope =
        texts.length > 0
          ? updateScope(repo.location, startPoint(fl), texts, tracked, present)
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
        startPoint(fl),
        texts,
        found,
        tracked,
        ignores,
        parsed.force,
      )
    }
    const staged = new Map<string, StagedEntry>()
    for (const path of [...stage].sort()) {
      const data = await readFile(dispatch, under(repo.location.worktree, path))
      const oid = await git.writeBlob({ ...repoArgs(repo), blob: data })
      const info = found.files.get(path)
      if (info === undefined) continue
      staged.set(path, stagedEntry(oid, info, data.length))
    }
    await updateIndex(repo, staged, remove)
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  return [null, new IOResult()]
}
