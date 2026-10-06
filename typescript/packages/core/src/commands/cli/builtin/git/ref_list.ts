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

import type { PathSpec } from '../../../../types.ts'
import git from 'isomorphic-git'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { fnmatch } from '../../../../utils/fnmatch.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { DWIM_RULES } from './constants.ts'
import type { GitError } from './errors.ts'
import { short } from './format.ts'
import { configValues } from './fs.ts'
import { parseFlags, select } from './history.ts'
import { basename, readNames, readOptional } from './io.ts'

import { loadMailmap } from './mailmap.ts'
import { abbreviationRequests, needsObject } from './ref_fields.ts'
import { keptRefs, type RefFilter } from './ref_filter.ts'
import { parseSortKeys } from './ref_format.ts'
import { loadRefs, mapped, parseRefspec } from './refs.ts'
import { DETACHED_AT, DETACHED_FROM, NO_BRANCH } from './render.ts'
import { commitFacts, idsUnder, objectType, repoArgs, type Repo } from './repo.ts'
import {
  RefKind,
  type DateMode,
  type HeadRef,
  type RefContext,
  type RefField,
  type RefItem,
  type RefObject,
  type RefSortKey,
  type RefUpstream,
} from './types.ts'
import { gitBool } from './util.ts'

const SYMREF_PREFIX = 'ref: '
// git follows a chain of symbolic refs this deep before it gives up.
const SYMREF_DEPTH = 5
const ROOT_REF_SYNTAX = /^[A-Z_]+$/
const PSEUDO_REFS = ['FETCH_HEAD', 'MERGE_HEAD']
const IRREGULAR_ROOT_REFS = [
  'HEAD',
  'AUTO_MERGE',
  'BISECT_EXPECTED_REV',
  'NOTES_MERGE_PARTIAL',
  'NOTES_MERGE_REF',
  'MERGE_AUTOSTASH',
]
const KIND_PREFIXES: readonly (readonly [string, RefKind])[] = [
  ['refs/heads/', RefKind.BRANCH],
  ['refs/remotes/', RefKind.REMOTE],
  ['refs/tags/', RefKind.TAG],
]
// match_pattern strips the first of these before a tag or branch pattern is
// matched, so `v1.*` and `origin/*` name refs by their short names.
const SHORT_PREFIXES = ['refs/tags/', 'refs/heads/', 'refs/remotes/', 'refs/']
const WORKTREES = 'worktrees'
const GITDIR_FILE = 'gitdir'
const HEAD_FILE = 'HEAD'
const CHECKOUT_MOVE = 'checkout: moving from '
const DEC = new TextDecoder()

/** `is_root_ref`: a ref beside HEAD rather than under `refs/`, pseudorefs excluded. */
export function isRootRef(name: string): boolean {
  if (!ROOT_REF_SYNTAX.test(name) || PSEUDO_REFS.includes(name)) return false
  return name.endsWith('_HEAD') || IRREGULAR_ROOT_REFS.includes(name)
}

/** `ref_kind_from_refname`: which part of the namespace a ref is in. */
export function refKind(name: string): RefKind {
  for (const [prefix, kind] of KIND_PREFIXES) if (name.startsWith(prefix)) return kind
  if (name === HEAD_FILE) return RefKind.DETACHED
  return isRootRef(name) ? RefKind.ROOT : RefKind.OTHER
}

/**
 * What a ref resolves to, following symbolic refs as git reads them.
 *
 * @param table each ref's raw value, an id or a `ref: <target>` line
 * @returns the object id, null for a ref that does not resolve (a dangling
 *   symref); and the target a symbolic ref names, null for an ordinary ref
 */
export function resolveRef(
  table: ReadonlyMap<string, string>,
  name: string,
): [string | null, string | null] {
  const raw = table.get(name)
  const target = raw?.startsWith(SYMREF_PREFIX) ? raw.slice(SYMREF_PREFIX.length).trim() : null
  let current = name
  for (let i = 0; i <= SYMREF_DEPTH; i++) {
    const value = table.get(current)
    if (value === undefined) return [null, target]
    if (!value.startsWith(SYMREF_PREFIX)) return [value.trim(), target]
    current = value.slice(SYMREF_PREFIX.length).trim()
  }
  return [null, target]
}

/**
 * Every name that resolves, which is what makes a short name ambiguous: each
 * ref, and the root refs the git directory holds.
 */
export function knownNames(
  table: ReadonlyMap<string, string>,
  rootFiles: readonly string[] = [],
): Set<string> {
  const names = new Set([...table.keys()].filter((name) => resolveRef(table, name)[0]))
  for (const name of rootFiles) if (ROOT_REF_SYNTAX.test(name)) names.add(name)
  return names
}

