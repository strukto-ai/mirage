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

import { configValues } from './fs.ts'
import type { MountRoot, StatPath } from '../../../../ops/types.ts'
import { GIT_DIR } from './constants.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import {
  InvalidGitFileError,
  NotARepositoryError,
  NotAWorkTreeError,
  NoWorkingDirectoryError,
  WorkTreeChdirError,
} from './errors.ts'
import { readFile, readOptional } from './io.ts'
import type { Dispatch, RepoLocation } from './types.ts'
import { gitBool } from './util.ts'

const GITDIR_PREFIX = 'gitdir:'
const COMMON_DIR = 'commondir'

const DEC = new TextDecoder('utf-8', { fatal: false })

/**
 * Read a `.git` file and return the directory it points at.
 *
 * A `.git` that is a file rather than a directory holds one `gitdir: <path>`
 * line. git writes one for every linked worktree (`git worktree add`) and every
 * submodule, so the real git directory sits outside the tree being worked in,
 * and reading the file as if it were a directory is how this used to fail.
 */
async function followGitfile(
  dispatch: Dispatch,
  statPath: StatPath,
  gitfile: PathSpec,
): Promise<PathSpec> {
  const line = DEC.decode(await readFile(dispatch, gitfile)).trim()
  if (!line.startsWith(GITDIR_PREFIX)) throw new InvalidGitFileError(gitfile.virtual)
  const target = line.slice(GITDIR_PREFIX.length).trim()
  if (target === '') throw new InvalidGitFileError(gitfile.virtual)
  const resolved = PathSpec.fromStrPath(target, undefined, gitfile.parent)
  if ((await statPath(resolved)) === null) {
    // An absolute pointer names a path on the backend's own filesystem, which
    // is only reachable when the mount happens to span it: a worktree mounted
    // alone cannot see the repository it was cut from. git says the same thing
    // when the target is gone.
    throw new NotARepositoryError(resolved.virtual, false)
  }
  return resolved
}

/**
 * The shared git directory behind a per-worktree one.
 *
 * A linked worktree's git directory carries a `commondir` file naming the
 * repository it belongs to, usually as `../..`. Objects, packed-refs and
 * branches live there; only HEAD and the index are the worktree's own. An
 * ordinary checkout has no such file and is its own common directory.
 */
async function commonDir(dispatch: Dispatch, gitdir: PathSpec): Promise<PathSpec> {
  const data = await readOptional(dispatch, gitdir.join(COMMON_DIR))
  if (data === null) return gitdir
  const target = DEC.decode(data).trim()
  return target === '' ? gitdir : PathSpec.fromStrPath(target, undefined, gitdir)
}

/**
 * git's `is_git_directory`: the common directory, or null.
 *
 * A git directory holds its own HEAD and finds objects and refs in its common
 * directory, which is itself unless it is a linked worktree's.
 */
async function validated(
  dispatch: Dispatch,
  statPath: StatPath,
  gitdir: PathSpec,
): Promise<PathSpec | null> {
  const common = await commonDir(dispatch, gitdir)
  for (const [path, kind] of [
    [gitdir.join('HEAD'), FileType.FILE],
    [common.join('objects'), FileType.DIRECTORY],
    [common.join('refs'), FileType.DIRECTORY],
  ] as const) {
    const entry = await statPath(path)
    if (entry?.type !== kind) return null
  }
  return common
}

/**
 * Find the repository governing a path, or throw git's own fatal.
 *
 * Walks up from `start` looking for a `.git` entry, stopping at the mount root.
 * Real git stops discovery at a filesystem boundary unless
 * GIT_DISCOVERY_ACROSS_FILESYSTEM is set, and a mount prefix is exactly that
 * boundary: crossing it would probe a different backend for a repository that
 * has nothing to do with the operand.
 *
 * Existence comes from `statPath` rather than one backend's stat because on a
 * prefix store a directory is not an object: `.git` answers on readdir while a
 * point lookup misses it entirely. That is the same fact `find` asks about its
 * own start point.
 *
 * What is found is not always the git directory. A `.git` file points at one
 * elsewhere, and the directory it points at may share its objects with another,
 * so the three paths are resolved here and carried separately rather than
 * derived again by each verb.
 *
 * @param dispatch workspace op dispatcher, for the two files that redirect a git
 *   directory
 * @param statPath dispatcher-backed stat asking both channels a backend can
 *   answer on; null means nothing is there
 * @param mountRoot the mount prefix serving a path
 * @param start absolute virtual path to start from, normally the session cwd or
 *   the argument of `-C`
 */
