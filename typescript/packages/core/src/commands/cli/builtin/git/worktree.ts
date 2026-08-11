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

import type { StatPath } from '../../../../ops/types.ts'
import { FileType, type FileStat } from '../../../../types.ts'
import type { IgnoreStack } from './ignore.ts'
import { loadIgnores } from './ignore.ts'
import { readNames, readOptional, under } from './io.ts'
import { basename } from './path.ts'
import type { Dispatch, RepoLocation, WorkTree } from './types.ts'

const GIT_DIR = '.git'
const GITIGNORE = '.gitignore'

// git's three untracked modes. "normal" names an untracked directory once
// instead of everything inside it, "all" names every file, and "no" leaves them
// out and is the reason the mode is threaded into the walk rather than filtered
// afterwards: not reporting them means not looking for them, which is the whole
// saving.
export const UNTRACKED_NO = 'no'
export const UNTRACKED_NORMAL = 'normal'
export const UNTRACKED_ALL = 'all'

/**
 * Every directory that holds a tracked path, at any depth.
 *
 * Answering "does this directory contain anything tracked" per directory would
 * rescan the index once per directory walked; the same question asked of a
 * prepared set is a lookup.
 */
function trackedDirectories(tracked: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>()
  for (const path of tracked) {
    const parts = path.split('/').slice(0, -1)
    for (let depth = 0; depth < parts.length; depth++) {
      directories.add(parts.slice(0, depth + 1).join('/'))
    }
  }
  return directories
}

/** One walk of the working tree, carrying what the walk needs. */
class Scanner {
  readonly found: { files: Map<string, FileStat>; untracked: string[] } = {
    files: new Map(),
    untracked: [],
  }
  private readonly directories: Set<string>

  constructor(
    private readonly dispatch: Dispatch,
    private readonly statPath: StatPath,
    private readonly worktree: string,
    private readonly tracked: ReadonlySet<string>,
    private readonly mode: string,
  ) {
    this.directories = trackedDirectories(tracked)
  }

  /** The virtual path a repository-relative path names. */
  private absolute(relative: string): string {
    return relative === '' ? this.worktree : under(this.worktree, relative)
  }

  /**
   * Whether a directory holds anything git would call untracked.
   *
   * git lists a directory only when something inside it would be reported, so a
   * directory holding nothing but ignored files, or nothing at all, is not
   * mentioned. Stops at the first find.
   */
  private async holdsAFile(relative: string, ignores: IgnoreStack): Promise<boolean> {
    const rules = await this.descend(relative, ignores)
    for (const entry of await readNames(this.dispatch, this.absolute(relative))) {
      const name = basename(entry)
      if (name === '') continue
      const child = relative === '' ? name : `${relative}/${name}`
      const info = await this.statPath(this.absolute(child))
      if (info === null) continue
      const directory = info.type === FileType.DIRECTORY
      if (rules.isIgnored(child, directory)) continue
      if (!directory) return true
      if (await this.holdsAFile(child, rules)) return true
    }
    return false
  }

  /** The ignore rules inside a directory, given the ones outside. */
  private async descend(relative: string, ignores: IgnoreStack): Promise<IgnoreStack> {
    if (relative === '') return ignores
    const local = await readOptional(this.dispatch, under(this.absolute(relative), GITIGNORE))
    return local === null ? ignores : ignores.push(relative, local)
  }

  /**
   * Decide what a subdirectory contributes, then walk it or not.
   *
   * An ignored directory is still walked when the index holds something inside
   * it. Ignore rules govern untracked files only, so a tracked file under an
   * ignored directory is still compared, and skipping the directory outright
   * would report it deleted.
   */
  private async visitDirectory(
    relative: string,
    ignored: boolean,
    ignores: IgnoreStack,
  ): Promise<void> {
    const holdsTracked = this.directories.has(relative)
    if (ignored) {
      if (holdsTracked) await this.walk(relative, true, ignores)
      return
    }
    if (holdsTracked || this.mode === UNTRACKED_ALL) {
      await this.walk(relative, false, ignores)
      return
    }
    if (this.mode === UNTRACKED_NORMAL && (await this.holdsAFile(relative, ignores))) {
      this.found.untracked.push(`${relative}/`)
    }
  }

  /**
   * Walk one directory, recording files and untracked entries.
   *
   * @param relative repository-relative path, empty at the root
   * @param ignored whether this directory is itself ignored, in which case
   *   nothing inside it is reported untracked
   * @param ignores the rules governing its parent
   */
  async walk(relative: string, ignored: boolean, ignores: IgnoreStack): Promise<void> {
    const rules = await this.descend(relative, ignores)
    const entries = (await readNames(this.dispatch, this.absolute(relative))).sort()
    for (const entry of entries) {
      const name = basename(entry)
      if (name === '' || (relative === '' && name === GIT_DIR)) continue
      const child = relative === '' ? name : `${relative}/${name}`
      const info = await this.statPath(this.absolute(child))
      if (info === null) continue
      if (info.type === FileType.DIRECTORY) {
        await this.visitDirectory(child, ignored || rules.isIgnored(child, true), rules)
        continue
      }
      this.found.files.set(child, info)
      if (this.tracked.has(child) || this.mode === UNTRACKED_NO) continue
      if (!ignored && !rules.isIgnored(child, false)) this.found.untracked.push(child)
    }
  }
}

/**
 * Walk a working tree once, for both halves of a status report.
 *
 * One walk answers two questions, which is why they are not asked separately:
 * which tracked files still exist and how big they are, and which untracked ones
 * git would mention. Statting each index path instead would miss every untracked
 * file, and listing untracked files alone would leave the deletions unfound.
 *
 * @param dispatch workspace op dispatcher
 * @param statPath dispatcher-backed stat, both channels
 * @param location the discovered repository
 * @param tracked repository-relative paths the index holds
 * @param mode which untracked files to report
 */
export async function scan(
  dispatch: Dispatch,
  statPath: StatPath,
  location: RepoLocation,
  tracked: ReadonlySet<string>,
  mode: string,
): Promise<WorkTree> {
  const ignores = await loadIgnores(dispatch, location.gitdir, location.worktree)
  const scanner = new Scanner(dispatch, statPath, location.worktree, tracked, mode)
  await scanner.walk('', false, ignores)
  return scanner.found
}