/** Match a pattern against a ref one component at a time. */
function pathMatch(parts: readonly string[], name: readonly string[]): boolean {
  const [head, ...rest] = parts
  if (head === undefined) return name.length === 0
  if (head === '**') {
    for (let i = 0; i <= name.length; i++) if (pathMatch(rest, name.slice(i))) return true
    return false
  }
  const [first] = name
  return first !== undefined && fnmatch(first, head) && pathMatch(rest, name.slice(1))
}

function folded(text: string, icase: boolean): string {
  return icase ? text.replace(/[A-Z]/g, (c) => c.toLowerCase()) : text
}

/**
 * `match_name_as_path`: for-each-ref's pattern rule.
 *
 * A pattern selects a ref it spells in full or up to a `/` (always
 * case-sensitively), or one it matches as a `WM_PATHNAME` glob: `*` stops at a
 * `/`, so `refs/*` selects nothing while `refs/*\/*` and `refs/**` select every
 * branch (git 2.47.3 and 2.50.1). No pattern selects every ref.
 */
export function matchAsPath(name: string, patterns: readonly string[], icase = false): boolean {
  if (!patterns.length) return true
  const components = folded(name, icase).split('/')
  return patterns.some(
    (pattern) =>
      (name.startsWith(pattern) &&
        (name.length === pattern.length ||
          name[pattern.length] === '/' ||
          pattern.endsWith('/'))) ||
      pathMatch(folded(pattern, icase).split('/'), components),
  )
}

/**
 * `match_pattern`: tag's and branch's pattern rule, a glob over the name less
 * its `refs/tags/`, `refs/heads/`, `refs/remotes/` or `refs/`, where `*`
 * crosses a `/`.
 */
export function matchShort(name: string, patterns: readonly string[], icase = false): boolean {
  if (!patterns.length) return true
  const prefix = SHORT_PREFIXES.find((p) => name.startsWith(p))
  const rest = prefix === undefined ? name : name.slice(prefix.length)
  return patterns.some((pattern) => fnmatch(folded(rest, icase), folded(pattern, icase)))
}

/** An object's type and content, as ref fields read it. */
async function rawObject(repo: Repo, oid: string): Promise<RefObject> {
  // Deprecated upstream for being general, but the raw content is what the
  // fields parse, whichever kind of object it is.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const read = await git.readObject({ ...repoArgs(repo), oid, format: 'content' })
  return { oid, type: read.type, raw: read.object as Uint8Array }
}

/** What a tag object peels to, through any tags it names in turn. */
async function peeledObject(repo: Repo, obj: RefObject): Promise<RefObject> {
  let shown = obj
  while (shown.type === 'tag') {
    const { tag } = await git.readTag({ ...repoArgs(repo), oid: shown.oid })
    shown = await rawObject(repo, tag.object)
  }
  return shown
}

/**
 * The refs a listing holds, in name order, each loaded as far as its fields
 * read it. As git's ref iteration does, a ref that does not resolve (a
 * dangling symbolic ref) is skipped silently, and one naming an object the
 * repository lacks is skipped with git's error.
 *
 * @returns the refs, and what git would write to stderr about the ones it
 *   skipped
 */
export async function listedRefs(
  repo: Repo,
  table: ReadonlyMap<string, string>,
  wanted: (name: string) => boolean,
  fields: readonly RefField[],
): Promise<[RefItem[], string]> {
  const objects = fields.some(needsObject)
  const deref = fields.some((field) => field.deref)
  const items: RefItem[] = []
  const errors: string[] = []
  for (const name of [...table.keys()].sort(compareCodePoints)) {
    if (!wanted(name)) continue
    const [oid, symref] = resolveRef(table, name)
    if (oid === null) continue
    if ((await objectType(repo, oid)) === null) {
      errors.push(`error: ${name} does not point to a valid object!\n`)
      continue
    }
    let item: RefItem = {
      name,
      oid,
      kind: refKind(name),
      symref,
      obj: null,
      peeled: null,
      upstream: null,
      worktree: '',
    }
    if (objects) {
      const obj = await rawObject(repo, oid)
      item = {
        ...item,
        obj,
        peeled: deref && obj.type === 'tag' ? await peeledObject(repo, obj) : null,
      }
    }
    items.push(item)
  }
  return [items, errors.join('')]
}

/**
 * `branch_get_upstream`: the ref a branch's upstream lands in.
 * `branch.<name>.merge` is mapped through the remote's fetch refspecs; a branch
 * following a remote with none that map it has no upstream at all, and one
 * following `.` follows a local ref.
 */
