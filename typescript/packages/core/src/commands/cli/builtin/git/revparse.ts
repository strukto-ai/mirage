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

import git, { Errors } from 'isomorphic-git'
import { DWIM_RULES, GITLINK_MODE, HEAD, LOGS_DIR } from './constants.ts'

import {
  AmbiguousArgumentError,
  BadRevisionError,
  InvalidRevisionNameError,
  PathNotAtStageError,
  PathNotInIndexError,
  PathNotInRevisionError,
  SelectorError,
} from './errors.ts'
import { readIndex } from './index_file.ts'
import { exists, readOptional } from './io.ts'
import { visiblePath } from './pathspec.ts'

import { isEnotdir } from '../../../../errors/fs.ts'
import type { CommitFacts } from './format.ts'
import { MINIMUM_ABBREV } from './ref_fields.ts'
import { BRANCH_PREFIX, loadRefs, mapped, parseRefspec, SYMREF_PREFIX, TAG_PREFIX } from './refs.ts'
import { commitFacts, rawObject, refOid, repoArgs, storedItems, type Repo } from './repo.ts'
import { decoded, guarded, located, placeOf, placed, rooted } from './seen.ts'
import type { AncestryStep, GitObject, RefUpstream, RevOp } from './types.ts'
import { configValues } from './fs.ts'

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
export const RANGE = '..'
const SYMMETRIC_DOT = '.'
export const NEGATION = '^'
// `@` alone is HEAD, and `<name>@{...}` reads a reflog entry, an earlier branch,
// or the ref a branch tracks.
const CURRENT = '@'
export const SELECTOR_OPEN = '@{'
const SELECTOR_CLOSE = '}'
const UPSTREAM_WORDS = new Set(['u', 'upstream'])
const PUSH_WORD = 'push'
const MOVED_FROM = 'checkout: moving from '
const MOVED_TO = ' to '

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
  } catch (err) {
    if (err instanceof Errors.NotFoundError || err instanceof Errors.ObjectTypeError)
      throw new AmbiguousArgumentError(revision)
    throw err
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
  const named = await namedObject(repo, base, revision)
  // A tag names a tag object, not the commit under it; peel until it is one.
  const start = await unwrapped(repo, await objectById(repo, named, revision), revision)
  if (start.type !== COMMIT) throw new AmbiguousArgumentError(revision)
  let oid = start.oid
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
export function refsNamed(table: { has(name: string): boolean }, name: string): string[] {
  return [...new Set(DWIM_RULES.map((rule) => rule.replace('{}', name)))].filter((ref) =>
    table.has(ref),
  )
}

/**
 * The object id a revision's base names, a ref read without peeling it or an
 * id, full or abbreviated; an abbreviation shorter than four hex digits names
 * nothing, however few objects it would match (git 2.47.3).
 *
 * A name two refs answer to reads as the first, and git warns that it is
 * ambiguous each time it reads one, which is where the repository's list of
 * warnings gets the line (pinned against git 2.47.3).
 *
 * @param repo repository to resolve against
 * @param base the name or id, operators already split off
 * @param revision the whole revision, for error attribution
 */
async function namedObject(repo: Repo, spelled: string, revision: string): Promise<string> {
  const base = await expandSelector(repo, spelled, revision)
  let oid: string
  try {
    oid = await refOid(repo, base)
  } catch (err) {
    if (!(err instanceof Errors.NotFoundError)) throw err
    if (base.length < MINIMUM_ABBREV) throw new AmbiguousArgumentError(revision)
    try {
      return await git.expandOid({ ...repoArgs(repo), oid: base })
    } catch (missed) {
      if (missed instanceof Errors.NotFoundError || missed instanceof Errors.AmbiguousError)
        throw new AmbiguousArgumentError(revision)
      throw missed
    }
  }
  await noteAmbiguity(repo, base)
  return oid
}

/**
 * The ref a branch's upstream lands in.
 * `branch.<name>.merge` is mapped through the remote's fetch refspecs; a branch
 * following a remote with none that map it has no upstream at all, and one
 * following `.` follows a local ref.
 */
export async function trackingRef(
  repo: Repo,
  branch: string,
  known: ReadonlySet<string>,
): Promise<RefUpstream | null> {
  const values = (path: string): Promise<string[]> => configValues(repo.vfs, repo.location, path)
  const remote = (await values(`branch.${branch}.remote`)).at(-1)
  const merge = (await values(`branch.${branch}.merge`))[0]
  if (remote === undefined || merge === undefined) return null
  const up = { remote, merge, ahead: 0, behind: 0, gone: false }
  const target = await fetchedAs(repo, remote, merge)
  if (target !== null) return { ...up, ref: target }
  if (remote !== '.') return null
  return { ...up, ref: refsNamed(known, merge)[0] ?? merge }
}

/** Where a remote's fetch refspecs put one of its refs, null when none does. */
async function fetchedAs(repo: Repo, remote: string, name: string): Promise<string | null> {
  for (const text of await configValues(repo.vfs, repo.location, `remote.${remote}.fetch`)) {
    const spec = parseRefspec(text)
    if (spec.src.startsWith('^')) continue
    const target = mapped(spec, name)
    if (target) return target
  }
  return null
}

function headBranch(table: ReadonlyMap<string, string>): string | null {
  const raw = table.get(HEAD) ?? ''
  if (!raw.startsWith(SYMREF_PREFIX)) return null
  const target = raw.slice(SYMREF_PREFIX.length).trim()
  return target.startsWith(BRANCH_PREFIX) ? target.slice(BRANCH_PREFIX.length) : target
}

/** A ref's reflog, oldest first, null when it has none. */
async function logRows(repo: Repo, ref: string): Promise<string[] | null> {
  const root = ref === HEAD ? repo.location.gitdir : repo.location.commondir
  const data = await readOptional(repo.vfs, root.join(LOGS_DIR, ref))
  if (data === null) return null
  return new TextDecoder().decode(data).split('\n').filter(Boolean)
}

/**
 * The id a ref held `count` moves ago, as its reflog tells it.
 *
 * @param stem the name before the selector; empty for the current branch, or
 *   HEAD itself when detached
 * @param count how many entries back
 * @param revision the whole revision, which a failure names
 * @throws AmbiguousArgumentError the name has no reflog
 */
async function loggedId(
  repo: Repo,
  stem: string,
  count: number,
  revision: string,
): Promise<string> {
  const table = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
  const branch = stem === '' ? headBranch(table) : null
  const shown = stem === '' ? (branch ?? HEAD) : stem
  const names = branch !== null ? [`${BRANCH_PREFIX}${branch}`] : refsNamed(table, shown)
  for (const ref of names) {
    const rows = await logRows(repo, ref)
    if (rows === null) continue
    if (count >= rows.length)
      throw new SelectorError(`log for '${shown}' only has ${String(rows.length)} entries`)
    return rows[rows.length - 1 - count]?.split(' ')[1] ?? ''
  }
  throw new AmbiguousArgumentError(revision)
}

/**
 * The branch or commit HEAD left `count` checkouts ago.
 *
 * @throws AmbiguousArgumentError HEAD has not moved that many times
 */
async function previousBranch(repo: Repo, count: number, revision: string): Promise<string> {
  let seen = 0
  for (const row of ((await logRows(repo, HEAD)) ?? []).reverse()) {
    const message = row.slice(row.indexOf('\t') + 1)
    if (!message.startsWith(MOVED_FROM)) continue
    seen += 1
    if (seen === count) {
      const rest = message.slice(MOVED_FROM.length)
      return rest.slice(0, rest.indexOf(MOVED_TO))
    }
  }
  throw new AmbiguousArgumentError(revision)
}

/**
 * The branch `<stem>@{upstream}` asks about.
 *
 * @throws SelectorError HEAD is on no branch, or no such branch exists
 */
async function selectedBranch(repo: Repo, stem: string): Promise<string> {
  const table = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
  if (stem === '' || stem === HEAD) {
    const branch = headBranch(table)
    if (branch === null) throw new SelectorError('HEAD does not point to a branch')
    return branch
  }
  if (!table.has(`${BRANCH_PREFIX}${stem}`)) throw new SelectorError(`no such branch: '${stem}'`)
  return stem
}

/**
 * The ref a branch tracks.
 *
 * @throws SelectorError none is configured, or the remote does not store it
 */
async function upstreamOf(repo: Repo, branch: string): Promise<RefUpstream> {
  const values = (path: string): Promise<string[]> => configValues(repo.vfs, repo.location, path)
  const merge = (await values(`branch.${branch}.merge`))[0]
  if ((await values(`branch.${branch}.remote`)).length === 0 || merge === undefined)
    throw new SelectorError(`no upstream configured for branch '${branch}'`)
  const found = await trackingRef(
    repo,
    branch,
    new Set((await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)).keys()),
  )
  if (found === null)
    throw new SelectorError(`upstream branch '${merge}' not stored as a remote-tracking branch`)
  return found
}

