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
import git from 'isomorphic-git'
import { DWIM_RULES, HEAD } from './constants.ts'
import { dateClock } from './dates.ts'
import { configValues } from './fs.ts'

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  AmbiguousArgumentError,
  AmbiguousObjectNameError,
  BranchExistsError,
  BranchNameRequiredError,
  BranchPointError,
  CheckedOutBranchError,
  GitError,
  InvalidBranchNameError,
  InvalidObjectNameError,
  NoBranchError,
  NoWorkspaceError,
  RefDeleteReadOnlyError,
  RefLockError,
  RefReadOnlyError,
  UnmergedBranchError,
  UsageError,
} from './errors.ts'
import { parseFlags, select } from './history.ts'
import { short } from './format.ts'
import { readOptional, writeFile } from './io.ts'

import { blockingRef, deleteRef, loadRefs, readHead, validRefName, writeRef } from './refs.ts'
import { filterWords, refFilter, withoutFilterValues, type RefFilter } from './ref_filter.ts'
import { displayWidth, formatRefs, listingFormat, usedFields } from './ref_format.ts'
import {
  configuredSort,
  headDescription,
  listingResult,
  matchShort,
  refListing,
  sortKeys,
} from './ref_list.ts'
import { commitFacts, configBool, repoArgs, type Repo } from './repo.ts'
import { opened } from './session.ts'
import {
  COMMIT,
  noteAmbiguity,
  refsNamed,
  resolveCommit,
  resolveObject,
  unwrapped,
} from './revparse.ts'
import { append, entry, IDENTITY, logged, ZERO } from './reflog.ts'
import {
  RefKind,
  Track,
  type Dispatch,
  type GitObject,
  type HeadRef,
  type ReadOnlyRefusal,
  type RefItem,
  type Upstream,
} from './types.ts'
import { checkSwitches, configSection, fatal, gitBool, verbUsage, withoutSection } from './util.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const NEWLINE = 0x0a
const HEADS_PREFIX = 'refs/heads/'
const REMOTES_PREFIX = 'refs/remotes/'
const REMOTE = 'remotes/'
const AUTO_SETUP_MERGE = 'branch.autosetupmerge'
const TRACK_WORDS: ReadonlyMap<string, Track> = new Map([
  ['always', Track.ALWAYS],
  ['simple', Track.SIMPLE],
  ['inherit', Track.INHERIT],
])

/**
 * Refuse a start point two refs answer to, as git's branch creation does while
 * `core.warnAmbiguousRefs` is on, after warning that it is ambiguous. With no
 * start point git starts from the current branch by its short name, so that
 * name is the one checked.
 *
 * @param repo the opened repository
 * @param name the start point as typed, or the current branch's short name
 * @param warned whether reading it already put the warning on the list
 */
export async function refuseAmbiguous(repo: Repo, name: string, warned: boolean): Promise<void> {
  if (!(await configBool(repo, 'core.warnAmbiguousRefs', true))) return
  const table = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
  if (refsNamed(table, name).length <= 1) return
  if (!warned) await noteAmbiguity(repo, name)
  throw new AmbiguousObjectNameError(name)
}

/** Point a new branch at a commit, refusing to move an existing one. */
async function create(
  dispatch: Dispatch,
  repo: Repo,
  refs: ReadonlyMap<string, string>,
  name: string,
  start: string | undefined,
  mode: Track,
  head: HeadRef,
): Promise<[string, string]> {
  // Before the start point resolves, which is git's order here and the
  // opposite of switch's. A ref is a path below .git, so an unchecked name
  // reaches writeRef as one.
  if (!validRefName(name)) throw new InvalidBranchNameError(name)
  const ref = `${HEADS_PREFIX}${name}`
  if (refs.has(ref)) throw new BranchExistsError(name)
  // With no start point git starts from the current branch by its short name,
  // or from HEAD when it is detached, and it is that name the refusals and the
  // new branch's log speak of.
  const from = start ?? head.branch ?? HEAD
  let found: GitObject
  try {
    found = await resolveObject(repo, from)
  } catch (err) {
    if (err instanceof AmbiguousArgumentError) throw new InvalidObjectNameError(from)
    throw err
  }
  await refuseAmbiguous(repo, from, true)
  const commit = await unwrapped(repo, found, from)
  if (commit.type !== COMMIT) throw new BranchPointError(commit.oid, commit.type, from)
  const oid = commit.oid
  // Last, as it is for git: a ref whose path another ref already holds fails
  // when the lock is taken, so a bad start point is reported first.
  const held = blockingRef(new Set(refs.keys()), ref)
  if (held !== null) throw new RefLockError(ref, held)
  await writeRef(dispatch, repo.location.commondir, ref, oid)
  const log = repo.location.commondir.join('logs', ref)
  if (await logged(dispatch, repo.location, ref, log)) {
    const when = Math.floor(Date.now() / 1000)
    const line = entry(ZERO, oid, IDENTITY, when, `branch: Created from ${from}`)
    await append(dispatch, repo.location.commondir, `logs/${ref}`, line)
  }
  return setUpTracking(repo, name, start ?? null, mode, head)
}

