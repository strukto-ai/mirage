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

import { materialize } from '../../../../io/types.ts'
import { concat } from '../../../../utils/bytes.ts'
import type { FlagView } from '../../../spec/flag_view.ts'
import type { CLIView, CLIInvocation, CLIVerbFn } from '../../types.ts'
import { discover, requireWorkTree } from './discover.ts'
import { IndexLockError, NoWorkspaceError } from './errors.ts'
import { configValues } from './fs.ts'
import { openRepo, type Repo } from './repo.ts'
import type { ReadOnlyRefusal, RepoLocation } from './types.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import { fatal, gitBool, startPoint } from './util.ts'
import { isErofs } from '../../../../errors/fs.ts'
import type { CommandFnResult } from '../../../config.ts'

const ENC = new TextEncoder()

// The ambiguity warnings each invocation collects, keyed by the view `verb`
// handed it, which are its own.
const AMBIGUOUS = new WeakMap<CLIView, string[]>()
// The repository each invocation opened, for the refusal a read-only mount
// gets in git's words.
const LOCATIONS = new WeakMap<CLIView, RepoLocation>()

/** The refusal of every verb whose first write is the index's. */
export const indexLocked: ReadOnlyRefusal = (_inv, location) =>
  new IndexLockError(location?.gitdir.virtual ?? '.git')

/**
 * A git verb whose `refname is ambiguous` warnings reach stderr, and whose
 * refusal by a read-only mount is in git's words.
 *
 * git prints the warning where it resolves the name, ahead of anything the verb
 * says after; each invocation gets a view of its own here, `opened` hands the
 * repository the list kept for them, and the lines it gathered go in front of
 * the verb's own stderr. A write a read-only mount turns down fails before
 * anything is written, so the verb's own refusal stands in for it: git's lock
 * on the index or on the ref it was about to write.
 *
 * @param fn the verb
 * @param refused the refusal git gives the verb on a read-only filesystem, null
 *   for a verb that only reads
 */
/**
 * Whether a write a read-only mount refused is one git is refused first, on the
 * lock in its own directory. git takes that lock before it touches anything
 * else, so a refused write on the mount holding the git directory, or before
 * any repository was opened (clone and init make their directory first), is
 * git's lock refusal. One elsewhere, a work tree on a read-only mount of its
 * own, is not, and keeps its own error.
 */
function gitWouldRefuse(
  inv: CLIInvocation,
  location: RepoLocation | null,
  path: string | undefined,
): boolean {
  if (location === null || path === undefined || path === '') return true
  const root = inv.view?.ns?.mounts?.rootOf(location.commondir.virtual) ?? '/'
  return [root, location.gitdir.virtual].some(
    (base) => path === base || path.startsWith(`${rstripSlash(base)}/`),
  )
}

export function verb(fn: CLIVerbFn, refused: ReadOnlyRefusal | null = null): CLIVerbFn {
  return async (inv) => {
    if (inv.view === undefined) return await fn(inv)
    const view = { ...inv.view }
    const lines: string[] = []
    AMBIGUOUS.set(view, lines)
    let result: CommandFnResult
    try {
      result = await fn({ ...inv, view })
    } catch (err) {
      const location = LOCATIONS.get(view) ?? null
      const path = (err as { virtualPath?: string }).virtualPath
      if (refused === null || !isErofs(err) || !gitWouldRefuse(inv, location, path)) throw err
      result = fatal(refused(inv, location))
    }
    if (result === null || lines.length === 0) return result
    const [out, io] = result
    io.stderr = concat([ENC.encode(lines.join('')), await materialize(io.stderr)])
    return [out, io]
  }
}

/**
 * Discover and open the repository a verb was invoked against.
 *
 * Every verb starts the same way: honor `-C`, walk up to the mount root looking
 * for a `.git`, then open the object database across the dispatcher. Kept in one
 * place so a new verb inherits the discovery rules rather than restating them.
 *
 * @param fl the leaf's flag bag, read for `-C`, `--git-dir` and `--work-tree`
 * @param view the invocation's view, one per state plane
 * @param workTree the verb reads or writes working files, so there must be a
 *   work tree to enter, as git's `NEED_WORK_TREE` asks
 */
export async function opened(fl: FlagView, view: CLIView, workTree = false): Promise<Repo> {
  const dispatch = view.dispatch
  const statPath = view.statPath
  // The mount root comes from the name plane rather than a field of its own:
  // `ns.mounts.rootOf` is the same fact the command tier reads, and a second
  // field holding the same callable is a second thing to keep in step.
  const mounts = view.ns?.mounts
  if (statPath === undefined || mounts === undefined || dispatch === undefined) {
    throw new NoWorkspaceError()
  }
  const chosen = fl.asPath('work_tree')
  const found = await discover(
    dispatch,
    statPath,
    (path: string) => mounts.rootOf(path),
    startPoint(fl),
    fl.asPath('git_dir'),
    chosen,
  )
  const location = { ...found, ns: view.ns ?? null }
  LOCATIONS.set(view, location)
  if (workTree) await requireWorkTree(dispatch, statPath, location, chosen !== undefined)
  const warn = gitBool(
    await configValues(dispatch, location, 'core.warnAmbiguousRefs'),
    'core.warnambiguousrefs',
    true,
  )
  return openRepo(dispatch, location, warn ? (AMBIGUOUS.get(view) ?? null) : null)
}