export async function trackingRef(
  repo: Repo,
  branch: string,
  known: ReadonlySet<string>,
): Promise<RefUpstream | null> {
  const values = (path: string): Promise<string[]> =>
    configValues(repo.dispatch, repo.location, path)
  const remote = (await values(`branch.${branch}.remote`)).at(-1)
  const merge = (await values(`branch.${branch}.merge`))[0]
  if (remote === undefined || merge === undefined) return null
  const up = { remote, merge, ahead: 0, behind: 0, gone: false }
  for (const text of await values(`remote.${remote}.fetch`)) {
    const spec = parseRefspec(text)
    if (spec.src.startsWith('^')) continue
    const dst = mapped(spec, merge)
    if (dst) return { ...up, ref: dst }
  }
  if (remote !== '.') return null
  const found = DWIM_RULES.map((rule) => rule.replace('{}', merge)).find((name) => known.has(name))
  return { ...up, ref: found ?? merge }
}

/** The commits a walk from one tip reaches. */
async function reached(repo: Repo, oid: string): Promise<Set<string>> {
  const walked = await select(repo, [await commitFacts(repo, oid)], parseFlags(new FlagView()))
  return new Set(walked.map((commit) => commit.oid))
}

/**
 * Each local branch with its upstream and, when a field reads them, how far
 * the two have moved apart.
 */
async function withUpstreams(
  repo: Repo,
  items: RefItem[],
  table: ReadonlyMap<string, string>,
  known: ReadonlySet<string>,
  counted: boolean,
): Promise<RefItem[]> {
  const out: RefItem[] = []
  for (const item of items) {
    if (!item.name.startsWith('refs/heads/')) {
      out.push(item)
      continue
    }
    let up = await trackingRef(repo, item.name.slice('refs/heads/'.length), known)
    if (up !== null) {
      const [theirs] = resolveRef(table, up.ref)
      if (theirs === null) up = { ...up, gone: true }
      else if (counted) {
        const ours = await reached(repo, item.oid)
        const there = await reached(repo, theirs)
        up = {
          ...up,
          ahead: [...ours].filter((oid) => !there.has(oid)).length,
          behind: [...there].filter((oid) => !ours.has(oid)).length,
        }
      }
    }
    out.push({ ...item, upstream: up })
  }
  return out
}

/** The names at the top of this checkout's git directory. */
async function rootNames(repo: Repo): Promise<string[]> {
  return (await readNames(repo.dispatch, repo.location.gitdir)).map((entry) => basename(entry))
}

/**
 * `get_worktrees`: the branch each worktree has checked out, and where that
 * worktree is. The main worktree is the one this repository was found in or
 * the one around its common directory; a linked one is named by the `gitdir`
 * file git keeps for it, less its `/.git`.
 */
async function worktreeHeads(repo: Repo): Promise<Map<string, string>> {
  const heads = new Map<string, string>()
  const { gitdir, commondir, worktree } = repo.location
  const note = async (dir: PathSpec, path: string): Promise<void> => {
    const data = await readOptional(repo.dispatch, dir.join(HEAD_FILE))
    const text = DEC.decode(data ?? new Uint8Array()).trim()
    if (text.startsWith(SYMREF_PREFIX) && path) {
      const ref = text.slice(SYMREF_PREFIX.length).trim()
      if (!heads.has(ref)) heads.set(ref, path)
    }
  }
  let main = worktree.virtual
  if (gitdir.virtual !== commondir.virtual)
    main = basename(commondir.virtual) === '.git' ? commondir.virtual.slice(0, -'/.git'.length) : ''
  await note(commondir, main)
  const root = commondir.join(WORKTREES)
  for (const entry of await readNames(repo.dispatch, root)) {
    const linked = root.join(basename(entry))
    const data = await readOptional(repo.dispatch, linked.join(GITDIR_FILE))
    if (data === null) continue
    const path = DEC.decode(data).trim()
    await note(linked, path.endsWith('/.git') ? path.slice(0, -'/.git'.length) : path)
  }
  return heads
}

/**
 * How the status names where a detached HEAD came from: the checkout's target
 * when it still names exactly one ref holding that commit (a tag or
 * remote-tracking branch by its short name), the abbreviated id otherwise.
 */
