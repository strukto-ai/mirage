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
import type { LinkView, MountView, StatPath } from '../../../../ops/types.ts'
import { FileType, type FileStat } from '../../../../types.ts'
import { isMissingPath } from '../../../../utils/errors.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  GitError,
  MoveOverlapError,
  MoveRefusedError,
  MoveUsageError,
  NotADirectoryDestinationError,
  NoWorkspaceError,
  RenameFailedError,
  UnknownSwitchError,
} from './errors.ts'
import { readIndex, updateIndex, type StagedEntry } from './index_file.ts'
import { removeFile, renamePath, under } from './io.ts'
import { basename } from './path.ts'
import { repoRelative, under as inside } from './pathspec.ts'
import { opened } from './repo.ts'
import type { Dispatch, IndexEntry, RepoLocation } from './types.ts'
import { checkOperands, escaped, fatal, startPoint, switches } from './util.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

const ENC = new TextEncoder()

// git's own wording for each way a source can be refused, in the shape
// `fatal: <reason>, source=<src>, destination=<dst>`.
const BAD_SOURCE = 'bad source'
const INTO_ITSELF = 'can not move directory into itself'
const DESTINATION_EXISTS = 'destination exists'
const DESTINATION_ALREADY_EXISTS = 'destination already exists'
const SOURCE_DIRECTORY_EMPTY = 'source directory is empty'
const NOT_UNDER_VERSION_CONTROL = 'not under version control'
const MULTIPLE_SOURCES = 'multiple sources for the same target'
const CONFLICTED = 'conflicted'
// Not one of git's, because git has no concept to word: a mount is mirage's own
// boundary, so the refusal borrows the strerror the kernel gives for a rename it
// will not perform.
const BUSY = 'Device or resource busy'

/** The parsed shape of a `git mv` invocation. */
export interface MvFlags {
  /** `-f`, overwrite an existing destination file. */
  readonly force: boolean
  /** `-k`, skip a source that cannot move rather than refusing the line. */
  readonly skip: boolean
  /** `-n`, report what would move and move nothing. */
  readonly dryRun: boolean
  /** `-v`, print one line per move; implied by `-n`. */
  readonly verbose: boolean
}

/** Read the raw mv flag kwargs into a frozen struct. */
function parseFlags(fl: FlagView): MvFlags {
  const dryRun = fl.asBool('dry_run')
  return {
    force: fl.asBool('force'),
    skip: fl.asBool('k'),
    dryRun,
    verbose: fl.asBool('verbose') || dryRun,
  }
}

/** One source and where it goes. */
export interface Move {
  /** Repository-relative path being moved. */
  readonly source: string
  /**
   * Repository-relative path it moves to, already joined with the source's
   * basename when the destination was a directory.
   */
  readonly destination: string
  /**
   * The tracked paths that move with it: the source itself for a file,
   * everything under it for a directory.
   */
  readonly paths: readonly string[]
  /** Whether the source is a directory. */
  readonly directory: boolean
}

/** What one refusal check found: a reason, or the paths that move. */
interface Verdict {
  readonly reason: string | null
  readonly paths: readonly string[]
  readonly directory: boolean
}

/** What sits at a path, without following a link. */
async function lstat(
  statPath: StatPath,
  links: LinkView | null,
  path: string,
): Promise<FileStat | null> {
  const link = links?.statAt(path) ?? null
  if (link !== null) return link
  return statPath(path)
}

/** Where one tracked path lands after a move. */
export function movedPath(move: Move, path: string): string {
  if (!move.directory) return move.destination
  return `${move.destination}${path.slice(move.source.length)}`
}

/**
 * The first path in a move that the index left unmerged.
 *
 * Named the way the collision is named, by the path itself rather than by the
 * operand that carried it, which is what git reports for a directory holding
 * one.
 */
export function conflicting(move: Move, conflicted: ReadonlySet<string>): [string, string] | null {
  for (const path of move.paths) {
    if (conflicted.has(path)) return [path, movedPath(move, path)]
  }
  return null
}

/**
 * The first path in a move that lands where an earlier one already does.
 *
 * Landings are compared one tracked path at a time rather than one operand at a
 * time, because a directory operand moves every path under it and two
 * directories sharing a child name collide there and nowhere else. git reports
 * that collision by the colliding path too, not by the operand that carried it.
 */
export function clashing(move: Move, claimed: ReadonlySet<string>): [string, string] | null {
  for (const path of move.paths) {
    const landing = movedPath(move, path)
    if (claimed.has(landing)) return [path, landing]
  }
  return null
}