/**
 * The one remote-tracking branch a missing branch name guesses at:
 * `checkout <name>` and `switch <name>` with no such branch create it from
 * `<remote>/<name>` when exactly one remote has one.
 */
export async function remoteBranch(repo: Repo, name: string): Promise<string | null> {
  const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
  const depth = 3 + name.split('/').length - 1
  const found = [...refs.keys()].filter(
    (ref) =>
      ref.startsWith(REMOTES_PREFIX) &&
      ref.endsWith(`/${name}`) &&
      ref.split('/').length - 1 === depth,
  )
  return found.length === 1 ? (found[0] ?? null) : null
}

/**
 * `branch.autoSetupMerge` from the repository's config.
 *
 * The words are case-sensitive and anything else reads as a boolean, so
 * `never` or `Always` is a bad boolean. git reads the variable before any
 * command runs, so a verb that can create a branch reads it first and fails
 * with nothing written (pinned against git 2.50.1).
 */
export async function trackMode(repo: Repo): Promise<Track> {
  let mode = Track.REMOTE
  for (const value of await configValues(repo.dispatch, repo.location, AUTO_SETUP_MERGE)) {
    mode =
      TRACK_WORDS.get(value) ??
      (gitBool([value], AUTO_SETUP_MERGE, true) ? Track.REMOTE : Track.OFF)
  }
  return mode
}

/**
 * The upstream a new branch takes from its start ref, as git picks it.
 *
 * Returns the remote (`.` for a local branch, null for no upstream), the merge
 * refs, what the note puts before each one, and a warning. git names a local
 * upstream bare when it picked the branch itself but `./<branch>` when it
 * copied the remote from another branch.
 */
async function tracked(
  repo: Repo,
  ref: string,
  branch: string,
  mode: Track,
): Promise<[string | null, string[], string, string]> {
  const values = (path: string): Promise<string[]> =>
    configValues(repo.dispatch, repo.location, path)
  if (ref.startsWith(HEADS_PREFIX)) {
    const source = ref.slice(HEADS_PREFIX.length)
    if (mode === Track.ALWAYS) return ['.', [ref], '', '']
    if (mode !== Track.INHERIT) return [null, [], '', '']
    const remotes = await values(`branch.${source}.remote`)
    const merges = await values(`branch.${source}.merge`)
    const missing = !remotes.length
      ? 'no remote is set'
      : !merges.length
        ? 'no merge configuration is set'
        : ''
    if (missing)
      return [null, [], '', `warning: asked to inherit tracking from '${source}', but ${missing}\n`]
    const remote = remotes.at(-1) ?? '.'
    return [remote, merges, `${remote}/`, '']
  }
  if (!ref.startsWith(REMOTES_PREFIX)) return [null, [], '', '']
  const rest = ref.slice(REMOTES_PREFIX.length)
  const slash = rest.indexOf('/')
  const remote = rest.slice(0, slash)
  const name = rest.slice(slash + 1)
  if (slash < 0 || !name || name === HEAD) return [null, [], '', '']
  if (!(await values(`remote.${remote}.url`)).length) return [null, [], '', '']
  if (mode === Track.INHERIT)
    return [
      null,
      [],
      '',
      `warning: asked to inherit tracking from '${ref}', but no remote is set\n`,
    ]
  if (mode === Track.SIMPLE && name !== branch) return [null, [], '', '']
  return [remote, [`${HEADS_PREFIX}${name}`], `${remote}/`, '']
}