/**
 * The remote-tracking ref a push of a branch would update, as `push.default`
 * says; `simple` is the default.
 *
 * @throws SelectorError the branch has no such destination
 */
/** The commits a shallow repository holds without their parents. */
export async function shallowCommits(repo: Repo): Promise<Set<string>> {
  const data = await readOptional(repo.vfs, repo.location.commondir.join('shallow'))
  return new Set(
    new TextDecoder()
      .decode(data ?? new Uint8Array())
      .trim()
      .split(/\s+/),
  )
}

/** The remote a branch pushes to, by the settings in git's order. */
async function pushRemote(repo: Repo, branch: string): Promise<string> {
  const values = (path: string): Promise<string[]> => configValues(repo.vfs, repo.location, path)
  for (const key of [
    `branch.${branch}.pushRemote`,
    'remote.pushDefault',
    `branch.${branch}.remote`,
  ]) {
    const named = (await values(key)).at(-1)
    if (named !== undefined) return named
  }
  return 'origin'
}

/** Where a remote's push refspecs send a branch; null without any. */
async function pushedAs(repo: Repo, remote: string, branch: string): Promise<string | null> {
  const texts = await configValues(repo.vfs, repo.location, `remote.${remote}.push`)
  if (texts.length === 0) return null
  const specs = texts.map((text) => {
    const spec = parseRefspec(text)
    if (spec.dst && spec.src.includes('*') !== spec.dst.includes('*'))
      throw new SelectorError(`invalid refspec '${text}'`)
    return spec
  })
  for (const spec of specs) {
    const target = mapped(spec, `${BRANCH_PREFIX}${branch}`)
    if (target) return target
  }
  throw new SelectorError(`push refspecs for '${remote}' do not include '${branch}'`)
}

