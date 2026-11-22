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

import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { visibleEntries, matched, patternRoots, repoRelative, under } from './pathspec.ts'

import { fsStrerror, isEacces } from '../../../../errors/fs.ts'
import { IOResult } from '../../../../io/types.ts'
import { FileType, type FileStat, type PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import {
  IgnoredPathsError,
  NothingSpecifiedError,
  PathspecError,
  SubmodulePathspecError,
  UnbornEmbeddedError,
  UnindexableFileError,
  UnknownPathspecError,
} from './errors.ts'
import { embeddedHead, embeddedLocation } from './embedded.ts'
import { configValues } from './fs.ts'
import { type IgnoreStack, loadIgnores } from './ignore.ts'
import { readIndex, updateIndex, type StagedEntry } from './index_file.ts'
import { entryBytes, lstat, statOf } from './io.ts'

import { repoArgs, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { EXECUTABLE, GITLINK, OWNER_EXECUTE, REGULAR, SYMLINK } from './constants.ts'
import type { IndexEntry, IndexState, RepoLocation, WorkTree } from './types.ts'
import type { Files } from '../../../../workspace/files.ts'
import { checkSwitches, gitBool, startPoint, requireVfs } from './util.ts'
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
  vfs: Files,
  location: RepoLocation,
  start: string,
  operands: readonly string[],
  found: WorkTree,
  tracked: ReadonlySet<string>,
  linked: ReadonlySet<string>,
  ignores: IgnoreStack,
  force: boolean,
): Promise<[Set<string>, Set<string>]> {
  const present = new Set(found.files.keys())
  const stage = new Set<string>()
  const remove = new Set<string>()
  const ignored: string[] = []
  for (const operand of operands) {
    const target = repoRelative(location, start, operand)
    // A path inside an embedded repository is that repository's to stage:
    // git refuses it under a gitlink the index holds and passes over it
    // otherwise (git 2.47.3).
    const holder = found.repos.find((repo) => under(target, repo))
    const gitlink = [...linked].find((path) => under(target, path))
    if (gitlink !== undefined) throw new SubmodulePathspecError(operand, gitlink)
    if (holder !== undefined) {
      if (tracked.has(holder)) throw new SubmodulePathspecError(operand, holder)
      continue
    }
    // A gitlink with no repository there (a submodule never checked out)
    // has nothing to stage.
    if (linked.has(target) && !found.repos.includes(target)) continue
    const repos = matched(found.repos, target)
    for (const repo of repos) {
      if (force || tracked.has(repo) || found.untracked.includes(`${repo}/`)) stage.add(repo)
      else if (repo === target) ignored.push(target)
    }
    const gone = [...matched(tracked, target)].filter(
      (path) => !present.has(path) && !linked.has(path) && !repos.has(path),
    )
    if (repos.has(target)) continue
    if (present.has(target)) {
      if (force || tracked.has(target) || !ignores.isIgnored(target)) stage.add(target)
      else ignored.push(target)
      continue
    }
    const hits = new Set(
      [...matched(present, target)].filter((path) => ![...linked].some((at) => under(path, at))),
    )
    if (hits.size > 0 || gone.length > 0 || repos.size > 0) {
      for (const path of force ? hits : keepAddable(hits, tracked, ignores)) stage.add(path)
      for (const path of gone) remove.add(path)
      continue
    }
    const info = await statOf(vfs, location.worktree.join(target))
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
  vfs: Files,
  entries: ReadonlyMap<string, IndexEntry>,
  found: WorkTree,
  stage: ReadonlySet<string>,
  remove: ReadonlySet<string>,
): Promise<[Map<string, StagedEntry>, string[]]> {
  const staged = new Map<string, StagedEntry>()
  const changed: [string, string][] = []
  const added: string[] = []
  for (const path of [...stage].sort(compareCodePoints)) {
    const before = entries.get(path)
    if (found.repos.includes(path)) {
      // git records an embedded repository as a gitlink to the commit it
      // has out, and adds nothing when it has none.
      const location = await embeddedLocation(vfs, repo.location.worktree.join(path))
      const head = location === null ? null : await embeddedHead(vfs, location)
      if (head === null) throw new UnbornEmbeddedError(path)
      if (before === undefined) added.push(path)
      else if (before.oid !== head || before.mode !== GITLINK) changed.push([path, 'add'])
      staged.set(path, { oid: head, mode: GITLINK, size: 0 })
      continue
    }
    const info = found.files.get(path)
    if (info === undefined) continue
    let data: Uint8Array
    try {
      data = await entryBytes(vfs, repo.location.worktree.join(path), info)
    } catch (err) {
      if (!isEacces(err)) throw err
      throw new UnindexableFileError(
        path,
        fsStrerror(err) ?? 'Permission denied',
        before !== undefined,
      )
    }
    const oid = await git.writeBlob({ ...repoArgs(repo), blob: data })
    const entry = stagedEntry(oid, info, data.length)
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
 * The gitlinks the index holds whose directory still stands: one with no
 * repository there (a submodule never checked out) stays as the index has
 * it, and one whose directory is gone is staged as deleted, as git does.
 */
async function standingGitlinks(
  vfs: Files,
  location: RepoLocation,
  state: IndexState,
  tracked: ReadonlySet<string>,
): Promise<Set<string>> {
  const standing = new Set<string>()
  for (const path of tracked) {
    if (state.entries.get(path)?.mode !== GITLINK) continue
    // lstat: a link or a file put in its place is a change to stage.
    if ((await lstat(vfs, location.worktree.join(path)))?.type === FileType.DIRECTORY)
      standing.add(path)
  }
  return standing
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
  vfs: Files,
  state: IndexState,
): Promise<[Map<string, StagedEntry>, Set<string>]> {
  const tracked = new Set(visibleEntries(repo.location, state.entries).keys())
  const found = await scan(vfs, repo.location, tracked, UNTRACKED_NO)
  const present = new Set([...found.files.keys(), ...found.repos])
  const linked = await standingGitlinks(vfs, repo.location, state, tracked)
  const kept = new Set([...tracked].filter((path) => present.has(path)))
  const removed = new Set([...tracked].filter((path) => !present.has(path) && !linked.has(path)))
  const [staged] = await stageChanges(repo, vfs, state.entries, found, kept, removed)
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
export async function add(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const vfs = requireVfs(ctx)
  checkSwitches(ctx, texts)
  const parsed = parseFlags(fl)
  if (texts.length === 0 && !parsed.every && !parsed.update) throw new NothingSpecifiedError()
  const repo: Repo = await opened(ctx, fl, true)
  const state = await readIndex(repo, vfs)
  const tracked = new Set(visibleEntries(repo.location, state.entries).keys())
  const start = startPoint(fl).virtual
  const roots = patternRoots(
    texts.map((text) => repoRelative(repo.location, start, text)),
    true,
  )
  // `-f` walks ignored directories too, as git enters them for it.
  const gitlinks = new Set([...tracked].filter((path) => state.entries.get(path)?.mode === GITLINK))
  const found = await scan(
    vfs,
    repo.location,
    tracked,
    UNTRACKED_ALL,
    parsed.force,
    roots,
    null,
    undefined,
    false,
    gitlinks,
  )
  const ignores = await loadIgnores(vfs, repo.location.commondir, repo.location.worktree)
  const present = new Set([...found.files.keys(), ...found.repos])
  const linked = await standingGitlinks(vfs, repo.location, state, tracked)
  const missing = (path: string): boolean => !present.has(path) && !linked.has(path)
  let stage: Set<string>
  let remove: Set<string>
  if (parsed.update) {
    const scope =
      texts.length > 0
        ? updateScope(repo.location, startPoint(fl).virtual, texts, tracked, present)
        : tracked
    stage = new Set([...scope].filter((path) => present.has(path)))
    remove = new Set([...scope].filter(missing))
  } else if (parsed.every && texts.length === 0) {
    // A file under a gitlink is its repository's, whatever stands there.
    const own = [...found.files.keys()].filter((path) => ![...linked].some((at) => under(path, at)))
    stage = parsed.force ? new Set([...own, ...found.repos]) : keepAddable(own, tracked, ignores)
    for (const path of found.repos)
      if (parsed.force || tracked.has(path) || found.untracked.includes(`${path}/`)) stage.add(path)
    remove = new Set([...tracked].filter(missing))
  } else {
    ;[stage, remove] = await resolve(
      vfs,
      repo.location,
      startPoint(fl).virtual,
      texts,
      found,
      tracked,
      linked,
      ignores,
      parsed.force,
    )
  }
  const [staged, lines] = await stageChanges(repo, vfs, state.entries, found, stage, remove)
  await updateIndex(repo, staged, remove)
  const embedded = [...staged]
    .filter(([path, entry]) => entry.mode === GITLINK && !state.entries.has(path))
    .map(([path]) => path)
  const warned = await embeddedWarnings(vfs, repo.location, embedded)
  const out = parsed.verbose && lines.length > 0 ? lines.map((line) => `${line}\n`).join('') : ''
  return [
    out === '' ? null : ENC.encode(out),
    new IOResult({ stderr: warned === '' ? null : ENC.encode(warned) }),
  ]
}

/**
 * git's warning for each embedded repository `add` records anew, with the
 * advice after the first unless `advice.addEmbeddedRepo` turns it off, and the
 * line saying how to turn it off unless that is already set (git 2.47.3).
 */
async function embeddedWarnings(
  vfs: Files,
  location: RepoLocation,
  paths: readonly string[],
): Promise<string> {
  if (paths.length === 0) return ''
  const values = await configValues(vfs, location, 'advice.addEmbeddedRepo')
  const advise = gitBool(values, 'advice.addembeddedrepo', true)
  return paths
    .map((path, i) => {
      const warning = `warning: adding embedded git repository: ${path}\n`
      if (i > 0 || !advise) return warning
      const hint = [
        "You've added another git repository inside your current repository.",
        'Clones of the outer repository will not contain the contents of',
        'the embedded repository and will not know how to obtain it.',
        'If you meant to add a submodule, use:',
        '',
        `\tgit submodule add <url> ${path}`,
        '',
        'If you added this path by mistake, you can remove it from the',
        'index with:',
        '',
        `\tgit rm --cached ${path}`,
        '',
        'See "git help submodule" for more information.',
        ...(values.length === 0
          ? ['Disable this message with "git config advice.addEmbeddedRepo false"']
          : []),
      ]
      return warning + hint.map((line) => (line === '' ? 'hint:\n' : `hint: ${line}\n`)).join('')
    })
    .join('')
}
