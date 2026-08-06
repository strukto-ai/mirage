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

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  BranchExistsError,
  BranchNameRequiredError,
  CheckedOutBranchError,
  GitError,
  NoBranchError,
  NoWorkspaceError,
  UnknownSwitchError,
  UnmergedBranchError,
} from './errors.ts'
import { short } from './format.ts'
import { deleteRef, loadRefs, readHead, writeRef, SYMREF_PREFIX } from './refs.ts'
import { opened, repoArgs, type Repo } from './repo.ts'
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

/**
 * The commit HEAD resolves to, null on an unborn branch.
 *
 * HEAD carries an object id only when detached; attached it names a ref, which
 * is unset until the first commit.
 */
function headCommit(refs: ReadonlyMap<string, string>, head: HeadRef): string | null {
  if (head.commit !== null) return head.commit
  if (head.ref === null) return null
  return refs.get(head.ref) ?? null
}

/**
 * Whether HEAD already holds every commit a branch points at.
 *
 * An unborn HEAD holds nothing, which is git's answer too: on an orphan branch
 * every other branch reads as unmerged. The equality case is handled here
 * because isomorphic-git's `isDescendent` answers false for a commit compared
 * with itself, by its own documented choice.
 *
 * Only HEAD is consulted. git also accepts a branch contained in its own
 * upstream, and there are no remotes here to have one.
 */
async function merged(repo: Repo, tip: string, head: string | null): Promise<boolean> {
  if (head === null) return false
  if (head === tip) return true
  return await git.isDescendent({ ...repoArgs(repo), oid: head, ancestor: tip, depth: -1 })
}

/** Remove a branch, refusing when the removal would lose commits. */
async function remove(
  dispatch: Dispatch,
  repo: Repo,
  refs: ReadonlyMap<string, string>,
  head: HeadRef,
  name: string,
  force: boolean,
): Promise<string> {
  const ref = `${HEADS_PREFIX}${name}`
  const sha = refs.get(ref)
  if (sha === undefined) throw new NoBranchError(name)
  if (name === head.branch) throw new CheckedOutBranchError(name, repo.location.worktree)
  if (!force && !(await merged(repo, sha, headCommit(refs, head)))) {
    throw new UnmergedBranchError(name)
  }
  await deleteRef(dispatch, repo.location.commondir, ref)
  return `Deleted branch ${name} (was ${short(sha, repo.abbrev)}).\n`
}

/**
 * List, create or delete branches.
 *
 * A name operand creates a branch, `-d` deletes one, and neither lists them with
 * the checked-out one marked. `-d` deletes only a branch HEAD already contains,
 * and `-D` deletes one regardless, which is git's own split and the reason both
 * are here: without `-D` there is nothing `-d` can refuse to do. `-r` lists
 * remote-tracking branches instead of local ones and `-a` lists both; local
 * names sort together and remotes follow.
 */
export async function branch(inv: CLIInvocation): Promise<CommandFnResult> {
  // The mount doors ride the one record; `opts` keeps its name so
  // the body reads the same as when they were a parameter.
  const opts = inv.ops ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
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
    const force = fl.asBool('D')
    if (fl.asBool('delete') || force) {
      if (texts.length === 0) throw new BranchNameRequiredError()
      const parts: string[] = []
      for (const name of texts) parts.push(await remove(dispatch, repo, refs, head, name, force))
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