async function pushTarget(repo: Repo, branch: string, revision: string): Promise<string> {
  const values = (path: string): Promise<string[]> => configValues(repo.vfs, repo.location, path)
  const full = `${BRANCH_PREFIX}${branch}`
  const mode = (await values('push.default')).at(-1)?.toLowerCase() ?? 'simple'
  const remote = await pushRemote(repo, branch)
  const destination = await pushedAs(repo, remote, branch)
  if (destination !== null) {
    const tracked = await fetchedAs(repo, remote, destination)
    if (tracked === null)
      throw new SelectorError(
        `push destination '${destination}' on remote '${remote}' has no local tracking branch`,
      )
    return tracked
  }
  if (mode === 'nothing')
    throw new SelectorError("push has no destination (push.default is 'nothing')")
  if (mode === 'current' || mode === 'matching') {
    const target = await fetchedAs(repo, remote, full)
    if (target === null) throw new AmbiguousArgumentError(revision)
    return target
  }
  const upstream = await upstreamOf(repo, branch)
  if (mode === 'upstream') return upstream.ref
  const pushes = await values(`branch.${branch}.pushRemote`)
  const named = pushes.length > 0 ? pushes : await values('remote.pushDefault')
  const away = named.at(-1) ?? upstream.remote
  if ((await fetchedAs(repo, away, full)) === null)
    throw new SelectorError(
      `push destination '${full}' on remote '${away}' has no local tracking branch`,
    )
  if (away !== upstream.remote || upstream.merge !== full)
    throw new SelectorError("cannot resolve 'simple' push to a single destination")
  return upstream.ref
}