/**
 * The first source that sits inside another source in the same line.
 *
 * git reads this off the whole line once every source has passed its own
 * checks, which is why a source with a fault of its own is still refused for
 * that fault first, and why `-k` skipping a source takes it out of this
 * comparison too. The pair reported is the first directory source in operand
 * order and the first source under it, named child first whatever order the
 * line put them in.
 */
export function overlapping(moves: readonly Move[]): [string, string] | null {
  for (const move of moves) {
    if (!move.directory) continue
    for (const other of moves) {
      if (inside(other.source, move.source)) return [other.source, move.source]
    }
  }
  return null
}

/**
 * Whether one source can move, in git's own order of refusals.
 *
 * The index is read before the destination is looked at, which is git's order
 * and observable: a conflicted source is refused as conflicted even when the
 * destination is occupied, and a directory holding an unmerged path is refused
 * for that rather than for a destination that already exists.
 */
export async function check(
  statPath: StatPath,
  links: LinkView | null,
  location: RepoLocation,
  source: string,
  destination: string,
  tracked: ReadonlySet<string>,
  conflicted: ReadonlySet<string>,
  force: boolean,
): Promise<Verdict> {
  const info = await lstat(statPath, links, under(location.worktree, source))
  if (info === null) return { reason: BAD_SOURCE, paths: [], directory: false }
  if (destination === source || destination.startsWith(`${source}/`)) {
    return { reason: INTO_ITSELF, paths: [], directory: false }
  }
  const landing = under(location.worktree, destination)
  if (info.type === FileType.DIRECTORY) {
    const held = [...tracked].filter((path) => inside(path, source)).sort(compareCodePoints)
    if (held.some((path) => conflicted.has(path))) {
      return { reason: CONFLICTED, paths: held, directory: true }
    }
    if ((await lstat(statPath, links, landing)) !== null) {
      return { reason: DESTINATION_ALREADY_EXISTS, paths: [], directory: true }
    }
    if (held.length === 0) return { reason: SOURCE_DIRECTORY_EMPTY, paths: [], directory: true }
    return { reason: null, paths: held, directory: true }
  }
  if (!tracked.has(source))
    return { reason: NOT_UNDER_VERSION_CONTROL, paths: [], directory: false }
  if (conflicted.has(source)) return { reason: CONFLICTED, paths: [source], directory: false }
  const target = await lstat(statPath, links, landing)
  if (target !== null && (!force || target.type === FileType.DIRECTORY)) {
    return { reason: DESTINATION_EXISTS, paths: [], directory: false }
  }
  return { reason: null, paths: [source], directory: false }
}

/**
 * Whether renaming a path would leave a mount behind.
 *
 * A mount nested in the repository is served by another resource, and the
 * rename op reaches only the backend holding the parent path: that backend
 * cannot see the child's keys, so it moves everything except them and the index
 * is then re-keyed onto files that never moved. The mount root itself is the
 * same problem one level up, since the table still points at the old prefix.
 * Neither is something the verb can repair afterwards, so both are refused
 * before anything moves.
 *
 * The destination is the same fault read from the other end, and it catches an
 * ordinary file the first two questions pass: the op is bound to the backend
 * serving the source, so a landing another mount serves is written into the
 * source's backend at a path it does not own. The file is then hidden behind
 * the other mount while the index names the new path, which is the same broken
 * pair one level down.
 */
function spanning(mounts: MountView | null, path: string, landing: string): boolean {
  if (mounts === null) return false
  if (mounts.isRoot(path) || mounts.descendants(path).length > 0) return true
  return mounts.rootOf(path) !== mounts.rootOf(landing)
}

/**
 * Decide every move before making any, which is git's order too.
 *
 * The last operand is the destination. With several sources it has to be a
 * directory that exists; with one, an existing directory takes the source
 * under its own name and anything else is the new name.
 */
