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
import { headEntries, workChanges } from './changes.ts'
import {
  BadStartPointError,
  BranchExistsError,
  CheckoutConflictError,
  GitError,
  NoWorkspaceError,
  UnknownPathspecError,
  UnknownSwitchError,
} from './errors.ts'
import { short } from './format.ts'
import { readIndex, updateIndex, type StagedEntry } from './index_file.ts'
import { removeFile, under, writeFile } from './io.ts'
import { record } from './reflog.ts'
import { BRANCH_PREFIX, detachHead, loadRefs, readHead, setHead, writeRef } from './refs.ts'
import { opened, repoArgs, type Repo } from './repo.ts'
import { resolveCommit } from './revparse.ts'
import { restored } from './reset.ts'
import { commitEntries, type TreeEntry } from './tree.ts'
import type { Dispatch, IndexEntry } from './types.ts'
import { checkOperands, fatal } from './util.ts'
import { scan, UNTRACKED_ALL } from './worktree.ts'

const ENC = new TextEncoder()

// What checkout records in the reflog. There is no committer here, only a move
// of HEAD, so the same stated identity commit uses is reused.
const IDENTITY = 'mirage <mirage@localhost>'

// git's word-for-word warning when HEAD leaves a branch, kept verbatim. It is
// the only thing telling a caller that commits made from here become unreachable
// once HEAD moves again, and an agent that has read this text before should not
// have to read a paraphrase of it.
const DETACHED_ADVICE = `You are in 'detached HEAD' state. You can look around, make experimental
changes and commit them, and you can discard any commits you make in this
state without impacting any branches by switching back to a branch.

If you want to create a new branch to retain commits you create, you may
do so (now or later) by using -c with the switch command. Example:

  git switch -c <new-branch-name>

Or undo this operation with:

  git switch -

Turn off this advice by setting config variable advice.detachedHead to false
`

/**
 * Which uncommitted changes the switch would overwrite.
 *
 * A file edited but not committed survives a branch switch when both branches
 * record the same content for it: git carries the edit across rather than
 * refusing, and only refuses when the target branch would have to write over it.
 * Pinned against git 2.47.
 *
 * Deliberate divergence for a *staged* change to such a file: git carries that
 * across too, applying its own two-way merge to the index, and mirage refuses
 * instead. Refusing is the safe half of the trade. Getting the merge wrong loses
 * staged work with no reflog to recover it from, and a refusal that names the
 * file is something the caller can act on, where a silent clobber is not.
 */
function conflicts(
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  dirty: ReadonlySet<string>,
): string[] {
  return [...dirty]
    .filter((path) => {
      const old = before.get(path)
      const now = after.get(path)
      return old?.oid !== now?.oid || old?.mode !== now?.mode
    })
    .sort()
}

/**
 * Which untracked files the tree being switched to would write over.
 *
 * An untracked file is in neither tree and neither index, so the comparison
 * above cannot see it, and writing the target branch's blob over it destroys
 * the only copy there is. git refuses and names each one. An ignored file is
 * not in this list and git overwrites it silently, which is the same split.
 * Pinned against git 2.50.
 */
function overwritten(
  after: ReadonlyMap<string, TreeEntry>,
  untracked: readonly string[],
): string[] {
  return untracked.filter((path) => after.has(path)).sort()
}

/**
 * Make the working tree and index match the tree being switched to.
 *
 * Only paths whose recorded content differs are touched, so a file that is the
 * same on both branches keeps whatever the working tree has, including an
 * uncommitted edit. A path carried across keeps its index entry too, which is
 * what preserves a staged change that both branches happen to agree about.
 */
async function switchTo(
  repo: Repo,
  dispatch: Dispatch,
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  keep: ReadonlySet<string>,
  held: ReadonlyMap<string, IndexEntry>,
): Promise<void> {
  for (const [path, entry] of after) {
    const old = before.get(path)
    if (old?.oid === entry.oid && old.mode === entry.mode) continue
    if (keep.has(path)) continue
    const { blob } = await git.readBlob({ ...repoArgs(repo), oid: entry.oid })
    await writeFile(dispatch, under(repo.location.worktree, path), blob)
  }
  for (const path of before.keys()) {
    if (after.has(path)) continue
    await removeFile(dispatch, under(repo.location.worktree, path))
  }
  const state = await readIndex(repo, dispatch)
  const staged = new Map<string, StagedEntry>()
  for (const [path, entry] of after) {
    const carried = held.get(path)
    if (keep.has(path) && carried !== undefined) {
      staged.set(path, { oid: carried.oid, mode: carried.mode, size: carried.size })
    } else {
      staged.set(path, restored(entry.oid, Number.parseInt(entry.mode, 8)))
    }
  }
  const removed = [...state.entries.keys(), ...state.conflicts.keys()].filter(
    (path) => !after.has(path),
  )
  await updateIndex(repo, staged, removed)
}