/**
 * What a name reads as once `@` and any `@{...}` are read.
 *
 * A plain name comes back as it is. `@{n}` becomes the id the ref held n moves
 * ago, `@{-n}` the n-th branch left behind, and `@{upstream}` and `@{push}` the
 * remote-tracking ref. A selector git reads as a date is not built, and names
 * nothing.
 *
 * @param repo the opened repository
 * @param name the name, operators already split off
 * @param revision the whole revision, which a failure names
 * @throws AmbiguousArgumentError the selector names nothing
 * @throws SelectorError the selector is one git refuses in its own words
 */
export async function expandSelector(repo: Repo, name: string, revision: string): Promise<string> {
  if (name === CURRENT) return HEAD
  const at = name.lastIndexOf(SELECTOR_OPEN)
  if (at < 0 || !name.endsWith(SELECTOR_CLOSE)) return name
  const stem = at > 0 ? await expandSelector(repo, name.slice(0, at), revision) : ''
  const inner = name.slice(at + SELECTOR_OPEN.length, -SELECTOR_CLOSE.length)
  const word = inner.toLowerCase()
  if (/^[0-9]+$/.test(inner)) return loggedId(repo, stem, Number(inner), revision)
  if (
    stem === '' &&
    inner.startsWith('-') &&
    /^[0-9]+$/.test(inner.slice(1)) &&
    Number(inner.slice(1)) > 0
  )
    return previousBranch(repo, Number(inner.slice(1)), revision)
  if (UPSTREAM_WORDS.has(word))
    return (await upstreamOf(repo, await selectedBranch(repo, stem))).ref
  if (word === PUSH_WORD) return pushTarget(repo, await selectedBranch(repo, stem), revision)
  throw new AmbiguousArgumentError(revision)
}

/**
 * The tree a revision stands for, a commit's or a tree's own.
 *
 * @throws AmbiguousArgumentError it names something with no tree
 */
export async function treeId(repo: Repo, revision: string): Promise<string> {
  const found = await unwrapped(repo, await resolveObject(repo, revision), revision)
  if (found.type === COMMIT) return (await commitFacts(repo, found.oid)).tree
  if (found.type === 'tree') return found.oid
  throw new AmbiguousArgumentError(revision)
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
  const table = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
  if (refsNamed(table, name).length > 1) {
    repo.ambiguous.push(`warning: refname '${name}' is ambiguous.\n`)
  }
}