async function detachedLabel(repo: Repo, target: string, moved: string): Promise<string> {
  const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
  const found = [...new Set(DWIM_RULES.map((rule) => rule.replace('{}', target)))].filter((name) =>
    refs.has(name),
  )
  const [only] = found
  if (target !== 'HEAD' && found.length === 1 && only !== undefined) {
    let oid = await git.resolveRef({ ...repoArgs(repo), ref: only })
    while ((await objectType(repo, oid)) === 'tag')
      oid = (await git.readTag({ ...repoArgs(repo), oid })).tag.object
    if (oid === moved) return only.replace(/^refs\/tags\//, '').replace(/^refs\/remotes\//, '')
  }
  return short(moved, repo.abbrev)
}

/**
 * The first line of a status on a detached HEAD, read off the reflog.
 *
 * git names the target of the newest `checkout: moving from` entry, `at` while
 * HEAD is still there and `from` once it has moved on, and says it is on no
 * branch when no checkout put it there, which is what a clone of a tag or of a
 * detached HEAD reads (pinned against git 2.47.3 and 2.50.1).
 */
export async function detachedLine(repo: Repo, head: HeadRef): Promise<string> {
  const log = await readOptional(repo.dispatch, repo.location.gitdir.join('logs/HEAD'))
  const rows = DEC.decode(log ?? new Uint8Array())
    .split('\n')
    .filter(Boolean)
  for (const row of rows.reverse()) {
    const tab = row.indexOf('\t')
    const message = row.slice(tab + 1)
    if (!message.startsWith(CHECKOUT_MOVE)) continue
    const to = message.indexOf(' to ', CHECKOUT_MOVE.length)
    if (to < 0) continue
    const target = message.slice(to + 4)
    const moved = row.slice(0, tab).split(' ')[1] ?? ''
    const label = await detachedLabel(repo, target, moved)
    return `${head.commit === moved ? DETACHED_AT : DETACHED_FROM}${label}`
  }
  return NO_BRANCH
}

/**
 * `get_head_description`: how a detached HEAD row names itself in a branch
 * listing, the status line in parentheses.
 */
export async function headDescription(repo: Repo, head: HeadRef): Promise<string> {
  const line = await detachedLine(repo, head)
  return line === NO_BRANCH ? '(no branch)' : `(${line})`
}

/**
 * The ref HEAD resolves to, `HEAD` itself when it is detached, null when it
 * names a branch with no commit yet.
 */
export function headRef(table: ReadonlyMap<string, string>): string | null {
  let current = HEAD_FILE
  for (let i = 0; i <= SYMREF_DEPTH; i++) {
    const value = table.get(current)
    if (value === undefined) return null
    if (!value.startsWith(SYMREF_PREFIX)) return current
    current = value.slice(SYMREF_PREFIX.length).trim()
  }
  return null
}

const FANOUT_LEN = 2

/** Where `oid` sorts among sorted ids: the first index not below it. */
function bisectLeft(ids: readonly string[], oid: string): number {
  let low = 0
  let high = ids.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (compareCodePoints(ids[mid] ?? '', oid) < 0) low = mid + 1
    else high = mid
  }
  return low
}

function sharedLength(a: string, b: string): number {
  let shared = 0
  while (shared < a.length && a[shared] === b[shared]) shared += 1
  return shared
}

/**
 * The shortest prefix of `oid` no other id shares, no shorter than `width`, as
 * git's `find_abbrev_len_for_pack` finds it. In sorted ids the longest prefix
 * any other id shares with `oid` is shared by a neighbour of the place it sorts
 * to, so only those two are compared. An id the repository lacks (a missing
 * parent) sorts between its neighbours all the same.
 *
 * @param ids every id sharing its fanout byte, sorted
 */
export function uniqueWidth(oid: string, width: number, ids: readonly string[]): number {
  const at = bisectLeft(ids, oid)
  const after = ids[at] === oid ? at + 1 : at
  let widest = width
  for (const other of [...ids.slice(Math.max(at - 1, 0), at), ...ids.slice(after, after + 1)])
    widest = Math.max(widest, sharedLength(oid, other) + 1)
  return Math.min(widest, oid.length)
}

/**
 * Widen requested prefixes against loose and packed objects, including objects
 * no selected ref reaches, without reading object contents. Each fanout bucket
 * the ids fall in is read once, so a listing of many branches costs one pass
 * over the ids those buckets hold rather than one per branch.
 */
export async function uniqueAbbreviations(
  repo: Repo,
  widths: ReadonlyMap<string, number>,
): Promise<Map<string, number>> {
  const buckets = new Map<string, string[]>()
  for (const oid of widths.keys()) {
    const fanout = oid.slice(0, FANOUT_LEN)
    if (!buckets.has(fanout)) buckets.set(fanout, await idsUnder(repo, fanout))
  }
  const unique = new Map<string, number>()
  for (const [oid, width] of widths)
    unique.set(oid, uniqueWidth(oid, width, buckets.get(oid.slice(0, FANOUT_LEN)) ?? []))
  return unique
}

