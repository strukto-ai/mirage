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
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIVerbOpts } from '../../types.ts'
import {
  BranchExistsError,
  BranchNameRequiredError,
  CheckedOutBranchError,
  GitError,
  NoBranchError,
  NoWorkspaceError,
  UnknownSwitchError,
} from './errors.ts'
import { short } from './format.ts'
import { deleteRef, loadRefs, readHead, writeRef, SYMREF_PREFIX } from './refs.ts'
import { opened, type Repo } from './repo.ts'
import { resolveCommit } from './revparse.ts'
import type { Dispatch, HeadRef } from './types.ts'
import { checkOperands, fatal } from './util.ts'

const ENC = new TextEncoder()
const HEAD = 'HEAD'
const HEADS_PREFIX = 'refs/heads/'
const REMOTES_PREFIX = 'refs/remotes/'
const CURRENT = '* '
const OTHER = '  '
const REMOTE = 'remotes/'

/**
 * The `-> target` a symbolic ref carries in a branch listing.
 *
 * `refs/remotes/origin/HEAD` is a pointer, not a branch, and git renders it as
 * `remotes/origin/HEAD -> origin/main`. Empty for an ordinary ref.
 */
function symrefSuffix(refs: ReadonlyMap<string, string>, ref: string): string {
  const raw = refs.get(ref)
  if (!raw?.startsWith(SYMREF_PREFIX)) return ''
  let target = raw.slice(SYMREF_PREFIX.length).trim()
  if (target.startsWith(REMOTES_PREFIX)) target = target.slice(REMOTES_PREFIX.length)
  return ` -> ${target}`
}

/** Point a new branch at a commit, refusing to move an existing one. */
async function create(
  dispatch: Dispatch,
  repo: Repo,
  refs: ReadonlyMap<string, string>,
  name: string,
  start: string | undefined,
): Promise<void> {
  const ref = `${HEADS_PREFIX}${name}`
  if (refs.has(ref)) throw new BranchExistsError(name)
  const oid = await resolveCommit(repo, start ?? HEAD)
  await writeRef(dispatch, repo.location.commondir, ref, oid)
}

/** Remove a branch, refusing to remove the one that is checked out. */
async function remove(
  dispatch: Dispatch,
  repo: Repo,
  refs: ReadonlyMap<string, string>,
  head: HeadRef,
  name: string,
): Promise<string> {
  const ref = `${HEADS_PREFIX}${name}`
  const sha = refs.get(ref)
  if (sha === undefined) throw new NoBranchError(name)
  if (name === head.branch) throw new CheckedOutBranchError(name, repo.location.worktree)
  await deleteRef(dispatch, repo.location.commondir, ref)
  return `Deleted branch ${name} (was ${short(sha, repo.abbrev)}).\n`
}

/**
 * List, create or delete branches.
 *
 * A name operand creates a branch, `-d` deletes one, and neither lists them with
 * the checked-out one marked. `-r` lists remote-tracking branches instead of
 * local ones and `-a` lists both, which is git's own split; local names sort
 * together and remotes follow.
 */
export async function branch(
  _config: unknown,
  _paths: PathSpec[],
  texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags)
  const remotesOnly = fl.asBool('r')
  const includeRemotes = remotesOnly || fl.asBool('a')
  let refs: ReadonlyMap<string, string>
  let head: HeadRef
  try {
    const dispatch = opts.dispatch
    if (dispatch === undefined) throw new NoWorkspaceError()
    checkOperands(texts, UnknownSwitchError)
    const repo = await opened(fl, opts.statPath, opts.mountRoot, dispatch)
    refs = await loadRefs(dispatch, repo.location.gitdir, repo.location.commondir)
    head = await readHead(dispatch, repo.location.gitdir)
    if (fl.asBool('delete')) {
      if (texts.length === 0) throw new BranchNameRequiredError()
      const parts: string[] = []
      for (const name of texts) parts.push(await remove(dispatch, repo, refs, head, name))
      return [ENC.encode(parts.join('')), new IOResult()]
    }
    const first = texts[0]
    if (first !== undefined) {
      await create(dispatch, repo, refs, first, texts[1])
      return [null, new IOResult()]
    }
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  const lines: string[] = []
  const keys = [...refs.keys()].sort()
  if (!remotesOnly) {
    for (const ref of keys.filter((k) => k.startsWith(HEADS_PREFIX))) {
      const name = ref.slice(HEADS_PREFIX.length)
      lines.push(`${name === head.branch ? CURRENT : OTHER}${name}`)
    }
  }
  if (includeRemotes) {
    for (const ref of keys.filter((k) => k.startsWith(REMOTES_PREFIX))) {
      const name = ref.slice(REMOTES_PREFIX.length)
      lines.push(`${OTHER}${REMOTE}${name}${symrefSuffix(refs, ref)}`)
    }
  }
  if (lines.length === 0) return [null, new IOResult()]
  return [ENC.encode(`${lines.join('\n')}\n`), new IOResult()]
}