export async function plan(
  statPath: StatPath,
  links: LinkView | null,
  mounts: MountView | null,
  location: RepoLocation,
  start: string,
  operands: readonly string[],
  tracked: ReadonlySet<string>,
  conflicted: ReadonlySet<string>,
  flags: MvFlags,
): Promise<Move[]> {
  const destination = repoRelative(location, start, operands[operands.length - 1] ?? '')
  const target = await lstat(statPath, links, under(location.worktree, destination))
  const into = destination === '' || target?.type === FileType.DIRECTORY
  if (operands.length > 2 && !into) throw new NotADirectoryDestinationError(destination)
  const moves: Move[] = []
  const claimed = new Set<string>()
  for (const operand of operands.slice(0, -1)) {
    const source = repoRelative(location, start, operand)
    const landing = into
      ? destination === ''
        ? basename(source)
        : `${destination}/${basename(source)}`
      : destination
    const verdict = await check(
      statPath,
      links,
      location,
      source,
      landing,
      tracked,
      conflicted,
      flags.force,
    )
    const move: Move = {
      source,
      destination: landing,
      paths: verdict.paths,
      directory: verdict.directory,
    }
    let reason = verdict.reason
    let named: [string, string] = [source, landing]
    if (reason === CONFLICTED) {
      // git names the unmerged path, which for a directory is one of the paths
      // inside rather than the operand.
      const found = conflicting(move, conflicted)
      if (found !== null) named = found
    }
    if (reason === null) {
      // Last of the per-source refusals, which is git's order: a source with a
      // fault of its own is refused for that fault even when it also collides
      // with an earlier one.
      const clash = clashing(move, claimed)
      if (clash !== null) {
        reason = MULTIPLE_SOURCES
        named = clash
      }
    }
    if (
      reason === null &&
      spanning(mounts, under(location.worktree, source), under(location.worktree, landing))
    ) {
      // Last, after every check git itself makes, so a source git would refuse
      // anyway is refused in git's own words. `-k` skips it like any other
      // rename this source cannot survive.
      if (flags.skip) continue
      throw new RenameFailedError(source, BUSY)
    }
    if (reason !== null) {
      if (flags.skip) continue
      throw new MoveRefusedError(reason, named[0], named[1])
    }
    for (const path of move.paths) claimed.add(movedPath(move, path))
    moves.push(move)
  }
  // After the per-source loop rather than inside it, which is git's order and
  // observable twice over: a source with a fault of its own outranks this, and
  // so does a same-target collision anywhere on the line. `-k` does not reach
  // it, since an overlap is not a rename this source could survive being
  // skipped for: moving the directory first is what makes the other source
  // disappear.
  const overlap = overlapping(moves)
  if (overlap !== null) throw new MoveOverlapError(overlap[0], overlap[1])
  return moves
}

/**
 * Make one move in the working tree.
 *
 * The mount's own rename, so a directory carries its untracked files along.
 * Under `-f` a file already at the destination goes first, since not every
 * mount renames over one.
 */
async function apply(
  dispatch: Dispatch,
  location: RepoLocation,
  move: Move,
  force: boolean,
): Promise<void> {
  const source = under(location.worktree, move.source)
  const destination = under(location.worktree, move.destination)
  if (force && !move.directory) await removeFile(dispatch, destination)
  try {
    await renamePath(dispatch, source, destination)
  } catch (err) {
    if (isMissingPath(err)) throw new RenameFailedError(move.source)
    throw err
  }
}

/**
 * Move or rename a file or directory, and stage the move.
 *
 * The index entries are re-keyed with their blob ids and modes untouched, which
 * is what lets `status` read the result as a rename rather than a delete beside
 * an add.
 */
export async function mv(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  const lines: string[] = []
  try {
    const dispatch = doors.dispatch
    const statPath = doors.statPath
    if (statPath === undefined || dispatch === undefined) {
      throw new NoWorkspaceError()
    }
    checkOperands(texts, UnknownSwitchError, escaped(inv.argv), switches(inv))
    const flags = parseFlags(fl)
    if (texts.length < 2) throw new MoveUsageError()
    const repo = await opened(fl, doors)
    const state = await readIndex(repo, dispatch)
    const conflicted = new Set(state.conflicts.keys())
    // An unmerged path holds no ordinary entry, so a tracked set built from the
    // entries alone would call it untracked and let a directory holding one
    // move with its stages left behind.
    const tracked = new Set([...state.entries.keys(), ...conflicted])
    const moves = await plan(
      statPath,
      doors.ns?.links ?? null,
      doors.ns?.mounts ?? null,
      repo.location,
      startPoint(fl),
      texts,
      tracked,
      conflicted,
      flags,
    )
    if (flags.dryRun) {
      for (const move of moves) {
        lines.push(`Checking rename of '${move.source}' to '${move.destination}'`)
      }
    }
    if (flags.verbose) {
      for (const move of moves) lines.push(`Renaming ${move.source} to ${move.destination}`)
    }
    if (!flags.dryRun) {
      const staged = new Map<string, StagedEntry>()
      const removed: string[] = []
      for (const move of moves) {
        await apply(dispatch, repo.location, move, flags.force)
        for (const path of move.paths) {
          const entry: IndexEntry | undefined = state.entries.get(path)
          if (entry === undefined) continue
          removed.push(path)
          staged.set(movedPath(move, path), { oid: entry.oid, mode: entry.mode, size: entry.size })
        }
      }
      await updateIndex(repo, staged, removed)
    }
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  if (lines.length === 0) return [null, new IOResult()]
  return [ENC.encode(lines.map((line) => `${line}\n`).join('')), new IOResult()]
}