export async function discover(
  dispatch: Dispatch,
  statPath: StatPath,
  mountRoot: MountRoot,
  start: PathSpec,
  gitdir: PathSpec | null = null,
  worktree: PathSpec | null = null,
): Promise<RepoLocation> {
  const root = PathSpec.fromStrPath(mountRoot(start.virtual), undefined, '/')
  if (gitdir !== null) {
    const here = await statPath(start)
    if (here === null)
      throw new NoWorkingDirectoryError(start.dotted ? start.rawPath : start.virtual)
    if (here.type !== FileType.DIRECTORY)
      throw new NoWorkingDirectoryError(
        start.dotted ? start.rawPath : start.virtual,
        'Not a directory',
      )
    const candidate = gitdir
    const info = await statPath(candidate)
    if (info === null) throw new NotARepositoryError(gitdir.rawPath)
    // git names the target a pointer leads to unquoted, as it does for one met
    // on the way up.
    const pointer = info.type !== FileType.DIRECTORY
    const resolved = pointer ? await followGitfile(dispatch, statPath, candidate) : candidate
    const common = await validated(dispatch, statPath, resolved)
    if (common === null) {
      throw pointer
        ? new NotARepositoryError(resolved.virtual, false)
        : new NotARepositoryError(gitdir.rawPath)
    }
    return location(dispatch, statPath, resolved, common, start, worktree, root)
  }
  let current = start
  let first = true
  for (;;) {
    const candidate = current.join(GIT_DIR)
    const info = await statPath(candidate)
    if (info !== null) {
      const gitdir =
        info.type === FileType.DIRECTORY
          ? candidate
          : await followGitfile(dispatch, statPath, candidate)
      return location(
        dispatch,
        statPath,
        gitdir,
        await commonDir(dispatch, gitdir),
        current,
        worktree,
        root,
      )
    }
    if (first) {
      // git enters `-C` before it looks for anything, so a path it cannot
      // enter fails on its own terms even when a directory above it holds a
      // repository. A file counts as one it cannot enter: tolerating it would
      // walk up and run in the parent repository, which for a write verb means
      // mutating a repository the caller did not name. Asked only after the
      // first probe missed, because a hit already proves the directory is
      // there.
      const here = await statPath(current)
      if (here === null)
        throw new NoWorkingDirectoryError(start.dotted ? start.rawPath : start.virtual)
      if (here.type !== FileType.DIRECTORY) {
        throw new NoWorkingDirectoryError(
          start.dotted ? start.rawPath : start.virtual,
          'Not a directory',
        )
      }
      first = false
    }
    if (current.virtual === root.virtual || current.virtual === '/') throw new NotARepositoryError()
    current = current.parent
  }
}

/**
 * Resolve the work tree once for every verb, after locating metadata.
 *
 * CLI/environment paths are relative to -C; core.worktree is relative to the
 * git directory, as in native git 2.54.0, which enters a relative one before
 * any verb runs. A bare repository keeps the default, and only a verb that
 * needs a work tree refuses it (`requireWorkTree`). git parses core.bare
 * whichever tree wins, so a value it cannot read fails every verb, a named work
 * tree and a linked worktree included. Divergence: the `config.worktree` that
 * `extensions.worktreeConfig` adds is not read, so a linked worktree never takes
 * either key; and a bare repository that also names a core.worktree stays bare
 * without git's "do not make sense" warning. Mirrors _location in discover.py.
 */
async function location(
  dispatch: Dispatch,
  statPath: StatPath,
  gitdir: PathSpec,
  common: PathSpec,
  defaultWorktree: PathSpec,
  worktree: PathSpec | null,
  root: PathSpec,
): Promise<RepoLocation> {
  const located: RepoLocation = {
    gitdir,
    commondir: common,
    worktree: defaultWorktree,
    mountRoot: root,
  }
  const bare = gitBool(await configValues(dispatch, located, 'core.bare'), 'core.bare', false)
  if (worktree !== null) return { ...located, worktree }
  if (gitdir.virtual !== common.virtual || bare) return located
  const configured = (await configValues(dispatch, located, 'core.worktree')).at(-1)
  if (configured === undefined) return located
  const selected = PathSpec.fromStrPath(configured, undefined, gitdir)
  if (!configured.startsWith('/')) {
    const info = await statPath(selected)
    if (info === null) throw new WorkTreeChdirError(configured)
    if (info.type !== FileType.DIRECTORY)
      throw new WorkTreeChdirError(configured, 'Not a directory')
  }
  return { ...located, worktree: selected }
}

/**
 * Whether core.bare leaves the repository without a work tree.
 *
 * git reads core.bare, like core.worktree, only from a repository's own config,
 * and a linked worktree's config is its repository's, so a linked worktree is
 * never bare. A named work tree overrides it.
 */
export async function isBare(dispatch: Dispatch, location: RepoLocation): Promise<boolean> {
  if (location.gitdir.virtual !== location.commondir.virtual) return false
  return gitBool(await configValues(dispatch, location, 'core.bare'), 'core.bare', false)
}

/**
 * git's `setup_work_tree`: refuse when there is no tree to enter.
 *
 * Asked by every verb that reads or writes working files, so a bare repository
 * or a mistyped `--work-tree` is refused rather than read as a tree with every
 * file deleted.
 *
 * @param named `--work-tree` or `GIT_WORK_TREE` chose the tree
 */
export async function requireWorkTree(
  dispatch: Dispatch,
  statPath: StatPath,
  location: RepoLocation,
  named: boolean,
): Promise<void> {
  if (!named && (await isBare(dispatch, location))) throw new NotAWorkTreeError()
  const info = await statPath(location.worktree)
  if (info?.type !== FileType.DIRECTORY) throw new NotAWorkTreeError()
}
