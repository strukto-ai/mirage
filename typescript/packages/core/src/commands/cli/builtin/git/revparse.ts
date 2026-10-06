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
import { DWIM_RULES, GITLINK_MODE, HEAD } from './constants.ts'

import {
  AmbiguousArgumentError,
  BadRevisionError,
  InvalidRevisionNameError,
  PathNotAtStageError,
  PathNotInIndexError,
  PathNotInRevisionError,
} from './errors.ts'
import { readIndex } from './index_file.ts'
import { exists, under } from './io.ts'
import { isEnotdir } from '../../../../utils/errors.ts'
import type { CommitFacts } from './format.ts'
import { loadRefs, TAG_PREFIX } from './refs.ts'
import { commitFacts, repoArgs, type Repo } from './repo.ts'
import type { AncestryStep, GitObject, RevOp } from './types.ts'

const ANCESTOR = '~'
const PARENT = '^'
const SUFFIXES = [ANCESTOR, PARENT]
// `<rev>^{<type>}` peels to a type; `<rev>:<path>` reads a tree.
const PEEL_OPEN = '^{'
const PEEL_CLOSE = '}'
const PATH_MARK = ':'
export const COMMIT = 'commit'
export const TREE = 'tree'
export const TAG = 'tag'
// Not a type any object reports: `^{object}` asks only that the name resolve to
// something, and hands back whatever that is.
export const OBJECT = 'object'
const STAGED = /^[0-3]:/
// `A..B` hides A and walks B; a third dot walks both and hides only what they
// share. A leading caret hides one revision on its own.
const RANGE = '..'
const SYMMETRIC_DOT = '.'
const NEGATION = '^'
const LEFT = 1
const RIGHT = 2
const STALE = 4

/**
 * Split a revision into its base and the operators applied to it.
 *
 * git reads a revision left to right: every `~n`, `^n` and `^{<type>}` applies
 * to whatever the one before it produced, so `HEAD^{commit}~1` is the parent of
 * HEAD and `HEAD~1^{tree}` is that parent's tree. Reading the peel as a trailing
 * thing instead refused every chain that did not end in one, and reading `^{` as
 * an ancestry step is worse than refusing: `^` with no digits means "first
 * parent", so `HEAD^{tree}` would answer with HEAD's parent without a word.
 * Splitting on the first `~` or `^` is safe because git forbids both in a ref
 * name, so neither can belong to the base. Pinned against git 2.50.1.
 *
 * Only `~` and `^` open an operator, and reading anything else as one is silent
 * rather than loud: every other character counted as another first-parent hop,
 * so `HEAD^x` resolved to `HEAD^^` and the caller was handed a commit it never
 * named. git refuses the whole expression instead, and refuses `main~٣` with it,
 * since the digits it counts are ASCII.
 *
 * @param revision revision as the user spelled it
 * @throws AmbiguousArgumentError when the rest holds anything but operators
 */
function splitOperators(revision: string): [string, RevOp[]] {
  let index = revision.length
  for (let i = 0; i < revision.length; i++) {
    if (SUFFIXES.includes(revision.charAt(i))) {
      index = i
      break
    }
  }
  const base = revision.slice(0, index)
  const rest = revision.slice(index)
  const ops: RevOp[] = []
  let position = 0
  while (position < rest.length) {
    const kind = rest.charAt(position)
    if (!SUFFIXES.includes(kind)) throw new AmbiguousArgumentError(revision)
    if (rest.startsWith(PEEL_OPEN, position)) {
      const close = rest.indexOf(PEEL_CLOSE, position)
      if (close < 0) throw new AmbiguousArgumentError(revision)
      ops.push({ want: rest.slice(position + PEEL_OPEN.length, close) })
      position = close + 1
      continue
    }
    position += 1
    let digits = ''
    while (position < rest.length && /[0-9]/.test(rest.charAt(position))) {
      digits += rest.charAt(position)
      position += 1
    }
    ops.push({
      firstParent: kind === ANCESTOR,
      count: digits === '' ? 1 : Number.parseInt(digits, 10),
    })
  }
  return [base === '' ? HEAD : base, ops]
}

/** Load one commit's parents by object id, or report the revision as unknown. */
async function parentsOf(repo: Repo, oid: string, revision: string): Promise<string[]> {
  try {
    const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
    return [...commit.parent]
  } catch {
    throw new AmbiguousArgumentError(revision)
  }
}