/**
 * Record a new branch's upstream as `branch.autoSetupMerge` asks.
 *
 * A start point naming `<remote>/<branch>` of a configured remote writes
 * `branch.<new>.remote` and `.merge` unless the mode is `false`; `always` also
 * tracks a local branch through remote `.`, and no start point means the
 * branch HEAD was on. Returns the note git prints on stdout and any warning for
 * stderr (pinned against git 2.47.3 and 2.50.1).
 *
 * @param head HEAD before the branch was made, which a missing start point
 *   stands for
 */
export async function setUpTracking(
  repo: Repo,
  branch: string,
  start: string | null,
  mode: Track,
  head: HeadRef,
): Promise<[string, string]> {
  if (mode === Track.OFF) return ['', '']
  const typed = start ?? HEAD
  let ref: string | null | undefined
  if (typed === HEAD) ref = head.ref
  else {
    const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
    ref = DWIM_RULES.map((rule) => rule.replace('{}', typed)).find((name) => refs.has(name))
  }
  if (ref === null || ref === undefined) return ['', '']
  const [remote, merges, prefix, warning] = await tracked(repo, ref, branch, mode)
  if (remote === null) return ['', warning]
  const path = repo.location.commondir.join('config')
  const data = (await readOptional(repo.dispatch, path)) ?? new Uint8Array()
  const section = configSection('branch', branch, [
    ['remote', remote],
    ...merges.map((merge): [string, string] => ['merge', merge]),
  ])
  const tail = data.length && data[data.length - 1] !== NEWLINE ? '\n' : ''
  await writeFile(repo.dispatch, path, new Uint8Array([...data, ...ENC.encode(tail + section)]))
  const labels = merges.map((merge) => `${prefix}${merge.replace(/^refs\/heads\//, '')}`)
  if (labels.length === 1) return [`branch '${branch}' set up to track '${labels[0] ?? ''}'.\n`, '']
  return [
    `branch '${branch}' set up to track:\n${labels.map((label) => `  ${label}\n`).join('')}`,
    '',
  ]
}

/**
 * The commit HEAD resolves to, null on an unborn branch.
 *
 * HEAD carries an object id only when detached; attached it names a ref, which
 * is unset until the first commit.
 */
export function headCommit(refs: ReadonlyMap<string, string>, head: HeadRef): string | null {
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
  if (name === head.branch) throw new CheckedOutBranchError(name, repo.location.worktree.virtual)
  if (!force && !(await merged(repo, sha, headCommit(refs, head)))) {
    throw new UnmergedBranchError(name)
  }
  await deleteRef(dispatch, repo.location.commondir, ref)
  const path = repo.location.commondir.join('config')
  const data = await readOptional(dispatch, path)
  if (data !== null) {
    const text = DEC.decode(data)
    const dropped = withoutSection(text, 'branch', name)
    if (dropped !== text) await writeFile(dispatch, path, ENC.encode(dropped))
  }
  return `Deleted branch ${name} (was ${short(sha, repo.abbrev)}).\n`
}

/**
 * git's `build_format`: the format a branch listing prints with when the line
 * gives none, colors left out as they are off a terminal.
 *
 * A local branch is marked `*` when HEAD is on it and `+` when another worktree
 * is; `-v` pads every name to one column and adds the id, the upstream's
 * distance and the subject, and `-vv` names the upstream (and a worktree the
 * branch is out in) as well.
 *
 * @param verbose how many `-v`
 * @param width the name column, from `listWidth`
 * @param prefix what a remote-tracking branch is labelled with, `remotes/`
 *   unless only those are listed
 */