/**
 * Switch the working tree to another branch or commit.
 *
 * Refuses rather than overwriting when the switch would destroy work that is not
 * committed, whether that is an edit to a tracked file or an untracked file the
 * target branch happens to hold. That check is the whole reason this verb is
 * safe to offer: without it a branch switch silently throws away whatever was
 * changed and not staged, and there is no reflog here to get it back from.
 */
export async function checkout(inv: CLIInvocation): Promise<CommandFnResult> {
  // The mount doors ride the one record; `opts` keeps its name so
  // the body reads the same as when they were a parameter.
  const opts = inv.ops ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  let carried: string
  let note: string
  try {
    const dispatch = opts.dispatch
    const statPath = opts.statPath
    if (statPath === undefined || opts.mountRoot === undefined || dispatch === undefined) {
      throw new NoWorkspaceError()
    }
    checkOperands(texts, UnknownSwitchError)
    const target = texts[0]
    if (target === undefined) throw new UnknownPathspecError('')
    const repo = await opened(fl, statPath, opts.mountRoot, dispatch)
    const head = await readHead(dispatch, repo.location.gitdir)
    const creating = fl.asBool('b')
    const ref = `${BRANCH_PREFIX}${target}`
    const known = await loadRefs(dispatch, repo.location.gitdir, repo.location.commondir)
    if (creating && known.has(ref)) throw new BranchExistsError(target)
    if (!creating && !known.has(ref) && target !== head.branch) {
      try {
        await resolveCommit(repo, target)
      } catch {
        throw new UnknownPathspecError(target)
      }
    }
    if (!creating && target === head.branch) {
      return [null, new IOResult({ stderr: ENC.encode(`Already on '${target}'\n`) })]
    }
    // `checkout -b <new> [<start>]` branches from the start point when one is
    // given, HEAD otherwise. Forcing HEAD here put the new branch on the
    // current commit and dropped the operand without a word, so every commit
    // after it landed on the wrong history.
    const startPoint = creating ? texts[1] : undefined
    let oid: string
    if (startPoint !== undefined) {
      try {
        oid = await resolveCommit(repo, startPoint)
      } catch {
        throw new BadStartPointError(startPoint, target)
      }
    } else {
      oid = await resolveCommit(repo, creating ? 'HEAD' : target)
    }
    const before = (await headEntries(repo)) ?? new Map<string, TreeEntry>()
    const after = await commitEntries(repo, oid)
    const state = await readIndex(repo, dispatch)
    const tracked = new Set(state.entries.keys())
    // UNTRACKED_ALL, not the mode status uses: "normal" collapses a wholly
    // untracked directory to one `dir/` entry, and a collision has to be
    // decided per file. git names the file inside such a directory, so the
    // list has to hold it.
    const found = await scan(dispatch, statPath, repo.location, tracked, UNTRACKED_ALL)
    const unstaged = await workChanges(repo, dispatch, repo.location.worktree, state.entries, found)
    // Both kinds of uncommitted change count: an edit in the working tree, and
    // one already staged. Leaving the staged ones out is what silently threw
    // them away.
    const stagedPaths = [...state.entries.entries()]
      .filter(([path, entry]) => {
        const recorded = before.get(path)
        return recorded?.oid !== entry.oid || Number.parseInt(recorded.mode, 8) !== entry.mode
      })
      .map(([path]) => path)
    const dirty = new Set([...unstaged.keys(), ...stagedPaths])
    const blocked = conflicts(before, after, dirty)
    const clobbered = overwritten(after, found.untracked)
    if (blocked.length > 0 || clobbered.length > 0) {
      throw new CheckoutConflictError(blocked, clobbered)
    }
    await switchTo(repo, dispatch, before, after, dirty, state.entries)
    const attached = creating || known.has(ref)
    if (creating) await writeRef(dispatch, repo.location.commondir, ref, oid)
    if (attached) await setHead(dispatch, repo.location.gitdir, ref)
    else await detachHead(dispatch, repo.location.gitdir, oid)
    const where = head.branch ?? short(head.commit ?? '', repo.abbrev)
    await record(
      dispatch,
      repo.location.gitdir,
      attached ? ref : null,
      head.commit ?? (head.ref !== null ? (known.get(head.ref) ?? null) : null),
      oid,
      IDENTITY,
      Math.floor(Date.now() / 1000),
      `checkout: moving from ${where} to ${target}`,
    )
    carried = [...dirty]
      .sort()
      .map((path) => `M\t${path}\n`)
      .join('')
    if (attached) {
      const verb = creating ? 'Switched to a new branch' : 'Switched to branch'
      note = `${verb} '${target}'\n`
    } else {
      const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
      const subject = commit.message.split('\n')[0] ?? ''
      note =
        `Note: switching to '${target}'.\n\n${DETACHED_ADVICE}\n` +
        `HEAD is now at ${short(oid, repo.abbrev)} ${subject}\n`
    }
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  return [ENC.encode(carried), new IOResult({ stderr: ENC.encode(note) })]
}