/**
 * Apply one ancestry suffix to a commit.
 *
 * `~n` walks n generations along first parents; `^n` takes the n-th parent of
 * this commit, and `^0` is the commit itself (git's way of spelling "the commit
 * a tag points at").
 */
async function applyStep(
  repo: Repo,
  oid: string,
  step: AncestryStep,
  revision: string,
): Promise<string> {
  let current = oid
  if (step.firstParent) {
    for (let i = 0; i < step.count; i++) {
      const parents = await parentsOf(repo, current, revision)
      const first = parents[0]
      if (first === undefined) throw new AmbiguousArgumentError(revision)
      current = first
    }
    return current
  }
  if (step.count === 0) return current
  const parents = await parentsOf(repo, current, revision)
  const picked = parents[step.count - 1]
  if (picked === undefined) throw new AmbiguousArgumentError(revision)
  return picked
}

/**
 * Resolve a revision to a commit id, ancestry suffixes included.
 *
 * isomorphic-git resolves refs, full ids and unambiguous short ids, and peels a
 * tag; it knows nothing about `~` and `^`, which are applied here on top of
 * whatever its own parser returns.
 *
 * A `^{}` or `^{commit}` peel asks for exactly what this returns and is
 * honoured; a peel naming any other type is a revision this caller cannot use,
 * so it is refused rather than quietly stripped.
 *
 * @param repo repository to resolve against
 * @param revision revision as the user spelled it
 */
export async function resolveCommit(repo: Repo, revision: string): Promise<string> {
  const [base, ops] = splitOperators(revision)
  let oid = await namedObject(repo, base, revision)
  // A tag names a tag object, not the commit under it; peel until it is one.
  for (;;) {
    let type: string
    try {
      // Deprecated upstream for being general, but the general answer is
      // what peeling needs: which of commit/tag/tree/blob this id names,
      // without reading it as each in turn until one does not throw.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      type = (await git.readObject({ ...repoArgs(repo), oid })).type
    } catch {
      throw new AmbiguousArgumentError(revision)
    }
    if (type === 'commit') break
    if (type !== 'tag') throw new AmbiguousArgumentError(revision)
    oid = (await git.readTag({ ...repoArgs(repo), oid })).tag.object
  }
  for (const op of ops) {
    if ('want' in op) {
      // A peel this caller can use is one that lands back on a commit: `^{}`
      // and `^{commit}` do, `^{tree}` does not, and refusing the object rather
      // than the spelling is what lets a peel sit in the middle of a chain.
      const found = await peeled(repo, { oid, type: COMMIT }, op.want, revision)
      if (found.type !== COMMIT) throw new AmbiguousArgumentError(revision)
      oid = found.oid
      continue
    }
    oid = await applyStep(repo, oid, op, revision)
  }
  return oid
}

/**
 * Every ref git's rev-parse rules find for a name, in rule order: more than one
 * is a name git calls ambiguous, and the first is the one it reads.
 *
 * @param table every ref, as loadRefs reads them
 * @param name the name as typed
 */
export function refsNamed(table: ReadonlyMap<string, string>, name: string): string[] {
  return [...new Set(DWIM_RULES.map((rule) => rule.replace('{}', name)))].filter((ref) =>
    table.has(ref),
  )
}

/**
 * The object id a revision's base names, a ref read without peeling it or an
 * id, full or abbreviated.
 *
 * A name two refs answer to reads as the first, and git warns that it is
 * ambiguous each time it reads one, which is where the repository's list of
 * warnings gets the line (pinned against git 2.47.3).
 *
 * @param repo repository to resolve against
 * @param base the name or id, operators already split off
 * @param revision the whole revision, for error attribution
 */
async function namedObject(repo: Repo, base: string, revision: string): Promise<string> {
  let oid: string
  try {
    oid = await git.resolveRef({ ...repoArgs(repo), ref: base })
  } catch {
    try {
      return await git.expandOid({ ...repoArgs(repo), oid: base })
    } catch {
      throw new AmbiguousArgumentError(revision)
    }
  }
  await noteAmbiguity(repo, base)
  return oid
}

/**
 * Put git's `refname is ambiguous` warning on the repository's list when two
 * refs answer to a name, as git does each time it reads one.
 *
 * @param repo the opened repository
 * @param name the name as typed
 */
export async function noteAmbiguity(repo: Repo, name: string): Promise<void> {
  if (repo.ambiguous === null) return
  const table = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
  if (refsNamed(table, name).length > 1) {
    repo.ambiguous.push(`warning: refname '${name}' is ambiguous.\n`)
  }
}

