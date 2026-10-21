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

import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { materialize } from '../../../../io/types.ts'
import { concat } from '../../../../utils/bytes.ts'
import type { FlagView } from '../../../spec/flag_view.ts'
import type { CLIVerbFn } from '../../types.ts'
import { discover, requireWorkTree } from './discover.ts'
import { GitError, IndexLockError } from './errors.ts'
import { configValues } from './fs.ts'
import { openRepo, type Repo } from './repo.ts'
import type { ReadOnlyRefusal, RepoLocation } from './types.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import { fatal, gitBool, startPoint, requireVfs } from './util.ts'
import { isErofs } from '../../../../errors/fs.ts'
import type { CommandFnResult, Context } from '../../../config.ts'

const ENC = new TextEncoder()

// The ambiguity warnings each invocation collects, keyed by the argv array
// `verb` handed it, which is its own and which a context derived from it
// (`{ ...ctx, flags }`) keeps.
const AMBIGUOUS = new WeakMap<readonly string[], string[]>()
// The repository each invocation opened, for the refusal a read-only mount
// gets in git's words.
const LOCATIONS = new WeakMap<readonly string[], RepoLocation>()

/** The refusal of every verb whose first write is the index's. */
export const indexLocked: ReadOnlyRefusal = (_texts, _ctx, location) =>
  new IndexLockError(location?.gitdir.virtual ?? '.git')

/**
 * A git verb whose `refname is ambiguous` warnings reach stderr, and whose
 * refusal by a read-only mount is in git's words.
 *
 * git prints the warning where it resolves the name, ahead of anything the verb
 * says after; each invocation gets a context of its own here, `opened` hands the
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
  ctx: Context,
  location: RepoLocation | null,
  path: string | undefined,
): boolean {
  if (location === null || path === undefined || path === '') return true
  const root = ctx.vfs?.mountOf(location.commondir) ?? '/'
  return [root, location.gitdir.virtual].some(
    (base) => path === base || path.startsWith(`${rstripSlash(base)}/`),
  )
}

/**
 * A git verb whose fatal errors are rendered as git renders them (`fatal`), so
 * no verb catches a `GitError` to render it; whose `refname is ambiguous`
 * warnings reach stderr ahead of what the verb says; and whose refusal by a
 * read-only mount is in git's words. Mirrors Python's `verb`.
 */
export function verb(
  fn: CLIVerbFn<NOOPAccessor>,
  refused: ReadOnlyRefusal | null = null,
): CLIVerbFn<NOOPAccessor> {
  return async (accessor, paths, texts, ctx) => {
    const own = { ...ctx, argv: [...(ctx.argv ?? [])] }
    const lines: string[] = []
    AMBIGUOUS.set(own.argv, lines)
    let result: CommandFnResult
    try {
      result = await fn(accessor, paths, texts, own)
    } catch (err) {
      if (err instanceof GitError) {
        result = fatal(err)
      } else {
        const location = LOCATIONS.get(own.argv) ?? null
        const path = (err as { virtualPath?: string }).virtualPath
        if (refused === null || !isErofs(err) || !gitWouldRefuse(ctx, location, path)) throw err
        result = fatal(refused(texts, ctx, location))
      }
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
 * @param ctx the line's context, one field per state plane
 * @param fl the leaf's flag bag, read for `-C`, `--git-dir` and `--work-tree`
 * @param workTree the verb reads or writes working files, so there must be a
 *   work tree to enter, as git's `NEED_WORK_TREE` asks
 */
export async function opened(ctx: Context, fl: FlagView, workTree = false): Promise<Repo> {
  // The mount root is the session's files' `mountOf`, the same answer a
  // runtime's guest gets.
  const vfs = requireVfs(ctx)
  const chosen = fl.asPath('work_tree')
  const found = await discover(vfs, startPoint(fl), fl.asPath('git_dir'), chosen)
  const location = { ...found, vfs }
  if (ctx.argv !== undefined) LOCATIONS.set(ctx.argv, location)
  if (workTree) await requireWorkTree(vfs, location, chosen !== undefined)
  const warn = gitBool(
    await configValues(vfs, location, 'core.warnAmbiguousRefs'),
    'core.warnambiguousrefs',
    true,
  )
  const lines = ctx.argv === undefined ? undefined : AMBIGUOUS.get(ctx.argv)
  return openRepo(vfs, location, warn ? (lines ?? null) : null)
}
