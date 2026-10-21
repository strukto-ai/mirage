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
import { PathSpec } from '../../../../types.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { identity } from './commit.ts'
import { HEAD } from './constants.ts'
import {
  BadRefNameUpdateError,
  DeleteHeadError,
  EmptyUpdateMessageError,
  HeadOutsideRefsError,
  InvalidSymbolicTargetError,
  NoSuchRefError,
  NotASymbolicRefError,
  NotSymbolicDeleteError,
  SymbolicRefLockError,
  SymbolicRefReadOnlyError,
  UsageError,
} from './errors.ts'
import { removeFile, writeFile } from './io.ts'

import { shortenRef } from './ref_fields.ts'
import { append, entry, logged, LOGS_DIR, ZERO } from './reflog.ts'
import {
  blockingRef,
  deleteRef,
  loadRefs,
  rawRef,
  resolveSymbolic,
  safeRefName,
  SYMREF_PREFIX,
  wholeRefName,
} from './refs.ts'
import type { Repo } from './repo.ts'
import type { ReadOnlyRefusal, RepoLocation } from './types.ts'
import { opened } from './session.ts'
import { checkSwitches, verbUsage } from './util.ts'

const ENC = new TextEncoder()
const REFS_PREFIX = 'refs/'

/**
 * The last of an option and its `--no-` twin on the line, the fallback when
 * neither is there.
 */
function switched(fl: FlagView, name: string, fallback: boolean): boolean {
  let value = fallback
  for (const [key] of fl.occurrences(name, `no_${name}`)) value = key === name
  return value
}

/**
 * The git directory a ref lives in: HEAD and the one-level names belong to the
 * checkout, every `refs/` name to the repository its worktrees share.
 */
function ownerOf(location: RepoLocation, name: string): PathSpec {
  return name === HEAD || !name.startsWith(REFS_PREFIX) ? location.gitdir : location.commondir
}

/** symbolic-ref's refusal by a read-only mount, at the lock on the ref it names. */
export const symbolicRefReadOnly: ReadOnlyRefusal = (texts, _ctx, location) => {
  const name = texts[0] ?? ''
  return new SymbolicRefReadOnlyError(
    name,
    (location === null ? PathSpec.fromStrPath('/.git') : ownerOf(location, name)).join(name)
      .virtual,
  )
}

/** The object id a ref ends at, through any symbolic hops; null for none. */
async function objectOf(
  repo: Repo,
  table: ReadonlyMap<string, string>,
  name: string,
): Promise<string | null> {
  const end = await resolveSymbolic(repo.vfs, repo.location.gitdir, table, name, true)
  if (end === null) return null
  const raw = await rawRef(repo.vfs, repo.location.gitdir, table, end.name)
  return raw === null || raw.startsWith(SYMREF_PREFIX) ? null : raw
}

/**
 * Point a ref at another one, symbolically, and log the move.
 *
 * The log line runs from what the ref resolved to before to what its new target
 * resolves to, and is skipped while that target names nothing yet, as git skips
 * it for a dangling symbolic ref. An empty message leaves the line without one.
 */
async function setSymbolic(
  repo: Repo,
  table: ReadonlyMap<string, string>,
  name: string,
  target: string,
  who: string,
  message: string,
): Promise<void> {
  if (!safeRefName(name)) throw new BadRefNameUpdateError(name)
  const held = blockingRef(new Set(table.keys()), name)
  if (held !== null) throw new SymbolicRefLockError(name, held)
  const before = await objectOf(repo, table, name)
  const owner = ownerOf(repo.location, name)
  await writeFile(repo.vfs, owner.join(name), ENC.encode(`${SYMREF_PREFIX}${target}\n`))
  const after = await objectOf(repo, table, target)
  const log = owner.join(LOGS_DIR, name)
  if (after === null || !(await logged(repo.vfs, repo.location, name, log))) return
  await append(
    repo.vfs,
    owner,
    `${LOGS_DIR}/${name}`,
    entry(before ?? ZERO, after, who, Math.floor(Date.now() / 1000), message),
  )
}

/**
 * `git symbolic-ref`: read, change or delete a symbolic ref (pinned against git
 * 2.47.3).
 *
 * One operand prints the ref it points at, followed to the end of the chain
 * unless `--no-recurse`, shortened by `--short`; a ref that is not symbolic is a
 * fatal, or a bare exit 1 under `-q`. Two operands point the first at the
 * second, which HEAD may only do inside `refs/`. `-d` removes a symbolic ref
 * and its log, never HEAD, and `-q` does not quiet its refusal.
 */
export async function symbolicRef(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  checkSwitches(ctx, texts)
  const repo = await opened(ctx, fl)
  const message = fl.asStr('m')
  if (message === '') throw new EmptyUpdateMessageError()
  const quiet = switched(fl, 'quiet', false)
  const table = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
  const [name = '', target] = texts
  if (switched(fl, 'delete', false)) {
    if (texts.length !== 1) throw new UsageError('', verbUsage(ctx))
    const found = await resolveSymbolic(repo.vfs, repo.location.gitdir, table, name, false)
    if (found === null) throw new NoSuchRefError(name)
    if (!found.symbolic) throw new NotSymbolicDeleteError(name)
    if (name === HEAD) throw new DeleteHeadError()
    const owner = ownerOf(repo.location, name)
    await deleteRef(repo.vfs, owner, name)
    await removeFile(repo.vfs, owner.join(LOGS_DIR, name))
    return [null, new IOResult()]
  }
  if (texts.length === 2 && target !== undefined) {
    if (name === HEAD && !target.startsWith(REFS_PREFIX)) throw new HeadOutsideRefsError()
    if (!wholeRefName(target)) throw new InvalidSymbolicTargetError(name, target)
    const who = identity(fl, ctx.session).line
    await setSymbolic(repo, table, name, target, who, message ?? '')
    return [null, new IOResult()]
  }
  if (texts.length !== 1) throw new UsageError('', verbUsage(ctx))
  const found = await resolveSymbolic(
    repo.vfs,
    repo.location.gitdir,
    table,
    name,
    switched(fl, 'recurse', true),
  )
  if (found === null) throw new NoSuchRefError(name)
  if (!found.symbolic) {
    if (quiet) return [null, new IOResult({ exitCode: 1 })]
    throw new NotASymbolicRefError(name)
  }
  const shown = switched(fl, 'short', false)
    ? shortenRef(found.name, new Set(table.keys()), false)
    : found.name
  return [ENC.encode(`${shown}\n`), new IOResult()]
}
