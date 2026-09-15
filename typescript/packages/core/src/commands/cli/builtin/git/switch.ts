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
import { moveHead, previousPosition } from './checkout.ts'
import { HEAD } from './constants.ts'
import {
  BranchExistsError,
  BranchExpectedError,
  DetachWithCreateError,
  GitError,
  InvalidBranchNameError,
  InvalidReferenceError,
  MissingBranchArgumentError,
  NoWorkspaceError,
  OneReferenceError,
  RefLockError,
  UnknownSwitchError,
} from './errors.ts'
import { short } from './format.ts'
import { readIndex, refuseUnresolved } from './index_file.ts'
import {
  BRANCH_PREFIX,
  blockingRef,
  loadRefs,
  readHead,
  setHead,
  TAG_PREFIX,
  validRefName,
} from './refs.ts'
import { opened, repoArgs } from './repo.ts'
import { resolveCommit } from './revparse.ts'
import { checkOperands, escaped, fatal, switches } from './util.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

const ENC = new TextEncoder()
const REMOTES_PREFIX = 'refs/remotes/'
const COMMIT = 'commit'
const TAG = 'tag'
const REMOTE_BRANCH = 'remote branch'

/** The parsed shape of a `git switch` invocation. */
interface SwitchFlags {
  /** `-c`, the branch to create and switch to. */
  readonly create: string | undefined
  /** `--detach`, leave HEAD on the commit itself. */
  readonly detach: boolean
}

/** Read the raw switch flag kwargs into a frozen struct. */
function parseFlags(fl: FlagView): SwitchFlags {
  return { create: fl.asStr('create'), detach: fl.asBool('detach') }
}

/**
 * What a non-branch operand named, for the refusal that says so.
 *
 * git tells a tag and a remote-tracking branch apart from a bare commit in the
 * same sentence, so the refusal can say which one the caller reached for.
 */
export function expectedKind(known: ReadonlyMap<string, string>, name: string): string {
  if (known.has(`${TAG_PREFIX}${name}`)) return TAG
  if (known.has(`${REMOTES_PREFIX}${name}`)) return REMOTE_BRANCH
  return COMMIT
}

/**
 * Switch to a branch, creating it under `-c`.
 *
 * The same move `checkout` makes, with a narrower grammar: only a branch is
 * accepted, so a commit, tag or remote-tracking name is refused unless
 * `--detach` says that a detached HEAD is what was meant. That is the whole
 * reason git split the verb off, and it holds here for the same reason: a
 * detached HEAD is the state an agent loses commits in.
 */
export async function switchBranch(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  let carried: string
  let note: string
  try {
    const dispatch = doors.dispatch
    const statPath = doors.statPath
    if (statPath === undefined || dispatch === undefined) {
      throw new NoWorkspaceError()
    }
    checkOperands(texts, UnknownSwitchError, escaped(inv.argv), switches(inv))
    const flags = parseFlags(fl)
    const creating = flags.create !== undefined
    if (creating && flags.detach) throw new DetachWithCreateError()
    if (texts.length > 1) throw new OneReferenceError()
    const first = texts[0]
    // A detach takes HEAD when nothing is named, which is git's own default;
    // only an attaching switch needs a branch to name.
    if (!creating && first === undefined && !flags.detach) {
      throw new MissingBranchArgumentError()
    }
    const repo = await opened(fl, doors)
    const head = await readHead(dispatch, repo.location.gitdir)
    const known = await loadRefs(dispatch, repo.location.gitdir, repo.location.commondir)
    let target: string
    let oid: string
    let attached: boolean
    let startPoint: string | undefined
    if (flags.create !== undefined) {
      target = flags.create
      if (known.has(`${BRANCH_PREFIX}${target}`)) throw new BranchExistsError(target)
      startPoint = first
      const start = first ?? HEAD
      // Before the first commit there is nothing for HEAD to resolve to, and
      // git makes the branch anyway: the line only repoints symbolic HEAD,
      // writing neither the ref nor a reflog line, because a branch with no
      // commit is a name and nothing else. A start point is a different line
      // and stays unresolvable (`fatal: invalid reference: main`), so this
      // reads the shape of the line rather than probing HEAD. Pinned against
      // git 2.50.1.
      const unborn = first === undefined && head.ref !== null && !known.has(head.ref)
      oid = ''
      if (!unborn) {
        try {
          oid = await resolveCommit(repo, start)
        } catch {
          throw new InvalidReferenceError(start)
        }
      }
      // After the start point and before anything is written, which is git's
      // own order. A ref is a path below .git, so an unchecked name reaches
      // writeRef as one: -c ../../config would land on the repository's own
      // configuration rather than on a branch.
      if (!validRefName(target)) throw new InvalidBranchNameError(target)
      // And before the working tree moves: git takes the ref lock first, so a
      // name whose path another ref holds refuses with nothing checked out.
      const held = blockingRef(new Set(known.keys()), `${BRANCH_PREFIX}${target}`)
      if (held !== null) throw new RefLockError(`${BRANCH_PREFIX}${target}`, held)
      attached = true
      if (unborn) {
        await setHead(dispatch, repo.location.gitdir, `${BRANCH_PREFIX}${target}`)
        return [
          ENC.encode(''),
          new IOResult({ stderr: ENC.encode(`Switched to a new branch '${target}'\n`) }),
        ]
      }
    } else {
      target = first ?? HEAD
      // The ref has to exist, not just be the name HEAD carries. A fresh
      // repository's HEAD names a branch that has never been written, and
      // reading the name alone answered `Already on 'main'` at exit 0 for a
      // branch with no commit to be on. git resolves it first and dies, which
      // is what leaves `switch -c` as the only line an unborn HEAD accepts.
      // Pinned against git 2.50.1.
      if (!flags.detach && target === head.branch && known.has(`${BRANCH_PREFIX}${target}`)) {
        // Moving nothing is not the same as having nothing to check: git dies
        // on an unresolved index here too, so the shortcut reads it before it
        // answers. Every ref check above comes first, which is git's own order.
        refuseUnresolved(await readIndex(repo, dispatch))
        return [null, new IOResult({ stderr: ENC.encode(`Already on '${target}'\n`) })]
      }
      try {
        oid = await resolveCommit(repo, target)
      } catch {
        throw new InvalidReferenceError(target)
      }
      attached = !flags.detach && known.has(`${BRANCH_PREFIX}${target}`)
      if (!flags.detach && !attached) {
        throw new BranchExpectedError(expectedKind(known, target), target)
      }
    }
    const moved = await moveHead(
      dispatch,
      statPath,
      doors.ns?.links ?? null,
      doors.ns?.mounts ?? null,
      repo,
      known,
      head,
      oid,
      target,
      attached ? `${BRANCH_PREFIX}${target}` : null,
      creating,
      creating && startPoint === undefined,
    )
    carried = [...moved.carried]
      .sort(([a], [b]) => compareCodePoints(a, b))
      .map(([path, letter]) => `${letter}\t${path}\n`)
      .join('')
    // git writes the warning above everything it says about the move, because
    // the directory it could not remove is a fact about the working tree
    // rather than about where HEAD went.
    note = moved.warnings + (await previousPosition(repo, head))
    if (attached) {
      const verb = creating ? 'Switched to a new branch' : 'Switched to branch'
      note += `${verb} '${target}'\n`
    } else {
      const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
      const subject = commit.message.split('\n')[0] ?? ''
      note += `HEAD is now at ${short(oid, repo.abbrev)} ${subject}\n`
    }
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  return [ENC.encode(carried), new IOResult({ stderr: ENC.encode(note) })]
}