/**
 * The refs one listing prints and the facts their fields read. Everything a
 * field could want is loaded only when some field wants it: the objects, what
 * tags peel to, upstreams and their counts, worktrees and the mailmap.
 *
 * @param roots `--include-root-refs`: list the root refs the git directory
 *   holds as well
 * @returns the refs in name order, the listing's facts, and git's errors about
 *   skipped refs
 */
export async function refListing(
  repo: Repo,
  fields: readonly RefField[],
  wanted: (name: string) => boolean,
  filter: RefFilter | null,
  date: DateMode,
  roots = false,
): Promise<[RefItem[], RefContext, string]> {
  const table = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
  const names = await rootNames(repo)
  if (roots) {
    for (const name of names) {
      if (name === HEAD_FILE || !isRootRef(name)) continue
      const data = await readOptional(repo.dispatch, repo.location.gitdir.join(name))
      if (data?.length) table.set(name, DEC.decode(data).split('\n', 1)[0] ?? '')
    }
  }
  const known = knownNames(table, names)
  const [listed, errors] = await listedRefs(repo, table, wanted, fields)
  let items = listed
  if (filter !== null) {
    const kept = await keptRefs(
      repo,
      filter,
      items.map((item) => [item.name, item.oid] as const),
    )
    items = items.filter((item) => kept.has(item.name))
  }
  const upstreams = fields.filter((field) => field.field === 'upstream')
  if (upstreams.length) {
    const counted = upstreams.some((field) => ['track', 'trackshort'].includes(field.option))
    items = await withUpstreams(repo, items, table, known, counted)
  }
  if (fields.some((field) => field.field === 'worktreepath')) {
    const heads = await worktreeHeads(repo)
    items = items.map((item) => ({ ...item, worktree: heads.get(item.name) ?? '' }))
  }
  const values = (path: string): Promise<string[]> =>
    configValues(repo.dispatch, repo.location, path)
  const suffixes = await values('versionsort.suffix')
  const mailmapped = fields.some(
    (field) => field.option === 'mailmap' || field.words.has('mailmap'),
  )
  const ctx: RefContext = {
    known,
    strict: gitBool(await values('core.warnambiguousrefs'), 'core.warnambiguousrefs', true),
    head: headRef(table),
    headDescription: '',
    abbrev: repo.abbrev,
    abbreviations: new Map(),
    mailmap: mailmapped ? await loadMailmap(repo.dispatch, repo.location) : [],
    date,
    suffixes: suffixes.length ? suffixes : await values('versionsort.prereleasesuffix'),
  }
  const widths = abbreviationRequests(fields, items, ctx)
  const abbreviations = await uniqueAbbreviations(repo, widths)
  return [items, { ...ctx, abbreviations }, errors]
}

/**
 * The line's sort keys, primary first; null when there are none.
 *
 * Each `--sort` adds a key after the defaults (the config's `<verb>.sort`
 * values, or `refname`) and `--no-sort` drops every key before it, the
 * defaults included, as git's string list does.
 */
export function sortKeys(fl: FlagView, defaults: readonly string[]): RefSortKey[] | null {
  let spellings = [...defaults]
  for (const [name, value] of fl.occurrences('sort', 'no_sort')) {
    if (name === 'no_sort') spellings = []
    else if (Array.isArray(value)) spellings.push(...value.filter((v) => typeof v === 'string'))
    else if (typeof value === 'string') spellings.push(value)
  }
  return spellings.length ? parseSortKeys(spellings) : null
}

/**
 * `tag.sort` or `branch.sort`: the keys a listing sorts by unless the line
 * says otherwise, `refname` when unset.
 */
export async function configuredSort(repo: Repo, verb: string): Promise<string[]> {
  const values = await configValues(repo.dispatch, repo.location, `${verb}.sort`)
  return values.length ? values : ['refname']
}

/** A listing's output: what printed, then the refusal it stopped at. */
export function listingResult(
  out: string,
  errors: string,
  stopped: GitError | null,
): CommandFnResult {
  let stderr = errors
  if (stopped !== null)
    stderr +=
      stopped.prefix === null ? `${stopped.message}\n` : `${stopped.prefix}: ${stopped.message}\n`
  return [
    encodeText(out),
    new IOResult({ exitCode: stopped?.code ?? 0, stderr: new TextEncoder().encode(stderr) }),
  ]
}
