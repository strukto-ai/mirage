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

import { PathSpec } from '../../../../types.ts'

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { refuseAmbiguous, remoteBranch, trackMode } from './branch.ts'
import { moveHead } from './checkout.ts'
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
  RefReadOnlyError,
} from './errors.ts'
import { readIndex, refuseUnresolved } from './index_file.ts'

import type { ReadOnlyRefusal } from './types.ts'
import {
  BRANCH_PREFIX,
  blockingRef,
  loadRefs,
  readHead,
  REMOTE_PREFIX,
  setHead,
  TAG_PREFIX,
  validBranchName,
} from './refs.ts'
import { indexLocked, opened } from './session.ts'
import { COMMIT, noteAmbiguity, resolveCommit, TAG } from './revparse.ts'
import { checkSwitches, fatal } from './util.ts'

const ENC = new TextEncoder()
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
  if (known.has(`${REMOTE_PREFIX}${name}`)) return REMOTE_BRANCH
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
export async function switchBranch(
  config: unknown,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  try {
    const vfs = ctx.vfs
    if (vfs === undefined) {
      throw new NoWorkspaceError()
    }
    checkSwitches(ctx, texts)
    const flags = parseFlags(fl)
    let creating = flags.create !== undefined
    if (creating && flags.detach) throw new DetachWithCreateError()
    if (texts.length > 1) throw new OneReferenceError()
    const first = texts[0]
    // A detach takes HEAD when nothing is named, which is git's own default;
    // only an attaching switch needs a branch to name.
    if (!creating && first === undefined && !flags.detach) {
      throw new MissingBranchArgumentError()
    }
    const repo = await opened(ctx, fl, true)
    const mode = await trackMode(repo)
    const head = await readHead(vfs, repo.location.gitdir)
    const known = await loadRefs(vfs, repo.location.gitdir, repo.location.commondir)
    let target: string
    let oid: string
    let attached: boolean
    let startPoint: string | undefined
    if (flags.create !== undefined) {
      target = flags.create
      startPoint = first
      // Before the first commit there is nothing for HEAD to resolve to, and
      // git makes the branch anyway: the line only repoints symbolic HEAD,
      // writing neither the ref nor a reflog line, because a branch with no
      // commit is a name and nothing else. A start point is a different line
      // and stays unresolvable (`fatal: invalid reference: main`), so this
      // reads the shape of the line rather than probing HEAD. Pinned against
      // git 2.50.1.
      const unborn = first === undefined && head.ref !== null && !known.has(head.ref)
      oid = ''
      if (first !== undefined) {
        try {
          oid = await resolveCommit(repo, first)
        } catch (err) {
          if (err instanceof GitError) throw new InvalidReferenceError(first)
          throw err
        }
        await refuseAmbiguous(repo, first, false)
      }
      // After a start point that was named and before HEAD is read or anything
      // is written, which is git's own order, and before it asks whether the
      // branch exists, so a refs/heads/HEAD already there is still refused as a
      // name. A ref is a path below .git, so an unchecked name reaches writeRef
      // as one: -c ../../config would land on the repository's own
      // configuration rather than on a branch.
      if (!validBranchName(target)) throw new InvalidBranchNameError(target)
      if (known.has(`${BRANCH_PREFIX}${target}`)) throw new BranchExistsError(target)
      if (first === undefined && !unborn) {
        try {
          oid = await resolveCommit(repo, HEAD)
        } catch (err) {
          if (err instanceof GitError) throw new InvalidReferenceError(HEAD)
          throw err
        }
      }
      // And before the working tree moves: git takes the ref lock first, so a
      // name whose path another ref holds refuses with nothing checked out.
      const held = blockingRef(new Set(known.keys()), `${BRANCH_PREFIX}${target}`)
      if (held !== null) throw new RefLockError(`${BRANCH_PREFIX}${target}`, held)
      attached = true
      if (unborn) {
        await setHead(vfs, repo.location.gitdir, `${BRANCH_PREFIX}${target}`)
        return [
          ENC.encode(''),
          new IOResult({
            stderr: fl.asBool('quiet')
              ? new Uint8Array()
              : ENC.encode(`Switched to a new branch '${target}'\n`),
          }),
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
        await noteAmbiguity(repo, target)
        // Moving nothing is not the same as having nothing to check: git dies
        // on an unresolved index here too, so the shortcut reads it before it
        // answers. Every ref check above comes first, which is git's own order.
        refuseUnresolved(await readIndex(repo, vfs))
        return [
          null,
          new IOResult({
            stderr: fl.asBool('quiet') ? new Uint8Array() : ENC.encode(`Already on '${target}'\n`),
          }),
        ]
      }
      // git's --guess, on by default: no such branch here but one remote has
      // it, so the switch creates it tracking that one.
      const guessed =
        flags.detach || known.has(`${BRANCH_PREFIX}${target}`)
          ? null
          : await remoteBranch(repo, target)
      creating = guessed !== null
      startPoint = guessed ?? undefined
      // A branch of that name wins over every other reading, as git's switch
      // reads it, though the name is still reported as ambiguous.
      const branch = `${BRANCH_PREFIX}${target}`
      const local = !flags.detach && guessed === null && known.has(branch)
      if (local) await noteAmbiguity(repo, target)
      try {
        oid = await resolveCommit(repo, local ? branch : (guessed ?? target))
      } catch (err) {
        if (err instanceof GitError) throw new InvalidReferenceError(target)
        throw err
      }
      attached = creating || (!flags.detach && known.has(`${BRANCH_PREFIX}${target}`))
      if (!flags.detach && !attached) {
        throw new BranchExpectedError(expectedKind(known, target), target)
      }
    }
    return await moveHead(
      vfs,
      repo,
      known,
      head,
      oid,
      target,
      attached ? `${BRANCH_PREFIX}${target}` : null,
      creating,
      startPoint,
      mode,
      false,
      fl.asBool('quiet'),
    )
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

/**
 * switch's refusal by a read-only mount: the new branch's ref under a `-c` with
 * no start point, whose lock git takes first, and the index's otherwise.
 */
export const switchReadOnly: ReadOnlyRefusal = (texts, ctx, location) => {
  const name = new FlagView(ctx.flags, ctx.spec).asStr('create')
  if (name === undefined || texts.length > 0) return indexLocked(texts, ctx, location)
  const ref = `${BRANCH_PREFIX}${name}`
  return new RefReadOnlyError(
    ref,
    (location?.commondir ?? PathSpec.fromStrPath('/.git')).join(ref).virtual,
  )
}
