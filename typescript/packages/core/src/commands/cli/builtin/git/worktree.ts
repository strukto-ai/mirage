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

import { type PathSpec, FileType, type FileStat } from '../../../../types.ts'
import { mountView } from '../../../builtin/utils/links.ts'
import { GIT_DIR } from './constants.ts'
import { WorkTreeLimitError } from './errors.ts'
import { under } from './pathspec.ts'
import { type IgnoreStack, loadIgnores } from './ignore.ts'
import { lstat, readNames, readOptional } from './io.ts'
import { entryName } from '../../../../utils/remnants.ts'

import type { RepoLocation, WorkTree } from './types.ts'
import type { MountView } from '../../../../view/types.ts'
import type { Files } from '../../../../workspace/files.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

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
  readonly found: { files: Map<string, FileStat>; untracked: string[]; ignored: string[] } = {
    files: new Map(),
    untracked: [],
    ignored: [],
  }
  private readonly directories: Set<string>
  private readonly mounts: MountView | undefined
  private readonly counted = new Map<string, number>()

  constructor(
    private readonly vfs: Files,
    private readonly worktree: PathSpec,
    private readonly tracked: ReadonlySet<string>,
    private readonly mode: string,
    private readonly showIgnored = false,
    private readonly roots: readonly string[] | null = null,
  ) {
    this.directories = trackedDirectories(tracked)
    this.mounts = mountView(vfs, true)
  }

  /**
   * Whether the walk goes to a path: one a root names or holds, or a
   * directory above a root.
   */
  private reaches(relative: string): boolean {
    return (
      this.roots === null ||
      this.roots.some((root) => relative === root || under(relative, root) || under(root, relative))
    )
  }

  /**
   * Count one file against the mount serving it; past that mount's
   * `walkLimit` the scan fails with `WorkTreeLimitError`. A file a root
   * names costs nothing, as a file handed to grep does.
   */
  private count(relative: string): void {
    if (this.roots?.includes(relative) === true) return
    if (this.mounts?.walkLimit === undefined) return
    const virtual = this.absolute(relative).virtual
    const limit = this.mounts.walkLimit(virtual)
    const root = this.mounts.rootOf(virtual)
    const seen = this.counted.get(root) ?? 0
    if (limit >= 0 && seen >= limit) throw new WorkTreeLimitError(limit)
    this.counted.set(root, seen + 1)
  }

  /** The virtual path a repository-relative path names. */
  private absolute(relative: string): PathSpec {
    return relative === '' ? this.worktree : this.worktree.join(relative)
  }

  /**
   * What the walk sees at one path, without following a link.
   */
  private async entryStat(relative: string): Promise<FileStat | null> {
    return lstat(this.vfs, this.absolute(relative))
  }

  /**
   * Whether a directory holds anything git would call untracked.
   *
   * git lists a directory only when something inside it would be reported, so a
   * directory holding nothing but ignored files, or nothing at all, is not
   * mentioned. Stops at the first find.
   */
  private async holdsAFile(
    relative: string,
    ignores: IgnoreStack,
    includeIgnored = false,
  ): Promise<boolean> {
    const rules = await this.descend(relative, ignores)
    for (const entry of await readNames(this.vfs, this.absolute(relative))) {
      const name = entryName(entry)
      if (name === '') continue
      const child = relative === '' ? name : `${relative}/${name}`
      const info = await this.entryStat(child)
      if (info === null) continue
      const directory = info.type === FileType.DIRECTORY
      if (!directory) this.count(child)
      if (!includeIgnored && rules.isIgnored(child, directory)) continue
      if (!directory) return true
      if (await this.holdsAFile(child, rules, includeIgnored)) return true
    }
    return false
  }

  /** The ignore rules inside a directory, given the ones outside. */
  private async descend(relative: string, ignores: IgnoreStack): Promise<IgnoreStack> {
    if (relative === '') return ignores
    const local = await readOptional(this.vfs, this.absolute(relative).join(GITIGNORE))
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
      if (holdsTracked || (this.showIgnored && this.mode === UNTRACKED_ALL))
        await this.walk(relative, true, ignores)
      else if (
        this.showIgnored &&
        this.mode !== UNTRACKED_NO &&
        (await this.holdsAFile(relative, ignores, true))
      )
        this.found.ignored.push(`${relative}/`)
      return
    }
    if (holdsTracked || this.mode === UNTRACKED_ALL) {
      await this.walk(relative, false, ignores)
      return
    }
    if (this.showIgnored && this.mode === UNTRACKED_NORMAL) {
      const first = this.found.untracked.length,
        ignoredFirst = this.found.ignored.length
      await this.walk(relative, false, ignores)
      if (this.found.untracked.length > first)
        this.found.untracked.splice(first, Infinity, `${relative}/`)
      else if (this.found.ignored.length > ignoredFirst)
        this.found.ignored.splice(ignoredFirst, Infinity, `${relative}/`)
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
    const entries = (await readNames(this.vfs, this.absolute(relative))).sort(compareCodePoints)
    for (const entry of entries) {
      const name = entryName(entry)
      if (name === '' || (relative === '' && name === GIT_DIR)) continue
      const child = relative === '' ? name : `${relative}/${name}`
      if (!this.reaches(child)) continue
      const info = await this.entryStat(child)
      if (info === null) continue
      if (info.type === FileType.DIRECTORY) {
        await this.visitDirectory(child, ignored || rules.isIgnored(child, true), rules)
        continue
      }
      this.count(child)
      this.found.files.set(child, info)
      if (this.tracked.has(child) || this.mode === UNTRACKED_NO) continue
      if (!ignored && !rules.isIgnored(child, false)) this.found.untracked.push(child)
      else if (this.showIgnored) this.found.ignored.push(child)
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
 * @param vfs the session's files
 * @param location the discovered repository
 * @param tracked repository-relative paths the index holds
 * @param mode which untracked files to report
 * @param showIgnored whether to report ignored files too
 * @param roots narrow the walk to these repository-relative paths and what
 *   lies under them, for a verb whose pathspecs say what it reads; null walks
 *   it all
 */
export async function scan(
  vfs: Files,
  location: RepoLocation,
  tracked: ReadonlySet<string>,
  mode: string,
  showIgnored = false,
  roots: readonly string[] | null = null,
): Promise<WorkTree> {
  const ignores = await loadIgnores(vfs, location.commondir, location.worktree)
  const scanner = new Scanner(vfs, location.worktree, tracked, mode, showIgnored, roots)
  await scanner.walk('', false, ignores)
  return scanner.found
}