/** The type isomorphic-git records for one object id. */
async function typeOf(repo: Repo, oid: string, revision: string): Promise<string> {
  try {
    // Deprecated upstream for being general, but the general answer is what
    // peeling needs: which of commit/tag/tree/blob this id names, without
    // reading it as each in turn until one does not throw.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return (await git.readObject({ ...repoArgs(repo), oid })).type
  } catch {
    throw new AmbiguousArgumentError(revision)
  }
}

/**
 * What an object stands for once every tag wrapper is off.
 *
 * An annotated tag can point at another one, so this is a walk rather than a
 * single hop. Anything that is no tag is already what it stands for and comes
 * back untouched.
 *
 * Every reading that wants a particular kind of object goes through this: a
 * bare id names the tag itself, so a caller asking for a tree-ish or for the
 * tree behind `<rev>:<path>` has one to take off, and git takes it off in both
 * places.
 *
 * @param repo the opened repository
 * @param found the object to unwrap
 * @param revision the whole revision, for error attribution
 */
export async function unwrapped(
  repo: Repo,
  found: GitObject,
  revision: string,
): Promise<GitObject> {
  let { oid, type } = found
  while (type === TAG) {
    oid = (await git.readTag({ ...repoArgs(repo), oid })).tag.object
    type = await typeOf(repo, oid, revision)
  }
  return { oid, type }
}

/**
 * Follow a `^{<type>}` peel from the object the stem named.
 *
 * A tag is unwrapped until the type asked for is reached, which for `^{}` and
 * for every non-tag type means unwrapping it entirely. `^{tag}` is the one
 * spelling that stops before the first hop, so `v1^{tag}` is the tag object
 * itself rather than a refusal saying the commit behind it is no tag.
 * `^{tree}` then takes a commit's tree, git's one implicit step; every other
 * spelling has to already name the type it asks for, so `HEAD^{blob}` is
 * refused rather than answered with something else.
 *
 * A lightweight tag is still refused by `^{tag}`: the name resolves straight to
 * a commit, so there is no tag object to stop at and the type check below is
 * what says so.
 */
async function peeled(
  repo: Repo,
  found: GitObject,
  want: string,
  revision: string,
): Promise<GitObject> {
  // An existence check, not a type. Every object reports a concrete type name,
  // so comparing one against `object` refuses every expression that spells it;
  // gitrevisions(7) has it return the named object and nothing else, which for
  // an annotated tag is the tag rather than the commit behind it.
  if (want === OBJECT) return found
  let { oid, type } = want === TAG ? found : await unwrapped(repo, found, revision)
  if (want === '') return { oid, type }
  if (want === TREE && type === COMMIT) {
    oid = (await git.readCommit({ ...repoArgs(repo), oid })).commit.tree
    type = TREE
  }
  if (type !== want) throw new AmbiguousArgumentError(revision)
  return { oid, type }
}

/**
 * The object a `<rev>:<path>` names inside a tree.
 *
 * @param repo the opened repository
 * @param rev the revision before the colon, HEAD when empty
 * @param path the path after it, repository-relative
 * @param revision the whole revision, for error attribution
 */
async function atPath(repo: Repo, rev: string, path: string, revision: string): Promise<GitObject> {
  let named: GitObject
  try {
    named = await resolveObject(repo, rev)
  } catch (err) {
    if (err instanceof AmbiguousArgumentError) throw new InvalidRevisionNameError(rev)
    throw err
  }
  // A tag is no tree and holds no path, so it comes off first: the rev half is
  // a tree-ish, and `<tag-id>:a.txt` reads the blob through it exactly as
  // `v1:a.txt` does.
  const holder = await unwrapped(repo, named, revision)
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const found = await git.readObject({ ...repoArgs(repo), oid: holder.oid, filepath: path })
    return { oid: found.oid, type: found.type }
  } catch {
    throw new PathNotInRevisionError(path, rev, await onDisk(repo, path))
  }
}

/**
 * Whether a repository-relative path is there in the working tree; a path
 * through a file is not.
 */
async function onDisk(repo: Repo, path: string): Promise<boolean> {
  if (path === '') return false
  try {
    return await exists(repo.dispatch, under(repo.location.worktree, path))
  } catch (err) {
    if (isEnotdir(err)) return false
    throw err
  }
}

/**
 * The object `:<path>` or `:<n>:<path>` names in the index: the staged entry
 * at stage 0, or at the merge stage given. A path the index holds at another
 * stage, or not at all, is refused in git's words (pinned against git
 * 2.50.1).
 *
 * @param repo the opened repository
 * @param spec what follows the leading colon
 */
