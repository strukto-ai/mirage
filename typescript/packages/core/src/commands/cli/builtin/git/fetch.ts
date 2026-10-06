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
import type { CLIInvocation } from '../../types.ts'
import { DWIM_RULES } from './constants.ts'
import { isBare } from './discover.ts'
import {
  FetchHeadReadOnlyError,
  GitError,
  MissingRepositoryError,
  NoWorkspaceError,
} from './errors.ts'
import { configLines, configValues } from './fs.ts'
import { resolvedRefs } from './history.ts'
import { globalSources } from './inspect.ts'
import { under, writeFile } from './io.ts'
import { append, entry, IDENTITY, ZERO } from './reflog.ts'
import {
  deleteRef,
  loadRefs,
  mapped,
  parseRefspec,
  readHead,
  SYMREF_PREFIX,
  validRefName,
  writeRef,
} from './refs.ts'
import { objectType, openRepo, repoArgs, storePack, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import {
  displayUrl,
  extraHeaders,
  openTransport,
  type Advertisement,
  type Transport,
} from './transport.ts'
import type { ReadOnlyRefusal, Refspec } from './types.ts'
import { checkSwitches, fatal } from './util.ts'

const ENC = new TextEncoder()
export const HEADS = 'refs/heads/'
export const TAGS = 'refs/tags/'
const REMOTES = 'refs/remotes/'
const FETCH_HEAD = 'FETCH_HEAD'
const ALL_TAGS = 'refs/tags/*:refs/tags/*'
const TERM_COLUMNS = 80
const REFCOL_MIN = 10
const UNREACHABLE =
  'fatal: Could not read from remote repository.\n\n' +
  'Please make sure you have the correct access rights\n' +
  'and the repository exists.'
const NO_REMOTE =
  'No remote repository specified.  Please, specify either a URL or a\n' +
  'remote name from which new revisions should be fetched.'

/** One remote ref a fetch takes, and where it lands. */
export interface Wanted {
  /** The remote ref name, `HEAD` for a bare URL. */
  readonly remote: string
  /** The object id the remote holds there. */
  readonly oid: string
  /** The local ref to update, null when it only goes to FETCH_HEAD. */
  readonly local: string | null
  /** Whether a non-fast-forward is allowed. */
  readonly force: boolean
  /** Whether FETCH_HEAD marks it for merging. */
  readonly merge: boolean
  /** Whether it is written to FETCH_HEAD at all. */
  readonly listed: boolean
}

/** One line of git's fetch summary. */
export interface Row {
  /** `*` new, ` ` fast-forward, `+` forced, `-` pruned, `!` rejected, `=` unchanged. */
  readonly code: string
  readonly summary: string
  readonly remote: string
  readonly local: string
  readonly error: string
  /** Whether the row widens the ref column, as git's refcol_width counts it. */
  readonly counted: boolean
}

function wanted(
  remote: string,
  oid: string,
  local: string | null,
  force = false,
  merge = false,
  listed = true,
): Wanted {
  return { remote, oid, local, force, merge, listed }
}

function row(
  code: string,
  summary: string,
  remote: string,
  local: string,
  error = '',
  counted = false,
): Row {
  return { code, summary, remote, local, error, counted }
}

/** A ref name the way git's fetch summary shortens it. */
export function prettify(ref: string): string {
  for (const prefix of [HEADS, TAGS, REMOTES])
    if (ref.startsWith(prefix)) return ref.slice(prefix.length)
  return ref
}

/**
 * The `From <url>` block git prints to stderr after a fetch.
 *
 * Pinned against git 2.47.3 and 2.50.1: the summary column is `2 * abbrev + 3`
 * wide and the ref column at least ten, widened by each changed ref whose line
 * still fits 80 columns.
 */
export function summaryLines(url: string, rows: readonly Row[], abbrev: number): string {
  if (!rows.length) return ''
  const width = 2 * abbrev + 3
  let refcol = REFCOL_MIN
  for (const line of rows)
    if (line.counted && 21 + line.remote.length + 4 + line.local.length < TERM_COLUMNS)
      refcol = Math.max(refcol, line.remote.length)
  const lines = [`From ${displayUrl(url)}\n`]
  for (const line of rows) {
    const note = line.error ? `  (${line.error})` : ''
    lines.push(
      ` ${line.code} ${line.summary.padEnd(width)} ${line.remote.padEnd(refcol)} -> ${line.local}${note}\n`,
    )
  }
  return lines.join('')
}

/** Whether `old` is reachable from `fresh`, a fast-forward. */
async function isAncestor(repo: Repo, old: string, fresh: string): Promise<boolean> {
  const seen = new Set<string>()
  const stack = [fresh]
  for (let oid = stack.pop(); oid !== undefined; oid = stack.pop()) {
    if (oid === old) return true
    if (seen.has(oid)) continue
    seen.add(oid)
    if ((await objectType(repo, oid)) === 'commit')
      stack.push(...(await git.readCommit({ ...repoArgs(repo), oid })).commit.parent)
  }
  return false
}

/** Whether a repository holds an object. */
async function holds(repo: Repo, oid: string): Promise<boolean> {
  return (await objectType(repo, oid)) !== null
}

/** Fetch what `wants` reaches that is missing, then reopen. */
async function receive(repo: Repo, transport: Transport, wants: readonly string[]): Promise<Repo> {
  const refs = await resolvedRefs(repo)
  const tips = new Set(refs.values())
  const missing: string[] = []
  for (const want of new Set(wants)) if (!(await holds(repo, want))) missing.push(want)
  if (!missing.length) return repo
  const pack = await transport.fetchPack(
    missing,
    [...tips].sort(compareCodePoints),
    tips.size ? (oid) => holds(repo, oid) : () => Promise.resolve(false),
  )
  await storePack(repo, pack)
  return openRepo(repo.dispatch, repo.location, repo.ambiguous)
}

/**
 * Drop the refs whose local name git refuses, as get_fetch_map does.
 *
 * The remote names its refs, so one it advertises as `refs/tags/../../x` would
 * land outside `.git`. git skips such a ref with an error and takes the rest
 * (pinned against git 2.50.1). Returns the refs kept and the errors git prints
 * for the others.
 */
export function ignoreFunny(wants: readonly Wanted[]): [Wanted[], string] {
  const kept: Wanted[] = []
  let notes = ''
  for (const want of wants) {
    if (want.local === null || (want.local.startsWith('refs/') && validRefName(want.local)))
      kept.push(want)
    else notes += `error: * Ignoring funny ref '${want.local}' locally\n`
  }
  return [kept, notes]
}

/**
 * The remote tags git follows: new here, pointing at what is here.
 *
 * A tag whose name git refuses is left out. git asks for it by name and dies
 * on the answer; mirage takes the rest instead.
 */
async function followedTags(
  repo: Repo,
  adv: Advertisement,
  taken: ReadonlySet<string>,
): Promise<Wanted[]> {
  const local = await resolvedRefs(repo)
  const follow: Wanted[] = []
  for (const [name, oid] of adv.refs) {
    if (!name.startsWith(TAGS) || taken.has(name) || local.has(name) || !validRefName(name))
      continue
    if (await holds(repo, adv.peeled.get(name) ?? oid)) follow.push(wanted(name, oid, name))
  }
  return follow
}

/**
 * Bring in every wanted object, then the tags that follow them. Two rounds, as
 * git does: the refs first, then any annotated tag whose target is now here but
 * whose tag object is not.
 */
export async function fetchObjects(
  repo: Repo,
  transport: Transport,
  adv: Advertisement,
  wants: readonly Wanted[],
  follow: boolean,
): Promise<[Repo, Wanted[]]> {
  let current = await receive(
    repo,
    transport,
    wants.map((want) => want.oid),
  )
  if (!follow) return [current, [...wants]]
  const tags = await followedTags(current, adv, new Set(wants.map((want) => want.remote)))
  if (tags.length)
    current = await receive(
      current,
      transport,
      tags.map((tag) => tag.oid),
    )
  return [current, [...wants, ...tags]]
}

/** The summary row for one ref update, and its reflog reason (null: not written). */
async function classify(
  repo: Repo,
  want: Wanted,
  old: string | undefined,
): Promise<[Row, string | null]> {
  const local = want.local ?? ''
  const remote = prettify(want.remote)
  const shown = prettify(local)
  if (old === want.oid) return [row('=', '[up to date]', remote, shown), null]
  if (old === undefined) {
    if (local.startsWith(TAGS))
      return [row('*', '[new tag]', remote, shown, '', true), 'storing tag']
    const kind = want.remote.startsWith(HEADS) ? '[new branch]' : '[new ref]'
    return [row('*', kind, remote, shown, '', true), 'storing head']
  }
  if (local.startsWith(TAGS) && !want.force)
    return [row('!', '[rejected]', remote, shown, 'would clobber existing tag', true), null]
  const ends = [old.slice(0, repo.abbrev), want.oid.slice(0, repo.abbrev)]
  if (await isAncestor(repo, old, want.oid))
    return [row(' ', ends.join('..'), remote, shown, '', true), 'fast-forward']
  if (want.force)
    return [row('+', ends.join('...'), remote, shown, 'forced update', true), 'forced-update']
  return [row('!', '[rejected]', remote, shown, 'non-fast-forward', true), null]
}

/** Move each local ref, returning the summary rows and any rejection. */
export async function updateRefs(
  repo: Repo,
  wants: readonly Wanted[],
  reason: string,
  logged: boolean,
): Promise<[Row[], boolean]> {
  const local = await resolvedRefs(repo)
  const rows: Row[] = []
  let rejected = false
  const now = Math.floor(Date.now() / 1000)
  for (const want of wants) {
    if (want.local === null) {
      const kind = want.remote.startsWith(TAGS)
        ? 'tag'
        : want.remote.startsWith(REMOTES)
          ? 'remote-tracking branch'
          : 'branch'
      rows.push(row('*', kind, prettify(want.remote), FETCH_HEAD))
      continue
    }
    const old = local.get(want.local)
    const [line, why] = await classify(repo, want, old)
    rows.push(line)
    rejected ||= line.code === '!'
    if (why === null) continue
    await writeRef(repo.dispatch, repo.location.commondir, want.local, want.oid)
    if (logged && !want.local.startsWith(TAGS))
      await append(
        repo.dispatch,
        repo.location.commondir,
        `logs/${want.local}`,
        entry(old ?? ZERO, want.oid, IDENTITY, now, `${reason}: ${why}`),
      )
  }
  return [rows, rejected]
}

/** FETCH_HEAD: every listed ref, the ones marked for merge first. */
export function fetchHead(url: string, wants: readonly Wanted[]): string {
  const lines: string[] = []
  for (const merge of [true, false]) {
    for (const want of wants) {
      if (!want.listed || want.merge !== merge) continue
      const short = prettify(want.remote)
      const what = want.remote.startsWith(HEADS)
        ? `branch '${short}' of `
        : want.remote.startsWith(TAGS)
          ? `tag '${short}' of `
          : want.remote.startsWith(REMOTES)
            ? `remote-tracking branch '${short}' of `
            : want.remote === 'HEAD'
              ? ''
              : `'${want.remote}' of `
      lines.push(`${want.oid}\t${merge ? '' : 'not-for-merge'}\t${what}${displayUrl(url)}\n`)
    }
  }
  return lines.join('')
}

/**
 * A short refspec destination, spelled out as git does: `main:copy` lands in
 * `refs/heads/copy` because `main` is a branch; a tag's lands under `refs/tags/`.
 */
function localName(dst: string | null, remote: string): string | null {
  if (dst === null || dst.startsWith('refs/') || dst === 'HEAD') return dst
  return `${remote.startsWith(TAGS) ? TAGS : HEADS}${dst}`
}

/**
 * The refs a fetch takes, in the order git lists them.
 *
 * Refspecs on the line are taken for FETCH_HEAD and marked for merge, and the
 * configured ones then update their remote-tracking refs opportunistically;
 * without any on the line the configured ones are the whole fetch, and without
 * those it is the remote's HEAD.
 */
function plan(
  adv: Advertisement,
  typed: readonly Refspec[],
  configured: readonly Refspec[],
  merge: string | null,
  allTags: boolean,
): Wanted[] {
  const names = [...adv.refs.keys()].filter((name) => name !== 'HEAD')
  const out: Wanted[] = []
  const specs = typed.length ? typed : configured
  for (const spec of specs) {
    if (spec.src.includes('*')) {
      for (const name of names) {
        const dst = mapped(spec, name)
        if (dst !== null)
          out.push(
            wanted(
              name,
              adv.refs.get(name) ?? '',
              dst || null,
              spec.force,
              (!typed.length && name === merge) || typed.length > 0,
            ),
          )
      }
      continue
    }
    const name = DWIM_RULES.map((rule) => rule.replace('{}', spec.src)).find((candidate) =>
      adv.refs.has(candidate),
    )
    if (name === undefined) throw new GitError(`couldn't find remote ref ${spec.src}`)
    out.push(
      wanted(
        name,
        adv.refs.get(name) ?? '',
        localName(spec.dst, name),
        spec.force,
        typed.length > 0 || name === merge,
      ),
    )
  }
  const head = adv.refs.get('HEAD')
  if (!specs.length && head !== undefined) out.push(wanted('HEAD', head, null, false, true))
  if (typed.length) {
    const taken = new Set(out.map((want) => want.local))
    for (const spec of configured) {
      for (const want of [...out]) {
        const dst = mapped(spec, want.remote)
        if (dst && !taken.has(dst)) {
          taken.add(dst)
          out.push({ ...want, local: dst, force: spec.force, merge: false, listed: false })
        }
      }
    }
  }
  if (allTags) {
    const spec = parseRefspec(ALL_TAGS)
    const taken = new Set(out.map((want) => want.remote))
    for (const name of names)
      if (mapped(spec, name) && !taken.has(name))
        out.push(wanted(name, adv.refs.get(name) ?? '', name))
  }
  return out
}

/** `http.extraHeader` from the user's config, then the repository's. */
export async function configuredHeaders(
  inv: CLIInvocation,
  repo: Repo | null,
): Promise<Record<string, string>> {
  const values: string[] = []
  if (inv.env.HOME || inv.env.GIT_CONFIG_GLOBAL !== undefined) {
    for (const { data } of await globalSources(inv, false))
      for (const line of await configLines(new TextDecoder().decode(data)))
        if (line.path === 'http.extraheader') values.push(line.value ?? '')
  }
  if (repo !== null)
    values.push(...(await configValues(repo.dispatch, repo.location, 'http.extraheader')))
  return extraHeaders(values)
}

/** The words after the verb, which git's reflog reason repeats. */
export function leafArgs(argv: readonly string[], verb: string): readonly string[] {
  const at = argv.indexOf(verb)
  return at < 0 ? [] : argv.slice(at + 1)
}

/** Delete the remote-tracking refs whose remote ref is gone. */
async function prune(repo: Repo, adv: Advertisement, specs: readonly Refspec[]): Promise<Row[]> {
  const rows: Row[] = []
  const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
  const names = [...refs.entries()]
    .filter(([, value]) => !value.startsWith(SYMREF_PREFIX))
    .map(([name]) => name)
    .sort(compareCodePoints)
  for (const name of names) {
    for (const spec of specs) {
      if (!spec.dst?.includes('*')) continue
      const source = mapped({ src: spec.dst, dst: spec.src, force: false }, name)
      if (source && !adv.refs.has(source)) {
        await deleteRef(repo.dispatch, repo.location.commondir, name)
        rows.push(row('-', '[deleted]', '(none)', prettify(name)))
        break
      }
    }
  }
  return rows
}

/**
 * Download objects and refs from another repository.
 *
 * Reaches a repository in the workspace through the dispatcher and an
 * `https://` remote over smart HTTP. Updates the remote-tracking refs a
 * remote's refspecs name, follows the tags that point into what arrived, writes
 * FETCH_HEAD, and prints git's summary to stderr.
 */
export async function fetch(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    checkSwitches(inv, inv.texts)
    const doors = inv.doors ?? {}
    if (doors.dispatch === undefined) throw new NoWorkspaceError()
    const repo = await opened(fl, doors)
    const { location } = repo
    const values = (path: string): Promise<string[]> => configValues(repo.dispatch, location, path)
    const head = await readHead(repo.dispatch, location.gitdir)
    const texts = [...inv.texts]
    let name = texts[0] ?? null
    if (name === null) {
      name =
        head.branch === null
          ? 'origin'
          : ((await values(`branch.${head.branch}.remote`))[0] ?? 'origin')
      if (!(await values(`remote.${name}.url`)).length && name === 'origin')
        throw new GitError(NO_REMOTE)
    }
    const urls = await values(`remote.${name}.url`)
    const url = urls.at(-1) ?? name
    const configured = urls.length ? (await values(`remote.${name}.fetch`)).map(parseRefspec) : []
    let merge: string | null = null
    if (head.branch !== null && urls.length) {
      const remotes = await values(`branch.${head.branch}.remote`)
      if (remotes.at(-1) === name)
        merge = (await values(`branch.${head.branch}.merge`)).at(-1) ?? null
    }
    const bare = await isBare(repo.dispatch, location)
    const start = bare ? location.gitdir : location.worktree
    let transport: Transport
    try {
      transport = await openTransport(url, start, doors, await configuredHeaders(inv, repo))
    } catch (err) {
      if (err instanceof MissingRepositoryError)
        throw new GitError(`'${url}' does not appear to be a git repository\n${UNREACHABLE}`)
      throw err
    }
    const adv = await transport.advertise()
    const typed = texts.slice(1).map(parseRefspec)
    const [wants, notes] = ignoreFunny(plan(adv, typed, configured, merge, fl.asBool('tags')))
    const checked = bare ? null : head.ref
    for (const want of wants)
      if (want.local !== null && want.local === checked)
        throw new GitError(
          `refusing to fetch into branch '${checked}' checked out at '${location.worktree}'`,
        )
    const tagOpt = await values(`remote.${name}.tagopt`)
    const follow = !fl.asBool('no_tags') && tagOpt.at(-1) !== '--no-tags'
    const [fetched, taken] = await fetchObjects(repo, transport, adv, wants, follow)
    const pruned = fl.asBool('prune') && !typed.length ? await prune(fetched, adv, configured) : []
    const reason = ['fetch', ...leafArgs(inv.argv, 'fetch')].join(' ')
    const [rows, rejected] = await updateRefs(fetched, taken, reason, !bare)
    await writeFile(
      repo.dispatch,
      under(location.gitdir, FETCH_HEAD),
      ENC.encode(fetchHead(url, taken)),
    )
    const shown = [...pruned, ...rows.filter((line) => line.code !== '=' || fl.asBool('verbose'))]
    const err = notes + (fl.asBool('quiet') ? '' : summaryLines(url, shown, fetched.abbrev))
    return [null, new IOResult({ exitCode: rejected ? 1 : 0, stderr: ENC.encode(err) })]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

/**
 * fetch's refusal by a read-only mount, at FETCH_HEAD, named the way git names
 * it from the top of the work tree.
 */
export const fetchReadOnly: ReadOnlyRefusal = (_inv, location) =>
  new FetchHeadReadOnlyError(
    location === null || location.gitdir === under(location.worktree, '.git')
      ? `.git/${FETCH_HEAD}`
      : under(location.gitdir, FETCH_HEAD),
  )