/** Load one object by id, or report the revision as unknown. */
async function objectById(repo: Repo, oid: string, revision: string): Promise<GitObject> {
  try {
    return { oid, type: (await rawObject(repo, oid)).type }
  } catch (err) {
    if (err instanceof Errors.NotFoundError) throw new AmbiguousArgumentError(revision)
    throw err
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
  const tagged = type === TAG
  while (type === TAG) {
    oid = (await git.readTag({ ...repoArgs(repo), oid })).tag.object
    type = (await objectById(repo, oid, revision)).type
  }
  if (tagged && (await located(repo, { oid, type })) === null)
    throw new AmbiguousArgumentError(revision)
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
    rooted(repo, oid, revision)
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
  let holder = await unwrapped(repo, named, revision)
  if (holder.type === COMMIT) {
    const tree = (await git.readCommit({ ...repoArgs(repo), oid: holder.oid })).commit.tree
    rooted(repo, tree)
    holder = { oid: tree, type: TREE }
  }
  let found = holder
  try {
    if (holder.type !== TREE) throw new Errors.NotFoundError(path)
    // Every tree the path passes through has its entries read, as git reads
    // them. The type is the stored object's, since an entry's mode can claim
    // anything and only a blob answers to a read rule.
    for (const part of path.split('/').filter(Boolean)) {
      const items = found.type === TREE ? decoded(await storedItems(repo, found.oid)) : []
      const entry = items.find((item) => item.path === part)
      if (entry === undefined) throw new Errors.NotFoundError(path)
      found = { oid: entry.oid, type: (await rawObject(repo, entry.oid)).type }
    }
  } catch (err) {
    if (err instanceof Errors.NotFoundError)
      throw new PathNotInRevisionError(path, rev, await onDisk(repo, path))
    throw err
  }
  // The path is the tree's own, so it stands where the tree does: a commit's
  // at the root, a subtree named by id where it was found. A hidden place is
  // one the history never had, in the same words.
  const base = await placeOf(repo, holder.oid)
  const place = base ? `${base}/${path}` : path
  if (guarded(repo) && !visiblePath(repo.location, place))
    throw new PathNotInRevisionError(path, rev, false)
  return placed(repo, found, place, revision)
}

/**
 * Whether a repository-relative path is there in the working tree; a path
 * through a file is not.
 */
async function onDisk(repo: Repo, path: string): Promise<boolean> {
  if (path === '') return false
  try {
    return await exists(repo.vfs, repo.location.worktree.join(path))
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
  // A hidden place is one the index never held, in the same words.
  if (guarded(repo) && !visiblePath(repo.location, path)) throw new PathNotInIndexError(path, false)
  const state = await readIndex(repo, repo.vfs)
  const conflicted = state.conflicts.get(path)
  const stages = [
    state.entries.get(path),
    conflicted?.ancestor,
    conflicted?.this,
    conflicted?.other,
  ]
  const found = stages[stage]
  if (found !== undefined && found !== null) {
    const type = found.mode.toString(8) === GITLINK_MODE ? COMMIT : 'blob'
    return placed(repo, { oid: found.oid, type }, path, PATH_MARK + spec)
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
    oid = await refOid(repo, `${TAG_PREFIX}${stem}`)
  } catch (err) {
    if (!(err instanceof Errors.NotFoundError)) throw err
    if (stem.length < MINIMUM_ABBREV) return null
    try {
      oid = await git.expandOid({ ...repoArgs(repo), oid: stem })
    } catch (missed) {
      if (missed instanceof Errors.NotFoundError || missed instanceof Errors.AmbiguousError)
        return null
      throw missed
    }
  }
  let found: GitObject
  try {
    found = await objectById(repo, oid, stem)
  } catch (err) {
    if (err instanceof AmbiguousArgumentError) return null
    throw err
  }
  return found.type === TAG ? found : null
}

/**
 * The two ends of `A..B` or `A...B`, or null for one revision.
 *
 * Read the way git reads a range: the first `..` splits the operand,
 * a dot right after it makes the range symmetric, and an empty end is HEAD, so
 * `..side` is `HEAD..side`.
 */
export function rangeEnds(revision: string): [string, string, boolean] | null {
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

/** Put `commit` in `queue`: newest first, and in arrival order among equal dates. */
function enqueueByDate(queue: CommitFacts[], commit: CommitFacts): void {
  let at = queue.length
  while (at > 0 && (queue[at - 1]?.committerTime ?? 0) < commit.committerTime) at -= 1
  queue.splice(at, 0, commit)
}

/**
 * The common ancestors of two commits that nothing shared descends from.
 *
 * git-merge-base(1)'s best common ancestors: a common ancestor is better than
 * any of its own ancestors, and the bases are the common ancestors nothing is
 * better than. The other side is a hypothetical merge of `other` and `others`.
 * A newest-first climb spreads each side's reach down from its tips and stops
 * where both sides meet: everything beneath a meeting is common and worse, so a
 * second walk marks it for the climb to drop. A separate ancestry pass removes
 * redundant candidates without relying on commit timestamps. History shared by
 * every candidate cannot remove any of them. Bases come out newest first, equal
 * dates in the order the climb met them (pinned against `git merge-base --all`
 * 2.50.1).
 *
 * @param repo repository holding the commits
 * @param one one side
 * @param other the other side
 * @param others further tips of the hypothetical merged side
 */
export async function mergeBases(
  repo: Repo,
  one: CommitFacts,
  other: CommitFacts,
  others: readonly CommitFacts[] = [],
): Promise<CommitFacts[]> {
  const shallow = await shallowCommits(repo)
  const tips = [one, other, ...others]
  const known = new Map(tips.map((commit) => [commit.oid, commit]))
  const load = async (oid: string): Promise<CommitFacts> => {
    let commit = known.get(oid)
    if (commit === undefined) {
      commit = await commitFacts(repo, oid)
      known.set(oid, commit)
    }
    return commit
  }
  const parentsOf = async (oid: string): Promise<readonly string[]> =>
    shallow.has(oid) ? [] : (await load(oid)).parents
  // What `one` reaches, what the merged side reaches, and what lies beneath a
  // commit both reach.
  const fromOne = new Set([one.oid])
  const fromRest = new Set([other, ...others].map((commit) => commit.oid))
  const beneath = new Set<string>()
  const climbing: CommitFacts[] = []
  const sinking: CommitFacts[] = []
  const sinkBelow = async (oid: string): Promise<void> => {
    for (const parentId of await parentsOf(oid)) {
      if (beneath.has(parentId)) continue
      beneath.add(parentId)
      enqueueByDate(sinking, await load(parentId))
    }
  }
  for (const tip of known.values()) enqueueByDate(climbing, tip)
  const meetings = new Map<string, CommitFacts>()
  for (let commit = climbing.shift(); commit !== undefined; commit = climbing.shift()) {
    // Mark what lies beneath the meetings down to the climb's date, so the
    // climb drops a commit beneath one before it spreads further.
    for (
      let low = sinking[0];
      low !== undefined && low.committerTime >= commit.committerTime;
      low = sinking[0]
    ) {
      sinking.shift()
      await sinkBelow(low.oid)
    }
    if (beneath.has(commit.oid)) continue
    const onOne = fromOne.has(commit.oid)
    if (onOne && fromRest.has(commit.oid)) {
      if (!meetings.has(commit.oid)) {
        meetings.set(commit.oid, commit)
        await sinkBelow(commit.oid)
      }
      continue
    }
    const reach = onOne ? fromOne : fromRest
    for (const parentId of await parentsOf(commit.oid)) {
      if (reach.has(parentId)) continue
      reach.add(parentId)
      enqueueByDate(climbing, await load(parentId))
    }
  }
  const candidates = [...meetings.values()]
    .filter((commit) => !beneath.has(commit.oid))
    .sort((a, b) => b.committerTime - a.committerTime)
  if (candidates.length <= 1) return candidates
  const origins = new Map(candidates.map((commit, i) => [commit.oid, 1n << BigInt(i)]))
  const reached = new Map(origins)
  const pending = [...origins.keys()]
  const redundant = new Set<string>()
  const allOrigins = (1n << BigInt(candidates.length)) - 1n
  while (pending.length > 0) {
    const oid = pending.shift()
    if (oid === undefined) break
    const flags = reached.get(oid) ?? 0n
    if (origins.has(oid) && flags !== origins.get(oid)) redundant.add(oid)
    if (flags === allOrigins || shallow.has(oid)) continue
    for (const parent of (await commitFacts(repo, oid)).parents) {
      const had = reached.get(parent) ?? 0n
      if ((had | flags) !== had) {
        reached.set(parent, had | flags)
        pending.push(parent)
      }
    }
  }
  return candidates.filter((commit) => !redundant.has(commit.oid))
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
      for (const item of await mergeBases(repo, left, right)) hidden.push(item)
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
  // A name or id stands for exactly the object it names, so an annotated tag
  // is the tag rather than the commit behind it: git does not peel one until a
  // caller asks for a commit-ish, and `git rev-parse v1` prints the tag's id.
  // Every operator but `^{tag}` and `^{object}` unwraps a tag, which is git's
  // own rule and costs nothing here. A base that names nothing fails naming the
  // whole revision, as git's does.
  const named = await namedObject(repo, ops.length === 0 ? revision : base, revision)
  let obj = await objectById(repo, named, revision)
  // An id, or a ref pointing past every commit, names an object with no place:
  // it is shown where the session sees it, else names nothing.
  if ((await located(repo, obj)) === null) throw new AmbiguousArgumentError(revision)
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