async function inIndex(repo: Repo, spec: string): Promise<GitObject> {
  const staged = STAGED.exec(spec)
  const stage = staged === null ? 0 : Number(spec.charAt(0))
  const path = staged === null ? spec : spec.slice(staged[0].length)
  const state = await readIndex(repo, repo.dispatch)
  const conflicted = state.conflicts.get(path)
  const stages = [
    state.entries.get(path),
    conflicted?.ancestor,
    conflicted?.this,
    conflicted?.other,
  ]
  const found = stages[stage]
  if (found !== undefined && found !== null) {
    return { oid: found.oid, type: found.mode.toString(8) === GITLINK_MODE ? COMMIT : 'blob' }
  }
  const held = stages.findIndex((entry) => entry !== undefined && entry !== null)
  if (held !== -1) throw new PathNotAtStageError(path, stage, held)
  throw new PathNotInIndexError(path, await onDisk(repo, path))
}

/**
 * The tag object a name or id denotes, null when it names no tag.
 *
 * Read before the stem is resolved, and only for `^{tag}`: every other peel type
 * sits at or below the commit, so unwrapping an annotated tag on the way is
 * git's own rule and costs nothing, while `^{tag}` is the one spelling that has
 * to stop above it. Resolving the stem the ordinary way cannot serve it, because
 * the commit-ish reading peels the tag before anything else sees it.
 *
 * Both spellings a tag answers to are tried, the ref and a raw id, and anything
 * that is not a tag object reads as no tag: a lightweight tag names a commit
 * directly, which is why git refuses `^{tag}` on one.
 */
export async function tagObject(repo: Repo, stem: string): Promise<GitObject | null> {
  let oid: string
  try {
    oid = await git.resolveRef({ ...repoArgs(repo), ref: `${TAG_PREFIX}${stem}` })
  } catch {
    try {
      oid = await git.expandOid({ ...repoArgs(repo), oid: stem })
    } catch {
      return null
    }
  }
  let type: string
  try {
    type = await typeOf(repo, oid, stem)
  } catch {
    return null
  }
  return type === TAG ? { oid, type } : null
}

/**
 * The two ends of `A..B` or `A...B`, or null for one revision.
 *
 * Read the way git's handle_dotdot reads it: the first `..` splits the operand,
 * a dot right after it makes the range symmetric, and an empty end is HEAD, so
 * `..side` is `HEAD..side`.
 */
function rangeEnds(revision: string): [string, string, boolean] | null {
  const at = revision.indexOf(RANGE)
  if (at < 0) return null
  let right = revision.slice(at + RANGE.length)
  const symmetric = right.startsWith(SYMMETRIC_DOT)
  if (symmetric) right = right.slice(SYMMETRIC_DOT.length)
  return [revision.slice(0, at) || HEAD, right || HEAD, symmetric]
}

/**
 * Both ends of a range operand, or null when it names one revision.
 *
 * A lone `..` is a path to git, and mirage limits nothing by path, so it is no
 * range here and fails as the revision it is not. An end that does not resolve
 * fails naming the whole operand, as git's message does.
 *
 * @param repo repository to resolve against
 * @param revision the operand as the user spelled it
 * @returns the left end, the right end and whether the range is symmetric
 */
export async function rangeCommits(
  repo: Repo,
  revision: string,
): Promise<[CommitFacts, CommitFacts, boolean] | null> {
  const ends = revision === RANGE ? null : rangeEnds(revision)
  if (ends === null) return null
  let left: string, right: string
  try {
    left = await resolveCommit(repo, ends[0])
    right = await resolveCommit(repo, ends[1])
  } catch (err) {
    if (err instanceof AmbiguousArgumentError) throw new AmbiguousArgumentError(revision)
    throw err
  }
  return [await commitFacts(repo, left), await commitFacts(repo, right), ends[2]]
}

/**
 * The common ancestors of two commits that nothing shared descends from.
 *
 * git's paint walk: each side paints what it reaches, newest first and first
 * queued on a tie, and a commit wearing both colours is a base whose own
 * ancestry goes stale. The walk ends once every queued commit is stale, and the
 * bases come out in the order git lists them (pinned against
 * `git merge-base --all` 2.50).
 *
 * @param repo repository holding the commits
 * @param one one side
 * @param other the other side
 */
