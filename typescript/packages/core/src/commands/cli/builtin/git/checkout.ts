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
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIDoors, CLIInvocation } from '../../types.ts'
import {
  branchUpstream,
  headCommit,
  refuseAmbiguous,
  remoteBranch,
  setUpTracking,
  trackMode,
} from './branch.ts'
import { trackingLines } from './render.ts'
import { ADDED, DELETED, headEntries, MODIFIED, workChanges } from './changes.ts'
import {
  BadStartPointError,
  BranchExistsError,
  CheckoutConflictError,
  DetachPathError,
  DetachWithCreateError,
  GitError,
  InvalidReferenceError,
  NoWorkspaceError,
  PathsWithBranchError,
  RefLockError,
  RefReadOnlyError,
  UnknownPathspecError,
  UnresolvableSourceError,
} from './errors.ts'
import { GITLINK_MODE, HEAD } from './constants.ts'
import { short } from './format.ts'
import { readIndex, refuseUnresolved, updateIndex, type StagedEntry } from './index_file.ts'
import {
  blockingAncestor,
  dropGitlink,
  keepGitlink,
  refuseReplacedMounts,
  removeEmptyParents,
  removeFile,
  removeTree,
  restoreEntry,
  under,
} from './io.ts'
import { append, entry, IDENTITY, logged, record, ZERO } from './reflog.ts'
import {
  BRANCH_PREFIX,
  blockingRef,
  detachHead,
  loadRefs,
  readHead,
  setHead,
  writeRef,
} from './refs.ts'
import { matched, repoRelative, under as inside } from './pathspec.ts'
import { repoArgs, type Repo } from './repo.ts'
import { indexLocked, opened } from './session.ts'
import { noteAmbiguity, refsNamed, resolveCommit } from './revparse.ts'
import { restorePaths, sourceTree } from './restore.ts'
import { restored } from './reset.ts'
import { commitEntries, type TreeEntry } from './tree.ts'
import type { LinkView, MountView, StatPath } from '../../../../ops/types.ts'
import { FileType } from '../../../../types.ts'
import type { Dispatch, HeadMove, HeadRef, IndexEntry, ReadOnlyRefusal } from './types.ts'
import { checkSwitches, fatal, splitMarked, startPoint as lineStart } from './util.ts'
import { scan, UNTRACKED_ALL } from './worktree.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

const ENC = new TextEncoder()

