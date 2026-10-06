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

import type { PathSpec } from '../../../../types.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { GitError } from './errors.ts'
import { resolveCommit } from './revparse.ts'
import { opened } from './session.ts'
import { checkOperands, fatal, maybeBool } from './util.ts'
import { readOptional, writeFile } from './io.ts'
import { joinSpec } from '../../../../utils/path.ts'
import { HEAD } from './constants.ts'
import { isBare } from './discover.ts'
import { configValues } from './fs.ts'
import type { Dispatch, RepoLocation } from './types.ts'

const LOGS_DIR = 'logs'
const HEAD_LOG = 'logs/HEAD'
export const ZERO = '0'.repeat(40)
// What a move of HEAD or a new branch records in the reflog. There is no
// committer there, only a ref moving, so the stated identity commit uses is
// reused.
export const IDENTITY = 'mirage <mirage@localhost>'

const ENC = new TextEncoder()

/**
 * One reflog line, in git's own format.
 *
 * `<old> <new> <identity> <epoch> <offset>\t<message>`, with the old id all
 * zeroes when there was nothing there before. The tab is load-bearing: it is
 * what separates the fixed fields from a message that may itself contain spaces.
 * An empty message leaves the tab out, as git does.
 *
 * @param before the id the ref held, zeroes when it held none
 * @param after the id it now holds
 * @param who the identity, `Name <email>`
 * @param when epoch seconds
 * @param message what happened, e.g. `commit: add delta`
 */
export function entry(
  before: string,
  after: string,
  who: string,
  when: number,
  message: string,
): Uint8Array {
  const tail = message === '' ? '' : `\t${message}`
  return ENC.encode(`${before} ${after} ${who} ${String(when)} +0000${tail}\n`)
}

/**
 * Add one line to a reflog, creating it if it is not there.
 *
 * Read-modify-write rather than an append op, because not every backend offers
 * one and a reflog is small. Losing the history here would only cost the `@{n}`
 * syntax, but `git branch` reads it to say where a detached HEAD detached from,
 * so an absent log makes a perfectly good checkout read as `(no branch)`.
 */
export async function append(
  dispatch: Dispatch,
  gitdir: PathSpec,
  path: string,
  line: Uint8Array,
): Promise<void> {
  const target = joinSpec(gitdir, path)
  const existing = (await readOptional(dispatch, target)) ?? new Uint8Array(0)
  const merged = new Uint8Array(existing.length + line.length)
  merged.set(existing)
  merged.set(line, existing.length)
  await writeFile(dispatch, target, merged)
}

const LOGGED_PREFIXES = ['refs/heads/', 'refs/remotes/', 'refs/notes/']

/**
 * Whether an update to a ref is logged: always where its log already exists,
 * and otherwise as `core.logAllRefUpdates` says, which defaults to HEAD and the
 * branch, remote and notes refs outside a bare repository, and to nothing in
 * one (`should_autocreate_reflog`).
 *
 * @param dispatch workspace op dispatcher
 * @param location the discovered repository
 * @param name the full ref name
 * @param log the path of its log
 */
export async function logged(
  dispatch: Dispatch,
  location: RepoLocation,
  name: string,
  log: PathSpec,
): Promise<boolean> {
  if ((await readOptional(dispatch, log)) !== null) return true
  const value = (await configValues(dispatch, location, 'core.logAllRefUpdates')).at(-1)
  if (value?.toLowerCase() === 'always') return true
  const normal =
    value === undefined ? !(await isBare(dispatch, location)) : (maybeBool(value) ?? false)
  return normal && (name === HEAD || LOGGED_PREFIXES.some((prefix) => name.startsWith(prefix)))
}

/**
 * Record one move of HEAD, and of the branch it is on.
 *
 * git writes both logs on every update: `logs/HEAD` always, and the branch's own
 * log when HEAD is attached to one. Both carry the same line. HEAD's log belongs
 * to the checkout and a branch's to the repository, so a linked worktree splits
 * them the way git does.
 *
 * @param dispatch workspace op dispatcher
 * @param gitdir this checkout's git directory, which owns HEAD's log
 * @param commondir the shared git directory, which owns the branches' logs
 * @param ref the branch ref that also moved, null when HEAD is detached
 * @param before the id HEAD held, null when it held none
 * @param after the id it now holds
 * @param who the identity to record
 * @param when epoch seconds
 * @param message what happened
 */
export async function record(
  dispatch: Dispatch,
  gitdir: PathSpec,
  commondir: PathSpec,
  ref: string | null,
  before: string | null,
  after: string,
  who: string,
  when: number,
  message: string,
): Promise<void> {
  const line = entry(before ?? ZERO, after, who, when, message)
  await append(dispatch, gitdir, HEAD_LOG, line)
  if (ref !== null) await append(dispatch, commondir, `${LOGS_DIR}/${ref}`, line)
}

/** A ref's reflog, from the git directory that owns it. */
async function logOf(
  dispatch: Dispatch,
  location: RepoLocation,
  ref: string,
): Promise<Uint8Array | null> {
  const root = ref === HEAD ? location.gitdir : location.commondir
  return readOptional(dispatch, joinSpec(root, LOGS_DIR, ref))
}

/**
 * The log a reflog walk reads, and the name its rows print.
 *
 * As git's `read_complete_reflog` then `dwim_log`: the name as typed, then
 * under `refs/` and `refs/heads/`, keep the spelling; only a log found by the
 * full rev-parse rules (a tag, a remote) is printed by its full name (git
 * 2.47.3 and 2.50.1).
 */
async function namedLog(
  dispatch: Dispatch,
  location: RepoLocation,
  revision: string,
): Promise<[string, Uint8Array | null]> {
  for (const ref of [revision, `refs/${revision}`, `refs/heads/${revision}`]) {
    const data = await logOf(dispatch, location, ref)
    if (data?.length) return [revision, data]
  }
  for (const ref of [
    `refs/tags/${revision}`,
    `refs/remotes/${revision}`,
    `refs/remotes/${revision}/HEAD`,
  ]) {
    const data = await logOf(dispatch, location, ref)
    if (data?.length) return [ref, data]
  }
  return [revision, null]
}

/** Read a ref's log newest first through the dispatcher. */
export async function reflog(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    const texts = inv.texts[0] === 'show' ? inv.texts.slice(1) : inv.texts
    checkOperands(inv, texts)
    const repo = await opened(fl, inv.doors ?? {})
    const revision = texts[0] ?? HEAD
    await resolveCommit(repo, revision)
    const [name, data] = await namedLog(repo.dispatch, repo.location, revision)
    let rows = new TextDecoder()
      .decode(data ?? new Uint8Array())
      .split('\n')
      .filter(Boolean)
      .reverse()
    const limit = fl.asInt('max_count')
    if (limit !== undefined && limit >= 0) rows = rows.slice(0, limit)
    const out = rows
      .map((row, index) => {
        const tab = row.indexOf('\t')
        const fields = tab === -1 ? row : row.slice(0, tab)
        const message = tab === -1 ? '' : row.slice(tab + 1)
        const oid = fields.split(' ')[1] ?? ''
        return `${oid.slice(0, repo.abbrev)} ${name}@{${String(index)}}: ${message}\n`
      })
      .join('')
    return [ENC.encode(out), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