export async function mergeBases(
  repo: Repo,
  one: CommitFacts,
  other: CommitFacts,
): Promise<CommitFacts[]> {
  const paint = new Map<string, number>([[one.oid, LEFT]])
  paint.set(other.oid, (paint.get(other.oid) ?? 0) | RIGHT)
  const queue = one.oid === other.oid ? [one] : [one, other]
  const bases: CommitFacts[] = []
  while (queue.some((commit) => !((paint.get(commit.oid) ?? 0) & STALE))) {
    queue.sort((a, b) => b.committerTime - a.committerTime)
    const commit = queue.shift()
    if (commit === undefined) break
    let flags = paint.get(commit.oid) ?? 0
    if (flags === (LEFT | RIGHT)) {
      bases.push(commit)
      flags |= STALE
      paint.set(commit.oid, flags)
    }
    for (const parent of commit.parents) {
      const had = paint.get(parent) ?? 0
      if ((had & flags) === flags) continue
      paint.set(parent, had | flags)
      queue.push(await commitFacts(repo, parent))
    }
  }
  return bases
}

/**
 * The commits a walk starts from and the commits whose history it hides.
 *
 * `A..B` walks B and hides A, `A...B` walks both and hides their merge bases,
 * and `^A` hides A. An end that does not resolve fails naming the whole range,
 * and a negation that does not resolve is git's "bad revision", as is a negated
 * range (pinned against git 2.50).
 *
 * @param repo repository to resolve against
 * @param revisions the revision operands as spelled
 * @returns the commits to walk from and the commits to hide
 */
export async function splitRevisions(
  repo: Repo,
  revisions: readonly string[],
): Promise<[CommitFacts[], CommitFacts[]]> {
  const shown: CommitFacts[] = []
  const hidden: CommitFacts[] = []
  for (const revision of revisions) {
    if (revision.startsWith(NEGATION)) {
      const name = revision.slice(NEGATION.length)
      if (!name || name.includes(RANGE)) throw new BadRevisionError(revision)
      let oid: string
      try {
        oid = await resolveCommit(repo, name)
      } catch (err) {
        if (err instanceof AmbiguousArgumentError) throw new BadRevisionError(revision)
        throw err
      }
      hidden.push(await commitFacts(repo, oid))
      continue
    }
    const ends = await rangeCommits(repo, revision)
    if (ends === null) {
      shown.push(await commitFacts(repo, await resolveCommit(repo, revision)))
      continue
    }
    const [left, right, symmetric] = ends
    if (symmetric) {
      shown.push(left, right)
      hidden.push(...(await mergeBases(repo, left, right)))
    } else {
      shown.push(right)
      hidden.push(left)
    }
  }
  return [shown, hidden]
}

/**
 * The object a revision names, whatever type it turns out to be.
 *
 * The whole grammar a caller that wants an object rather than a commit has to
 * read: `HEAD:a.txt` is the blob at a path, `HEAD^{tree}` is a commit's tree,
 * `v1^{}` is what a tag points at, and a bare id of any type is itself. A
 * commit-ish is tried first because that is what the operand is normally spelled
 * with, and it is the only reading that understands ancestry.
 *
 * @param repo repository to resolve against
 * @param revision revision as the user spelled it
 */
export async function resolveObject(repo: Repo, revision: string): Promise<GitObject> {
  const mark = revision.indexOf(PATH_MARK)
  if (mark === 0) return inIndex(repo, revision.slice(1))
  if (mark > 0) return atPath(repo, revision.slice(0, mark), revision.slice(mark + 1), revision)
  const [base, ops] = splitOperators(revision)
  if (ops.length === 0) {
    // A name or id stands for exactly the object it names, so an annotated
    // tag is the tag rather than the commit behind it: git does not peel one
    // until a caller asks for a commit-ish, and `git rev-parse v1` prints the
    // tag's id.
    const oid = await namedObject(repo, revision, revision)
    return { oid, type: await typeOf(repo, oid, revision) }
  }
  // Every operator but `^{tag}` and `^{object}` unwraps a tag, which is git's
  // own rule and costs nothing here.
  let obj = await resolveObject(repo, base)
  for (const op of ops) {
    if ('want' in op) {
      obj = await peeled(repo, obj, op.want, revision)
      continue
    }
    const commit = await unwrapped(repo, obj, revision)
    if (commit.type !== COMMIT) throw new AmbiguousArgumentError(revision)
    obj = { oid: await applyStep(repo, commit.oid, op, revision), type: COMMIT }
  }
  return obj
}
