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

import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { PathSpec } from '../../../../types.ts'
import git from 'isomorphic-git'
import { HEAD } from './constants.ts'
import { dateClock } from './dates.ts'
import { configValues } from './fs.ts'

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
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
import { short } from './format.ts'
import { readOptional, writeFile } from './io.ts'

import {
  BRANCH_PREFIX,
  blockingRef,
  deleteRef,
  loadRefs,
  readHead,
  REMOTE_PREFIX,
  validBranchName,
  writeRef,
} from './refs.ts'
import { filterWords, refFilter, withoutFilterValues, type RefFilter } from './ref_filter.ts'
import { parseField } from './ref_fields.ts'
import {
  displayWidth,
  formatRefs,
  listingFormat,
  sortRefs,
  usedFields,
  ValueTable,
} from './ref_format.ts'
import {
  configuredSort,
  headDescription,
  listingResult,
  matchShort,
  reached,
  refListing,
  sortKeys,
} from './ref_list.ts'
import { configBool, repoArgs, type Repo } from './repo.ts'
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
  type GitObject,
  type HeadRef,
  type ReadOnlyRefusal,
  type RefContext,
  type RefField,
  type RefItem,
  type RefSortKey,
  type Upstream,
} from './types.ts'
import type { Files } from '../../../../workspace/files.ts'
import { checkSwitches, configSection, fatal, gitBool, verbUsage, withoutSection } from './util.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const NEWLINE = 0x0a
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
  const table = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
  if (refsNamed(table, name).length <= 1) return
  if (!warned) await noteAmbiguity(repo, name)
  throw new AmbiguousObjectNameError(name)
}

/** Point a new branch at a commit, refusing to move an existing one. */
async function create(
  vfs: Files,
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
  if (!validBranchName(name)) throw new InvalidBranchNameError(name)
  const ref = `${BRANCH_PREFIX}${name}`
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
  await writeRef(vfs, repo.location.commondir, ref, oid)
  const log = repo.location.commondir.join('logs', ref)
  if (await logged(vfs, repo.location, ref, log)) {
    const when = Math.floor(Date.now() / 1000)
    const line = entry(ZERO, oid, IDENTITY, when, `branch: Created from ${from}`)
    await append(vfs, repo.location.commondir, `logs/${ref}`, line)
  }
  return setUpTracking(repo, name, start ?? null, mode, head)
}

/**
 * The one remote-tracking branch a missing branch name guesses at:
 * `checkout <name>` and `switch <name>` with no such branch create it from
 * `<remote>/<name>` when exactly one remote has one.
 */