// git's word-for-word warning when HEAD leaves a branch, kept verbatim. It is
// the only thing telling a caller that commits made from here become unreachable
// once HEAD moves again, and an agent that has read this text before should not
// have to read a paraphrase of it.
export const DETACHED_ADVICE = `You are in 'detached HEAD' state. You can look around, make experimental
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
    .sort(compareCodePoints)
}

/**
 * The entries a switch actually writes into the working tree.
 *
 * Every check that asks what is standing in the way has to ask about these
 * rather than about the whole target tree. A path both trees record identically
 * is never written, so an untracked file sitting on it is left exactly where it
 * is; that file is one the index staged a deletion for, and git carries the
 * staged deletion rather than refusing the switch over the copy left on disk.
 * Content does not enter into it from the other side either: a path only the
 * target records is refused even when the untracked copy already matches it byte
 * for byte. Pinned against git 2.50.1.
 */
function written(
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>()
  for (const [path, entry] of after) {
    const old = before.get(path)
    if (old?.oid !== entry.oid || old.mode !== entry.mode) out.set(path, entry)
  }
  return out
}

/**
 * Which untracked files the entries being written would write over.
 *
 * An untracked file is in neither tree and neither index, so the comparison
 * above cannot see it, and writing the target branch's blob over it destroys
 * the only copy there is. git refuses and names each one. An ignored file is
 * not in this list and git overwrites it silently, which is the same split.
 * Pinned against git 2.50.
 *
 * Equality is not the whole test. An untracked file `slot` is also in the way
 * of a target that records `slot/child`, because the directory cannot be
 * created without deleting it; git names the untracked file itself there, not
 * the entry that needs the room.
 */
function overwritten(
  writing: ReadonlyMap<string, TreeEntry>,
  untracked: readonly string[],
): string[] {
  const names = [...writing.keys()]
  return untracked
    .filter((path) => writing.has(path) || names.some((name) => inside(name, path)))
    .sort(compareCodePoints)
}

/**
 * Which uncommitted paths stand where a written entry needs a directory.
 *
 * The same shape as the untracked check above, over the other set: an index
 * entry at `slot` is in the way of a target recording `slot/child`, because the
 * directory cannot be created without removing the file. The exact-key
 * comparison cannot see it, since `slot` is in neither tree.
 *
 * Deliberate divergence, and the same trade the staged case above makes. git
 * allows this and discards the staged addition in silence: `git switch` onto a
 * branch recording `slot/child` with `slot` staged succeeds, replaces the file
 * with the directory and leaves a clean status, with the staged blob reachable
 * from nothing. Where the working tree *also* differs from the index git
 * refuses instead, filed oddly under its untracked wording. mirage refuses both
 * and names the path: there is no reflog here to recover a staged blob from,
 * and a refusal the caller can act on beats a silent discard. Pinned against
 * git 2.50.1.
 */
function blockedAncestors(
  writing: ReadonlyMap<string, TreeEntry>,
  dirty: ReadonlySet<string>,
): string[] {
  const names = [...writing.keys()]
  return [...dirty]
    .filter((path) => names.some((name) => inside(name, path)))
    .sort(compareCodePoints)
}

/**
 * Which uncommitted paths stand inside a directory a written file replaces.
 *
 * The other half of the check above, over the same set. A staged `slot/child`
 * is in the way of a target recording the *file* `slot`, because the file
 * cannot be written without removing the directory, and the index entry for the
 * child would survive the switch as one half of a shape git's index has no room
 * for. The exact-key comparison misses it for the same reason as the ancestor
 * case: `slot/child` is in neither tree.
 *
 * The same deliberate divergence, and named the same way. git allows it:
 * switching onto a branch recording the file `slot` with `slot/child` staged
 * succeeds, removes the directory, and drops the staged entry with nothing left
 * pointing at its blob. mirage refuses and names the path instead. Pinned
 * against git 2.50.1.
 */
function blockedDescendants(
  writing: ReadonlyMap<string, TreeEntry>,
  dirty: ReadonlySet<string>,
): string[] {
  const names = [...writing.keys()]
  return [...dirty]
    .filter((path) => names.some((name) => inside(path, name)))
    .sort(compareCodePoints)
}

/**
 * Which directories the switch would empty of untracked files.
 *
 * The mirror of the case above: the target records a *file* where the working
 * tree has a directory, so writing it means removing the directory, and
 * anything untracked inside it is gone. git words this one differently and
 * names the directory rather than the files, since the directory is what the
 * caller has to move. Pinned against git 2.50.1.
 *
 * A gitlink is not one of those entries. It asks for a directory, not for a
 * file, so an existing one is left standing with everything in it, and git
 * takes this switch rather than refusing it. An untracked *file* at the same
 * name is still refused, by the check above, because the directory cannot be
 * made without deleting it.
 */
function lostDirectories(
  writing: ReadonlyMap<string, TreeEntry>,
  untracked: readonly string[],
): string[] {
  return [...writing]
    .filter(([, entry]) => entry.mode !== GITLINK_MODE)
    .map(([name]) => name)
    .filter((name) => untracked.some((path) => inside(path, name)))
    .sort(compareCodePoints)
}

/**
 * Make the working tree and index match the tree being switched to.
 *
 * Only paths the two trees disagree about are touched, so a file that is the
 * same on both branches keeps whatever the working tree has, including an
 * uncommitted edit, and keeps its index entry, which is what preserves a staged
 * change both branches happen to agree about. Every path the trees do disagree
 * about has already been refused by the caller if anything uncommitted stands on
 * it, so the tree diff is the whole decision here.
 */
export async function switchTo(
  repo: Repo,
  dispatch: Dispatch,
  statPath: StatPath,
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
  links: LinkView | null,
  mounts: MountView | null,
): Promise<string[]> {
  const changed = written(before, after)
  // A gitlink is not written into the working tree at all, so it is neither
  // read as a blob nor allowed to clear what stands at the name; keepGitlink is
  // the whole of what the entry asks for.
  const replacing = [...changed.keys()].filter((path) => changed.get(path)?.mode !== GITLINK_MODE)
  // Before the first removal, not at the entry that meets it: a refusal
  // halfway through leaves the entries already written holding the target's
  // content while HEAD and the index still name the branch being left, which
  // is the half-switch every other check above exists to prevent.
  await refuseReplacedMounts(statPath, repo.location.worktree, replacing, links, mounts)
  // Removals first, and the emptied directories with them, because the two
  // sets name the same place whenever a branch records a file where the other
  // records a directory: writing `slot/child` while the file `slot` is still
  // there fails, and so does writing the file while the directory is. Nothing
  // is read back from the working tree, so emptying it first is free.
  // `restore` orders its own pass the same way, for the same reason.
  const notes: string[] = []
  for (const path of [...before.keys()].sort(compareCodePoints)) {
    if (after.has(path)) continue
    const where = under(repo.location.worktree, path)
    // A gitlink the target tree drops is a directory, not a file: git rmdirs
    // it and warns rather than failing when something is still in it, where
    // the unlink here died on it with the removals ahead of it already
    // applied.
    if (before.get(path)?.mode === GITLINK_MODE) {
      const warned = await dropGitlink(dispatch, statPath, where, path, links)
      if (warned !== null) notes.push(warned)
    } else {
      await removeFile(dispatch, where)
    }
    await removeEmptyParents(dispatch, where, repo.location.worktree, mounts)
  }
  for (const path of [...changed.keys()].sort(compareCodePoints)) {
    const entry = changed.get(path)
    if (entry === undefined) continue
    if (entry.mode === GITLINK_MODE) {
      await keepGitlink(dispatch, statPath, under(repo.location.worktree, path), links)
      continue
    }
    const { blob } = await git.readBlob({ ...repoArgs(repo), oid: entry.oid })
    // Whatever the removals above did not take, a component above the entry
    // may still not be a directory: an ignored file or link is in neither tree
    // and in no collision list, so it reaches here. git replaces it with the
    // directory the entry needs rather than writing through it, which is what
    // keeps a link's target tree, a path no branch named, out of the way.
    const above = await blockingAncestor(statPath, repo.location.worktree, path, links)
    if (above !== null) await removeFile(dispatch, above)
    const where = under(repo.location.worktree, path)
    // And the same thing standing on the name itself rather than above it: a
    // directory holding only ignored files is in no collision list either,
    // since the check that refuses one is about the untracked files it would
    // lose. git updates ignored files by default and takes the whole directory
    // with it. A link is left to restoreEntry, which retargets it; following
    // one to a directory here would delete a tree no branch named.
    if ((links?.statAt(where) ?? null) === null) {
      const info = await statPath(where)
      if (info !== null && info.type === FileType.DIRECTORY) {
        await removeTree(dispatch, where, links, mounts)
      }
    }
    await restoreEntry(dispatch, where, entry.mode, blob, links)
  }
  // The index is git's two-way merge, not a copy of the target tree: only a
  // path the two trees disagree about is decided by the target, and where they
  // agree the entry is left exactly as it stands. That is what carries all three
  // kinds of staged work across. Rebuilding the index from the target alone
  // dropped a staged addition, which is in neither tree, and resurrected a
  // staged deletion, which is in both and in no entry, turning both into
  // unstaged changes a later commit would silently omit.
  const staged = new Map<string, StagedEntry>()
  for (const [path, entry] of changed) {
    staged.set(path, restored(entry.oid, Number.parseInt(entry.mode, 8)))
  }
  const removed = [...before.keys()].filter((path) => !after.has(path))
  await updateIndex(repo, staged, removed)
  return notes
}

/**
 * git's line for leaving a detached HEAD, empty when it was on a branch.
 *
 * Printed before the line saying where HEAD went, because a commit made while
 * detached is reachable from nothing once HEAD moves, and this is the one place
 * its id is still written down for the caller.
 */
export async function previousPosition(repo: Repo, head: HeadRef): Promise<string> {
  if (head.commit === null) return ''
  const { commit } = await git.readCommit({ ...repoArgs(repo), oid: head.commit })
  const subject = commit.message.split('\n')[0] ?? ''
  return `Previous HEAD position was ${short(head.commit, repo.abbrev)} ${subject}\n`
}

/**
 * Point HEAD at a commit and write the reflog lines for the move.
 *
 * The half of a checkout that happens whatever the working tree holds: a branch
 * created where HEAD already is does only this. The move is HEAD's alone to
 * log, from the branch it left or the whole id it was detached at; a branch the
 * line creates gets a log of its own saying where it came from. Pinned against
 * git 2.50.1.
 */
async function attach(
  dispatch: Dispatch,
  repo: Repo,
  known: ReadonlyMap<string, string>,
  head: HeadRef,
  oid: string,
  target: string,
  ref: string | null,
  creating: boolean,
  from: string,
): Promise<void> {
  const when = Math.floor(Date.now() / 1000)
  if (creating && ref !== null) {
    await writeRef(dispatch, repo.location.commondir, ref, oid)
    const log = under(repo.location.commondir, 'logs', ref)
    if (await logged(dispatch, repo.location, ref, log)) {
      const line = entry(ZERO, oid, IDENTITY, when, `branch: Created from ${from}`)
      await append(dispatch, repo.location.commondir, `logs/${ref}`, line)
    }
  }
  if (ref !== null) await setHead(dispatch, repo.location.gitdir, ref)
  else await detachHead(dispatch, repo.location.gitdir, oid)
  const where = head.branch ?? head.commit ?? ''
  await record(
    dispatch,
    repo.location.gitdir,
    repo.location.commondir,
    null,
    headCommit(known, head),
    oid,
    IDENTITY,
    when,
    `checkout: moving from ${where} to ${target}`,
  )
}

/**
 * How the index differs from HEAD, one status letter per path.
 *
 * The same three comparisons `status` makes against HEAD, kept here rather than
 * borrowed from `stageChanges` because that one pairs renames and this list does
 * not: git letters a carried change by what it is on its own, and an unmerged
 * path cannot reach this (the caller refuses one before any tree is read).
 *
 * A path the index has no entry for is the one git's own reading gets right and
 * a walk of the entries cannot see at all: a staged deletion is an absence, so
 * it has to be read off HEAD's tree.
 */
function stageLetters(
  before: ReadonlyMap<string, TreeEntry>,
  entries: ReadonlyMap<string, IndexEntry>,
): Map<string, string> {
  const letters = new Map<string, string>()
  for (const [path, entry] of entries) {
    const recorded = before.get(path)
    if (recorded === undefined) letters.set(path, ADDED)
    else if (recorded.oid !== entry.oid || Number.parseInt(recorded.mode, 8) !== entry.mode) {
      letters.set(path, MODIFIED)
    }
  }
  for (const path of before.keys()) {
    if (!entries.has(path)) letters.set(path, DELETED)
  }
  return letters
}

/**
 * Move HEAD, the index and the working tree to a commit.
 *
 * The one procedure `checkout` and `switch` share, since the two differ only in
 * what they accept and how they word a miss. Refuses rather than overwriting
 * when the move would destroy work that is not committed, whether that is an
 * edit to a tracked file, an untracked file the target holds, or a conflict
 * still being resolved. Those checks are the whole reason either verb is safe to
 * offer: without them a branch switch silently throws away whatever was changed
 * and not staged, and there is no reflog here to get it back from.
 *
 * @param dispatch workspace op dispatcher
 * @param statPath dispatcher-backed stat, both channels
 * @param links the name plane's link facts, null outside a workspace
 * @param mounts the name plane's mount boundaries, null outside a workspace
 * @param repo the opened repository
 * @param known every ref the repository publishes
 * @param head what HEAD pointed at before the move
 * @param oid the commit to move to
 * @param target the operand as the user spelled it, for the reflog
 * @param ref the branch to attach HEAD to, null to detach it at the commit
 * @param creating whether `ref` is a new branch to write first
 * @param from the start point a new branch was created from, as typed
 * @param inPlace whether the line named no start point, so the new branch is
 *   being created where HEAD already is
 * @returns each path whose uncommitted change was carried across, against the
 *   status letter git prints for it
 */
export async function moveHead(
  dispatch: Dispatch,
  statPath: StatPath,
  links: LinkView | null,
  mounts: MountView | null,
  repo: Repo,
  known: ReadonlyMap<string, string>,
  head: HeadRef,
  oid: string,
  target: string,
  ref: string | null,
  creating: boolean,
  from: string,
  inPlace: boolean,
): Promise<HeadMove> {
  // A branch created where HEAD already is moves nothing: git writes the ref,
  // points HEAD at it, and never touches the working tree or the index, so an
  // unmerged index survives `git switch -c topic` and is refused by
  // `git switch -c topic HEAD` a word later. The shape of the line is what
  // decides it, which is git's own reading rather than a comparison of the two
  // trees. Pinned against git 2.50.1.
  if (inPlace) {
    await attach(dispatch, repo, known, head, oid, target, ref, creating, from)
    return { carried: new Map(), warnings: '' }
  }
  const before = (await headEntries(repo)) ?? new Map<string, TreeEntry>()
  const after = await commitEntries(repo, oid)
  const state = await readIndex(repo, dispatch)
  // First, before either tree is compared and before the working tree is
  // walked, which is where git refuses it too. Every check below reads stage 0,
  // so a path held only as conflict stages is invisible to all of them and the
  // move would clear the stages and delete the file, throwing away a resolution
  // in progress.
  refuseUnresolved(state)
  const tracked = new Set(state.entries.keys())
  // UNTRACKED_ALL, not the mode status uses: "normal" collapses a wholly
  // untracked directory to one `dir/` entry, and a collision has to be
  // decided per file. git names the file inside such a directory, so the
  // list has to hold it.
  const found = await scan(dispatch, statPath, repo.location, tracked, UNTRACKED_ALL, links)
  const unstaged = await workChanges(repo, dispatch, repo.location.worktree, state.entries, found)
  // Both kinds of uncommitted change count: an edit in the working tree, and
  // one already staged. Leaving the staged ones out is what silently threw
  // them away. The index column wins where a path has both, which is how git's
  // own short status reads a row and how it letters this list.
  const carried = new Map([...unstaged, ...stageLetters(before, state.entries)])
  const dirty = new Set(carried.keys())
  const writing = written(before, after)
  const blocked = [
    ...new Set([
      ...conflicts(before, after, dirty),
      ...blockedAncestors(writing, dirty),
      ...blockedDescendants(writing, dirty),
    ]),
  ].sort(compareCodePoints)
  const clobbered = overwritten(writing, found.untracked)
  const lost = lostDirectories(writing, found.untracked)
  if (blocked.length > 0 || clobbered.length > 0 || lost.length > 0) {
    throw new CheckoutConflictError(blocked, clobbered, lost)
  }
  const notes = await switchTo(repo, dispatch, statPath, before, after, links, mounts)
  await attach(dispatch, repo, known, head, oid, target, ref, creating, from)
  return { carried, warnings: notes.join('') }
}

/**
 * What a switch onto a branch prints about its upstream, on stdout. Read after
 * the move, so a branch created by the switch has its ref to count from.
 */
export async function trackingReport(repo: Repo, branch: string): Promise<string> {
  const upstream = await branchUpstream(
    repo,
    { branch, ref: `${BRANCH_PREFIX}${branch}`, commit: null },
    false,
  )
  return upstream === null
    ? ''
    : trackingLines(upstream)
        .map((line) => `${line}\n`)
        .join('')
}

/**
 * Whether an operand reads as a commit, for checkout's choice between a
 * tree-ish and a path: a name a ref answers to does, and so does an id or an
 * expression that resolves to one.
 */
async function readsAsCommit(
  repo: Repo,
  known: ReadonlyMap<string, string>,
  operand: string,
): Promise<boolean> {
  if (refsNamed(known, operand).length > 0) return true
  try {
    await resolveCommit(repo, operand)
    return true
  } catch (err) {
    if (err instanceof GitError) return false
    throw err
  }
}

/** Whether an operand names a path the index holds, which makes it a pathspec. */
async function namesPath(
  repo: Repo,
  dispatch: Dispatch,
  start: string,
  operand: string,
): Promise<boolean> {
  const state = await readIndex(repo, dispatch)
  const names = new Set([...state.entries.keys(), ...state.conflicts.keys()])
  return matched(names, repoRelative(repo.location, start, operand)).size > 0
}

/**
 * `git checkout [<tree-ish>] [--] <pathspec>...`: put paths back from the
 * index into the working tree, or from a tree-ish into both; a path only the
 * index holds is left as it is. Without `--` git reports how many files it
 * rewrote, from the index or from the tree's abbreviated id. Pinned against
 * git 2.50.1.
 *
 * @param repo the opened repository
 * @param doors the invocation's doors
 * @param fl the line's flags
 * @param treeish the tree-ish named ahead of the paths, null for the index
 * @param paths the pathspecs as typed
 * @param counted whether the line named its paths without `--`
 */
async function checkoutPaths(
  repo: Repo,
  doors: CLIDoors,
  fl: FlagView,
  treeish: string | null,
  paths: readonly string[],
  counted: boolean,
): Promise<CommandFnResult> {
  let tree = ''
  let source: Map<string, TreeEntry> | null = null
  if (treeish !== null) {
    try {
      ;[tree, source] = await sourceTree(repo, treeish)
    } catch (err) {
      if (err instanceof UnresolvableSourceError) throw new InvalidReferenceError(treeish)
      throw err
    }
  }
  const [notes, updated] = await restorePaths(
    repo,
    doors,
    paths,
    lineStart(fl),
    source,
    treeish !== null,
    true,
    true,
  )
  let told = notes.join('')
  if (counted && !fl.asBool('quiet')) {
    const from = treeish === null ? 'the index' : short(tree, repo.abbrev)
    told += `Updated ${String(updated)} path${updated === 1 ? '' : 's'} from ${from}\n`
  }
  return [null, told === '' ? new IOResult() : new IOResult({ stderr: ENC.encode(told) })]
}

/**
 * Switch the working tree to another branch or commit, or put paths back.
 *
 * Refuses rather than overwriting when the switch would destroy work that is not
 * committed; see `moveHead`, which does the moving for `switch` as well. Paths
 * after `--`, or operands past a first one that reads as a commit, or a lone
 * operand the index holds and no ref names, are put back instead; see
 * `checkoutPaths`.
 */
export async function checkout(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  let carried: string
  let note: string
  let warnings = ''
  try {
    const dispatch = doors.dispatch
    const statPath = doors.statPath
    if (statPath === undefined || dispatch === undefined) {
      throw new NoWorkspaceError()
    }
    checkSwitches(inv, texts)
    const detach = fl.asBool('detach')
    if (detach && fl.asBool('b')) throw new DetachWithCreateError()
    const target = texts[0] ?? (detach ? HEAD : undefined)
    if (target === undefined) throw new UnknownPathspecError('')
    const extra = texts[1]
    if (detach && extra !== undefined) throw new DetachPathError(extra)
    const repo = await opened(fl, doors, true)
    const mode = await trackMode(repo)
    const head = await readHead(dispatch, repo.location.gitdir)
    let creating = fl.asBool('b')
    const ref = `${BRANCH_PREFIX}${target}`
    const known = await loadRefs(dispatch, repo.location.gitdir, repo.location.commondir)
    if (creating && texts.length > 2) throw new PathsWithBranchError(target)
    if (!creating && !detach) {
      const [leading, marked] = splitMarked(texts, inv.argv)
      if (marked.length > 0) {
        const paths = [...leading.slice(1), ...marked]
        return await checkoutPaths(repo, doors, fl, leading[0] ?? null, paths, false)
      }
      if (texts.length > 1) {
        const treeish = (await readsAsCommit(repo, known, target)) ? target : null
        const paths = treeish === null ? texts : texts.slice(1)
        return await checkoutPaths(repo, doors, fl, treeish, paths, true)
      }
    }
    if (creating && known.has(ref)) throw new BranchExistsError(target)
    let guessed: string | null = null
    // The commit a target names when it is no local branch: a branch of that
    // name wins over every other reading, as git's checkout reads it.
    let named: string | null = null
    if (!creating && (detach || (!known.has(ref) && target !== head.branch))) {
      try {
        named = await resolveCommit(repo, target)
      } catch {
        if (detach) throw new DetachPathError(target)
        if (await namesPath(repo, dispatch, lineStart(fl), target)) {
          return await checkoutPaths(repo, doors, fl, null, texts, true)
        }
        guessed = await remoteBranch(repo, target)
        if (guessed === null) throw new UnknownPathspecError(target)
        creating = true
      }
    }
    if (!creating && !detach && target === head.branch) {
      await noteAmbiguity(repo, target)
      // The shortcut moves nothing, and that is exactly why it has to read the
      // index: git refuses the line over an unresolved index rather than
      // answering that there is nothing to do, so a caller cannot read
      // "Already on" as proof the repository is in a state it can build on.
      refuseUnresolved(await readIndex(repo, dispatch))
      return [
        null,
        new IOResult({
          stderr: fl.asBool('quiet') ? new Uint8Array() : ENC.encode(`Already on '${target}'\n`),
        }),
      ]
    }
    // `checkout -b <new> [<start>]` branches from the start point when one is
    // given, HEAD otherwise. Forcing HEAD here put the new branch on the
    // current commit and dropped the operand without a word, so every commit
    // after it landed on the wrong history.
    const startPoint = guessed ?? (creating ? texts[1] : undefined)
    let oid: string
    if (startPoint !== undefined) {
      try {
        oid = await resolveCommit(repo, startPoint)
      } catch {
        throw new BadStartPointError(startPoint, target)
      }
      if (guessed === null) await refuseAmbiguous(repo, startPoint, false)
    } else if (named !== null) {
      oid = named
    } else if (!creating && known.has(ref)) {
      await noteAmbiguity(repo, target)
      oid = await resolveCommit(repo, ref)
    } else {
      oid = await resolveCommit(repo, creating ? 'HEAD' : target)
    }
    // Before the working tree moves, which is where git refuses it too: the
    // ref is locked first and nothing is checked out when the lock cannot be
    // taken.
    const held = creating ? blockingRef(new Set(known.keys()), ref) : null
    if (held !== null) throw new RefLockError(ref, held)
    const attached = !detach && (creating || known.has(ref))
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
      attached ? ref : null,
      creating,
      startPoint ?? HEAD,
      creating && startPoint === undefined,
    )
    carried = [...moved.carried]
      .sort(([a], [b]) => compareCodePoints(a, b))
      .map(([path, letter]) => `${letter}\t${path}\n`)
      .join('')
    let warning = ''
    if (creating) {
      const [tracking, told] = await setUpTracking(repo, target, startPoint ?? null, mode, head)
      carried += tracking
      warning = told
    }
    // git writes the warning above everything it says about the move, because
    // the directory it could not remove is a fact about the working tree
    // rather than about where HEAD went.
    warnings = moved.warnings + warning
    note = moved.warnings + (await previousPosition(repo, head)) + warning
    if (attached) {
      const verb = creating ? 'Switched to a new branch' : 'Switched to branch'
      note += `${verb} '${target}'\n`
      if (!creating) carried += await trackingReport(repo, target)
    } else {
      const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
      const subject = commit.message.split('\n')[0] ?? ''
      // Asked for by name, a detached HEAD needs no advice on how it happened.
      if (!detach) note += `Note: switching to '${target}'.\n\n${DETACHED_ADVICE}\n`
      note += `HEAD is now at ${short(oid, repo.abbrev)} ${subject}\n`
    }
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  if (fl.asBool('quiet')) return [null, new IOResult({ stderr: ENC.encode(warnings) })]
  return [ENC.encode(carried), new IOResult({ stderr: ENC.encode(note) })]
}

/**
 * checkout's refusal by a read-only mount: the new branch's ref under `-b`,
 * whose lock git takes first, and the index's otherwise.
 */
export const checkoutReadOnly: ReadOnlyRefusal = (inv, location) => {
  const name = inv.texts[0]
  if (!new FlagView(inv.flags).asBool('b') || name === undefined) return indexLocked(inv, location)
  const ref = `${BRANCH_PREFIX}${name}`
  return new RefReadOnlyError(ref, under(location?.commondir ?? '.git', ref))
}