function buildFormat(verbose: number, width: number, prefix: string): string {
  const label = prefix.replaceAll('%', '%%')
  let local = '%(if)%(HEAD)%(then)* %(else)%(if)%(worktreepath)%(then)+ %(else)  %(end)%(end)'
  let remote = '  '
  if (verbose) {
    const oid = '%(objectname:short)'
    local += `%(align:${String(width)},left)%(refname:lstrip=2)%(end) ${oid} `
    if (verbose > 1) {
      local +=
        '%(if:notequals=*)%(HEAD)%(then)%(if)%(worktreepath)%(then)(%(worktreepath)) %(end)%(end)' +
        '%(if)%(upstream)%(then)[%(upstream:short)%(if)%(upstream:track)%(then): ' +
        '%(upstream:track,nobracket)%(end)] %(end)%(contents:subject)'
    } else {
      local += '%(if)%(upstream:track)%(then)%(upstream:track) %(end)%(contents:subject)'
    }
    remote +=
      `%(align:${String(width)},left)${label}%(refname:lstrip=2)%(end)` +
      `%(if)%(symref)%(then) -> %(symref:short)%(else) ${oid} %(contents:subject)%(end)`
  } else {
    local += '%(refname:lstrip=2)%(if)%(symref)%(then) -> %(symref:short)%(end)'
    remote += `${label}%(refname:lstrip=2)%(if)%(symref)%(then) -> %(symref:short)%(end)`
  }
  return `%(if:notequals=refs/remotes)%(refname:rstrip=-2)%(then)${local}%(else)${remote}%(end)`
}

/**
 * `calc_maxwidth`: the widest name a verbose listing pads to.
 *
 * @param bonus the width of the label a remote-tracking branch carries
 * @param description the detached HEAD row's name
 */
function listWidth(items: readonly RefItem[], bonus: number, description: string): number {
  let widest = 0
  for (const item of items) {
    let width: number
    if (item.kind === RefKind.DETACHED) width = displayWidth(description)
    else {
      let name = item.name
      for (const prefix of [HEADS_PREFIX, REMOTES_PREFIX])
        if (name.startsWith(prefix)) name = name.slice(prefix.length)
      width = displayWidth(name) + (item.kind === RefKind.REMOTE ? bonus : 0)
    }
    widest = Math.max(widest, width)
  }
  return widest
}

/**
 * A branch listing, through git's ref-filter as git prints one: the local
 * branches (`-r` the remote-tracking ones instead, `-a` both) and a detached
 * HEAD, which leads whatever the sort keys say, each printed through `--format`
 * or the format `buildFormat` makes.
 */
