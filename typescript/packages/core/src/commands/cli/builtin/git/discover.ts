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

import type { MountRoot, StatPath } from '../../../../ops/types.ts'
import { FileType } from '../../../../types.ts'
import { parent, posixNormpath } from '../../../../utils/path.ts'
import { InvalidGitFileError, NotARepositoryError, NoWorkingDirectoryError } from './errors.ts'
import { readFile, readOptional, under } from './io.ts'
import type { Dispatch, RepoLocation } from './types.ts'

const GIT_DIR = '.git'
const GITDIR_PREFIX = 'gitdir:'
const COMMON_DIR = 'commondir'

const DEC = new TextDecoder('utf-8', { fatal: false })

/** Strip a virtual path to its canonical no-trailing-slash spelling. */
function normalize(path: string): string {
  const stripped = path.replace(/\/+$/, '')
  return stripped === '' ? '/' : stripped
}

/**
 * Resolve a path a git file names, relative to the file's directory.
 *
 * git writes either form. A submodule and a `--relative-paths` worktree point
 * relatively so the pair can be moved together; an ordinary `git worktree add`
 * writes an absolute path.
 */
function against(base: string, target: string): string {
  if (target.startsWith('/')) return normalize(target)
  return normalize(posixNormpath(`${base}/${target}`))
}

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
  gitfile: string,
): Promise<string> {
  const line = DEC.decode(await readFile(dispatch, gitfile)).trim()
  if (!line.startsWith(GITDIR_PREFIX)) throw new InvalidGitFileError(gitfile)
  const target = line.slice(GITDIR_PREFIX.length).trim()
  if (target === '') throw new InvalidGitFileError(gitfile)
  const resolved = against(parent(gitfile), target)
  if ((await statPath(resolved)) === null) {
    // An absolute pointer names a path on the backend's own filesystem, which
    // is only reachable when the mount happens to span it: a worktree mounted
    // alone cannot see the repository it was cut from. git says the same thing
    // when the target is gone.
    throw new NotARepositoryError(resolved, false)
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
async function commonDir(dispatch: Dispatch, gitdir: string): Promise<string> {
  const data = await readOptional(dispatch, under(gitdir, COMMON_DIR))
  if (data === null) return gitdir
  const target = DEC.decode(data).trim()
  return target === '' ? gitdir : against(gitdir, target)
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
  start: string,
): Promise<RepoLocation> {
  const root = normalize(mountRoot(start))
  let current = normalize(start)
  let first = true
  for (;;) {
    const candidate = under(current, GIT_DIR)
    const info = await statPath(candidate)
    if (info !== null) {
      const gitdir =
        info.type === FileType.DIRECTORY
          ? candidate
          : await followGitfile(dispatch, statPath, candidate)
      return {
        gitdir,
        commondir: await commonDir(dispatch, gitdir),
        worktree: current,
        mountRoot: root,
      }
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
      if (here === null) throw new NoWorkingDirectoryError(start)
      if (here.type !== FileType.DIRECTORY) {
        throw new NoWorkingDirectoryError(start, 'Not a directory')
      }
      first = false
    }
    if (current === root || current === '/') throw new NotARepositoryError()
    current = parent(current)
  }
}