export async function remoteBranch(repo: Repo, name: string): Promise<string | null> {
  const refs = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
  const depth = 3 + name.split('/').length - 1
  const found = [...refs.keys()].filter(
    (ref) =>
      ref.startsWith(REMOTE_PREFIX) &&
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
  for (const value of await configValues(repo.vfs, repo.location, AUTO_SETUP_MERGE)) {
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
  const values = (path: string): Promise<string[]> => configValues(repo.vfs, repo.location, path)
  if (ref.startsWith(BRANCH_PREFIX)) {
    const source = ref.slice(BRANCH_PREFIX.length)
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
  if (!ref.startsWith(REMOTE_PREFIX)) return [null, [], '', '']
  const rest = ref.slice(REMOTE_PREFIX.length)
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
  return [remote, [`${BRANCH_PREFIX}${name}`], `${remote}/`, '']
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
    const refs = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
    ref = refsNamed(refs, typed)[0]
  }
  if (ref === null || ref === undefined) return ['', '']
  const [remote, merges, prefix, warning] = await tracked(repo, ref, branch, mode)
  if (remote === null) return ['', warning]
  const path = repo.location.commondir.join('config')
  const data = (await readOptional(repo.vfs, path)) ?? new Uint8Array()
  const section = configSection('branch', branch, [
    ['remote', remote],
    ...merges.map((merge): [string, string] => ['merge', merge]),
  ])
  const tail = data.length && data[data.length - 1] !== NEWLINE ? '\n' : ''
  await writeFile(repo.vfs, path, new Uint8Array([...data, ...ENC.encode(tail + section)]))
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
  vfs: Files,
  repo: Repo,
  refs: ReadonlyMap<string, string>,
  head: HeadRef,
  name: string,
  force: boolean,
): Promise<string> {
  const ref = `${BRANCH_PREFIX}${name}`
  const sha = refs.get(ref)
  if (sha === undefined) throw new NoBranchError(name)
  if (name === head.branch) throw new CheckedOutBranchError(name, repo.location.worktree.virtual)
  if (!force && !(await merged(repo, sha, headCommit(refs, head)))) {
    throw new UnmergedBranchError(name)
  }
  await deleteRef(vfs, repo.location.commondir, ref)
  const path = repo.location.commondir.join('config')
  const data = await readOptional(vfs, path)
  if (data !== null) {
    const text = DEC.decode(data)
    const dropped = withoutSection(text, 'branch', name)
    if (dropped !== text) await writeFile(vfs, path, ENC.encode(dropped))
  }
  return `Deleted branch ${name} (was ${short(sha, repo.abbrev)}).\n`
}

// What a listing row reads when the line gives no --format.
const ROW_ID = parseField('objectname:short')
const ROW_SUBJECT = parseField('contents:subject')
const ROW_TRACK = parseField('upstream:track')
const ROW_UPSTREAM = parseField('upstream:short')
const ROW_WORKTREE = parseField('worktreepath')
const ROW_TARGET = parseField('symref:short')

/**
 * The fields `branch` rows read with `verbose` `-v`.
 *
 * @param verbose how many `-v`
 */
export function rowFields(verbose: number): RefField[] {
  if (!verbose) return [ROW_WORKTREE, ROW_TARGET]
  return [
    ROW_WORKTREE,
    ROW_TARGET,
    ROW_ID,
    ROW_SUBJECT,
    ROW_TRACK,
    ...(verbose > 1 ? [ROW_UPSTREAM] : []),
  ]
}

/**
 * A row's name: `main`, `remotes/origin/main` (`origin/main` under `-r`), or
 * the detached HEAD's description.
 *
 * @param item the listed ref
 * @param ctx carries the detached HEAD's description
 * @param prefix what a remote-tracking branch is labelled with
 */
function rowLabel(item: RefItem, ctx: RefContext, prefix: string): string {
  if (item.kind === RefKind.DETACHED) return ctx.headDescription
  if (item.kind === RefKind.REMOTE) return prefix + item.name.slice(REMOTE_PREFIX.length)
  return item.name.startsWith(BRANCH_PREFIX) ? item.name.slice(BRANCH_PREFIX.length) : item.name
}

/**
 * The upstream bracket of a verbose row, with its trailing space.
 *
 * git 2.50.1 prints `[ahead 1, behind 2]` or `[gone]` under `-v` and nothing
 * for a branch level with its upstream; `-vv` names the upstream first,
 * `[origin/main: ahead 1]`, `[origin/main]`.
 *
 * @param item the listed ref
 * @param table the listing's field values
 * @param verbose how many `-v`
 */
function tracking(item: RefItem, table: ValueTable, verbose: number): string {
  const upstream = item.upstream
  if (item.kind !== RefKind.BRANCH || upstream === null) return ''
  const state = upstream.gone
    ? 'gone'
    : (
        [
          ['ahead', upstream.ahead],
          ['behind', upstream.behind],
        ] as const
      )
        .filter(([, count]) => count > 0)
        .map(([word, count]) => `${word} ${String(count)}`)
        .join(', ')
  if (verbose === 1) return state ? `[${state}] ` : ''
  const name = table.value(item, ROW_UPSTREAM).text
  return state ? `[${name}: ${state}] ` : `[${name}] `
}

/**
 * A branch listing as git prints it when the line gives no `--format`.
 *
 * Each row is two columns of marker, `*` for the branch HEAD is on (or a
 * detached HEAD) and `+` for one another worktree has out, then the name; a
 * symbolic ref adds ` -> ` and its target. `-v` pads every name to the widest,
 * by display width, and follows it with the abbreviated id, the upstream
 * bracket and the subject, so an empty subject leaves the id's space behind. A
 * remote-tracking symbolic ref keeps only its ` -> ` target there, while a
 * local one reads as the branch it names. `-vv` also names the upstream, and
 * puts `(<path>)` after the id of a branch another worktree has out.
 *
 * @param items the listed refs, in name order
 * @param ctx the listing's facts
 * @param keys the sort keys, null for `--no-sort`
 * @param verbose how many `-v`
 * @param prefix what a remote-tracking branch is labelled with, `remotes/`
 *   unless only those are listed
 * @param icase `--ignore-case`
 */
export function branchRows(
  items: readonly RefItem[],
  ctx: RefContext,
  keys: readonly RefSortKey[] | null,
  verbose: number,
  prefix: string,
  icase: boolean,
): [string, GitError | null] {
  const table = new ValueTable(
    [...rowFields(verbose), ...(keys ?? []).map((key) => key.field)],
    ctx,
  )
  const rows: string[] = []
  try {
    const ordered = keys ? sortRefs(items, keys, table, ctx, icase, true) : [...items]
    const labels = ordered.map((item) => rowLabel(item, ctx, prefix))
    const width = Math.max(0, ...labels.map(displayWidth))
    ordered.forEach((item, at) => {
      const label = labels[at] ?? ''
      const current = item.kind === RefKind.DETACHED || item.name === ctx.head
      const elsewhere = item.kind === RefKind.BRANCH && item.worktree !== ''
      const marker = current ? '* ' : elsewhere ? '+ ' : '  '
      const target = item.symref !== null ? table.value(item, ROW_TARGET).text : ''
      if (!verbose) {
        rows.push(`${marker}${label}${target ? ` -> ${target}` : ''}\n`)
        return
      }
      const padded = label + ' '.repeat(width - displayWidth(label))
      if (target && item.kind === RefKind.REMOTE) {
        rows.push(`${marker}${padded} -> ${target}\n`)
        return
      }
      const where = verbose > 1 && elsewhere && !current ? `(${item.worktree}) ` : ''
      rows.push(
        `${marker}${padded} ${table.value(item, ROW_ID).text} ${where}` +
          `${tracking(item, table, verbose)}${table.value(item, ROW_SUBJECT).text}\n`,
      )
    })
  } catch (err) {
    if (err instanceof GitError) return [rows.join(''), err]
    throw err
  }
  return [rows.join(''), null]
}

/**
 * A branch listing, through git's ref-filter as git prints one: the local
 * branches (`-r` the remote-tracking ones instead, `-a` both) and a detached
 * HEAD, which leads whatever the sort keys say, each printed through `--format`
 * or as `branchRows` lays rows out.
 */
async function listBranches(
  ctx: Context,
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
      (!remotesOnly && name.startsWith(BRANCH_PREFIX)) ||
      (includeRemotes && name.startsWith(REMOTE_PREFIX))) &&
    matchShort(name, patterns, icase)
  const fmt = template !== undefined ? listingFormat(template) : null
  const [items, found, errors] = await refListing(
    repo,
    fmt !== null
      ? usedFields(fmt, keys ?? [])
      : [...rowFields(verbose), ...(keys ?? []).map((key) => key.field)],
    wanted,
    filter,
    dateClock(ctx.env),
  )
  let refCtx = found
  if (items.some((item) => item.kind === RefKind.DETACHED))
    refCtx = { ...refCtx, headDescription: await headDescription(repo, head) }
  const [out, stopped] =
    fmt === null
      ? branchRows(items, refCtx, keys, verbose, prefix, icase)
      : formatRefs(fmt, items, refCtx, keys, {
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
export async function branch(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const words = filterWords(ctx)
  const operands = withoutFilterValues(texts, words)
  const fl = new FlagView(ctx.flags)
  const remotesOnly = fl.asBool('r')
  const includeRemotes = remotesOnly || fl.asBool('a')
  const listing = words.length > 0 || fl.asBool('list')
  try {
    const vfs = ctx.vfs
    if (vfs === undefined) throw new NoWorkspaceError()
    checkSwitches(ctx, operands)
    const repo = await opened(ctx, fl)
    const mode = await trackMode(repo)
    const filter = await refFilter(repo, words)
    const refs = await loadRefs(vfs, repo.location.gitdir, repo.location.commondir)
    const head = await readHead(vfs, repo.location.gitdir)
    if (fl.asBool('show_current'))
      return [ENC.encode(head.branch ? head.branch + '\n' : ''), new IOResult()]
    const force = fl.asBool('D')
    if (fl.asBool('delete') || force) {
      if (listing) throw new UsageError('', verbUsage(ctx))
      if (operands.length === 0) throw new BranchNameRequiredError()
      const parts: string[] = []
      for (const name of operands) parts.push(await remove(vfs, repo, refs, head, name, force))
      if (fl.asBool('quiet')) return [null, new IOResult()]
      return [ENC.encode(parts.join('')), new IOResult()]
    }
    const first = operands[0]
    if (first !== undefined && !listing) {
      const [tracking, warning] = await create(vfs, repo, refs, first, operands[1], mode, head)
      return [
        tracking && !fl.asBool('quiet') ? ENC.encode(tracking) : null,
        new IOResult({ stderr: ENC.encode(warning) }),
      ]
    }
    return await listBranches(
      ctx,
      fl,
      repo,
      head,
      listing ? operands : [],
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
  const remote = (await configValues(repo.vfs, repo.location, `branch.${branch}.remote`)).at(-1)
  const merge = (await configValues(repo.vfs, repo.location, `branch.${branch}.merge`)).at(-1)
  if (remote === undefined || merge === undefined) return null
  const tracked =
    remote === '.' ? merge : `${REMOTE_PREFIX}${remote}/${merge.replace(/^refs\/heads\//, '')}`
  const label = tracked.replace(/^refs\/(heads|remotes)\//, '')
  const refs = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
  if (!refs.has(tracked)) return { label, ahead: 0, behind: 0, gone: true }
  const ours = await reached(repo, tip)
  const theirs = await reached(repo, await resolveCommit(repo, tracked))
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
  const refs = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
  if (!refs.has(`${BRANCH_PREFIX}${head.branch}`)) return null
  const tip = await resolveCommit(repo, `${BRANCH_PREFIX}${head.branch}`)
  return upstreamOf(repo, head.branch, tip)
}

/** branch's refusal by a read-only mount: the lock on the ref it creates or deletes. */
export const branchReadOnly: ReadOnlyRefusal = (texts, ctx, location) => {
  const fl = new FlagView(ctx.flags)
  const ref = `${BRANCH_PREFIX}${texts[0] ?? ''}`
  const path = (location?.commondir ?? PathSpec.fromStrPath('/.git')).join(ref)
  if (fl.asBool('delete') || fl.asBool('D')) return new RefDeleteReadOnlyError(ref, path.virtual)
  return new RefReadOnlyError(ref, path.virtual)
}