async function listBranches(
  inv: CLIInvocation,
  fl: FlagView,
  repo: Repo,
  head: HeadRef,
  patterns: readonly string[],
  filter: RefFilter | null,
  remotesOnly: boolean,
  includeRemotes: boolean,
): Promise<CommandFnResult> {
  const keys = sortKeys(fl, await configuredSort(repo, 'branch'))
  const icase = fl.asBool('ignore_case')
  const verbose = fl.asInt('verbose') ?? 0
  const prefix = remotesOnly ? '' : REMOTE
  const template = fl.asStr('format')
  const detached = head.commit !== null && !remotesOnly
  const wanted = (name: string): boolean =>
    ((name === HEAD && detached) ||
      (!remotesOnly && name.startsWith(HEADS_PREFIX)) ||
      (includeRemotes && name.startsWith(REMOTES_PREFIX))) &&
    matchShort(name, patterns, icase)
  let fmt = listingFormat(template ?? buildFormat(verbose, 0, prefix))
  const [items, found, errors] = await refListing(
    repo,
    usedFields(fmt, keys ?? []),
    wanted,
    filter,
    dateClock(inv.env),
  )
  let ctx = found
  if (items.some((item) => item.kind === RefKind.DETACHED))
    ctx = { ...ctx, headDescription: await headDescription(repo, head) }
  if (template === undefined && verbose)
    fmt = listingFormat(
      buildFormat(verbose, listWidth(items, prefix.length, ctx.headDescription), prefix),
    )
  const [out, stopped] = formatRefs(fmt, items, ctx, keys, {
    omitEmpty: fl.asBool('omit_empty'),
    icase,
    detachedFirst: true,
    stream: false,
  })
  return listingResult(out, errors, stopped)
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
 *
 * `-l` and the ref filters (`--contains`, `--merged`, `--points-at` and their
 * negations) make the line a listing whose operands are name patterns, so
 * `git branch --contains side topic` lists `topic` if it holds `side` rather
 * than creating anything, and a line that also deletes names two modes, which
 * git answers with its usage.
 */
export async function branch(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const words = filterWords(inv)
  const texts = withoutFilterValues(inv.texts, words)
  const fl = new FlagView(inv.flags)
  const remotesOnly = fl.asBool('r')
  const includeRemotes = remotesOnly || fl.asBool('a')
  const listing = words.length > 0 || fl.asBool('list')
  try {
    const dispatch = doors.dispatch
    if (dispatch === undefined) throw new NoWorkspaceError()
    checkSwitches(inv, texts)
    const repo = await opened(fl, doors)
    const mode = await trackMode(repo)
    const filter = await refFilter(repo, words)
    const refs = await loadRefs(dispatch, repo.location.gitdir, repo.location.commondir)
    const head = await readHead(dispatch, repo.location.gitdir)
    if (fl.asBool('show_current'))
      return [ENC.encode(head.branch ? head.branch + '\n' : ''), new IOResult()]
    const force = fl.asBool('D')
    if (fl.asBool('delete') || force) {
      if (listing) throw new UsageError('', verbUsage(inv))
      if (texts.length === 0) throw new BranchNameRequiredError()
      const parts: string[] = []
      for (const name of texts) parts.push(await remove(dispatch, repo, refs, head, name, force))
      if (fl.asBool('quiet')) return [null, new IOResult()]
      return [ENC.encode(parts.join('')), new IOResult()]
    }
    const first = texts[0]
    if (first !== undefined && !listing) {
      const [tracking, warning] = await create(dispatch, repo, refs, first, texts[1], mode, head)
      return [
        tracking && !fl.asBool('quiet') ? ENC.encode(tracking) : null,
        new IOResult({ stderr: ENC.encode(warning) }),
      ]
    }
    return await listBranches(
      inv,
      fl,
      repo,
      head,
      listing ? texts : [],
      filter,
      remotesOnly,
      includeRemotes,
    )
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

/** A branch's upstream from `branch.<name>.remote` and `.merge`. */
export async function upstreamOf(
  repo: Repo,
  branch: string,
  tip: string,
): Promise<Upstream | null> {
  const remote = (await configValues(repo.dispatch, repo.location, `branch.${branch}.remote`)).at(
    -1,
  )
  const merge = (await configValues(repo.dispatch, repo.location, `branch.${branch}.merge`)).at(-1)
  if (remote === undefined || merge === undefined) return null
  const tracked =
    remote === '.' ? merge : `refs/remotes/${remote}/${merge.replace(/^refs\/heads\//, '')}`
  const label = tracked.replace(/^refs\/(heads|remotes)\//, '')
  const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
  if (!refs.has(tracked)) return { label, ahead: 0, behind: 0, gone: true }
  const flags = parseFlags(new FlagView())
  const ours = new Set(
    (await select(repo, [await commitFacts(repo, tip)], flags)).map((c) => c.oid),
  )
  const theirs = new Set(
    (await select(repo, [await commitFacts(repo, await resolveCommit(repo, tracked))], flags)).map(
      (c) => c.oid,
    ),
  )
  return {
    label,
    ahead: [...ours].filter((id) => !theirs.has(id)).length,
    behind: [...theirs].filter((id) => !ours.has(id)).length,
    gone: false,
  }
}

/** The current branch's upstream, null when it has none or no commits. */
export async function branchUpstream(
  repo: Repo,
  head: HeadRef,
  noCommits: boolean,
): Promise<Upstream | null> {
  if (head.branch === null || noCommits) return null
  const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
  if (!refs.has(`${HEADS_PREFIX}${head.branch}`)) return null
  const tip = await resolveCommit(repo, `${HEADS_PREFIX}${head.branch}`)
  return upstreamOf(repo, head.branch, tip)
}

/** branch's refusal by a read-only mount: the lock on the ref it creates or deletes. */
export const branchReadOnly: ReadOnlyRefusal = (inv, location) => {
  const fl = new FlagView(inv.flags)
  const ref = `${HEADS_PREFIX}${inv.texts[0] ?? ''}`
  const path = (location?.commondir ?? PathSpec.fromStrPath('/.git')).join(ref)
  if (fl.asBool('delete') || fl.asBool('D')) return new RefDeleteReadOnlyError(ref, path.virtual)
  return new RefReadOnlyError(ref, path.virtual)
}
