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

import type { FlagView } from '../../../spec/types.ts'
import { isoTimestamp } from '../../../../utils/dates.ts'
import { BadDateError, UnrecognizedArgumentError } from './errors.ts'
import { MEDIUM, parsePretty, type CommitFacts, type LogFormat } from './format.ts'
import { touches } from './pickaxe.ts'
import { loadRefs, SYMREF_PREFIX } from './refs.ts'
import { commitFacts, repoArgs, type Repo } from './repo.ts'

const HEAD_REF = 'HEAD'
const BRANCH_PREFIX = 'refs/heads/'
const TAG_PREFIX = 'refs/tags/'
const REMOTE_PREFIX = 'refs/remotes/'

/** The parsed shape of a `git log` invocation. */
export interface LogFlags {
  /** `-n`, how many commits to print. */
  readonly maxCount: number | null
  /** `--oneline`, one abbreviated row per commit. */
  readonly oneline: boolean
  /** `--reverse`, oldest first. */
  readonly reverse: boolean
  /** `-S`, the pickaxe string. */
  readonly search: string | null
  /** `--since` as an epoch second. */
  readonly since: number | null
  /** `--until` as an epoch second. */
  readonly until: number | null
  /** `--all`, start from every ref as well. */
  readonly allRefs: boolean
  /**
   * How each commit renders; medium unless `--oneline` or
   * `--pretty`/`--format` said otherwise.
   */
  readonly pretty: LogFormat
  /**
   * Print abbreviated ids, which `--oneline` implies and
   * `--pretty=oneline` alone does not.
   */
  readonly abbrevCommit: boolean
}

/**
 * Read a date flag as an epoch second, refusing what it cannot read.
 *
 * Accepts an ISO-8601 date or a bare epoch second. git accepts far more
 * (`2 weeks ago`, `yesterday`); anything else is refused here rather than
 * silently ignored, which would quietly widen the window.
 */
function timestamp(value: string | null, flag: string): number | null {
  if (value === null) return null
  const parsed = isoTimestamp(value)
  if (parsed !== null) return parsed
  const asNumber = Number(value)
  if (value.trim() !== '' && Number.isFinite(asNumber)) return asNumber
  throw new BadDateError(flag, value)
}

/**
 * The --pretty/--format value, honoring the bare optional form.
 *
 * Both spellings set the same variable in git; `--format` is read first when
 * both appear on one line, an ordering the flag bag cannot preserve. A bare
 * `--pretty` means medium, git's own default, but pretty.c reads `--format`
 * only in its =value form, so the bare spelling gets git's own fatal
 * (pinned: 2.37 and 2.54, exit 128).
 */
export function prettyValue(fl: FlagView): string | null {
  for (const key of ['format', 'pretty']) {
    const raw = fl.raw(key)
    if (typeof raw === 'string') return raw
    if (raw === true) {
      if (key === 'format') throw new UnrecognizedArgumentError('--format')
      return 'medium'
    }
  }
  return null
}

/** Read the raw log flag kwargs into a frozen struct. */
export function parseFlags(fl: FlagView): LogFlags {
  const oneline = fl.asBool('oneline')
  const spelled = prettyValue(fl)
  let pretty: LogFormat = oneline ? { kind: 'oneline', template: null } : MEDIUM
  if (spelled !== null) pretty = parsePretty(spelled)
  return {
    maxCount: fl.asInt('n') ?? null,
    oneline,
    reverse: fl.asBool('reverse'),
    search: fl.asStr('S') ?? null,
    since: timestamp(fl.asStr('since') ?? null, '--since'),
    until: timestamp(fl.asStr('until') ?? null, '--until'),
    allRefs: fl.asBool('all'),
    pretty,
    abbrevCommit: oneline,
  }
}

/** Whether an isomorphic-git error means "not that object type". */
function isWrongType(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ObjectTypeError'
  )
}

/** Follow tag objects down to the commit a ref ultimately names. */
async function peelToCommit(repo: Repo, oid: string): Promise<CommitFacts | null> {
  let cursor = oid
  for (;;) {
    try {
      const { tag } = await git.readTag({ ...repoArgs(repo), oid: cursor })
      cursor = tag.object
    } catch (err) {
      // Not a tag object: read it as a commit instead.
      if (isWrongType(err)) break
      throw err
    }
  }
  try {
    return await commitFacts(repo, cursor)
  } catch (err) {
    // A ref may name a tree or blob, which no log walks from.
    if (isWrongType(err)) return null
    throw err
  }
}

/** A ref table with symrefs resolved to the ids they name. */
async function resolvedRefs(repo: Repo): Promise<Map<string, string>> {
  const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
  const out = new Map<string, string>()
  for (const [name, value] of refs) {
    const target = value.startsWith(SYMREF_PREFIX)
      ? refs.get(value.slice(SYMREF_PREFIX.length).trim())
      : value
    // A symref to an unborn branch names nothing yet.
    if (target !== undefined && !target.startsWith(SYMREF_PREFIX)) out.set(name, target)
  }
  return out
}

/** Every commit a ref points at, tags peeled, for `--all`. */
export async function refCommits(repo: Repo): Promise<CommitFacts[]> {
  const refs = await resolvedRefs(repo)
  const commits: CommitFacts[] = []
  for (const name of [...refs.keys()].sort()) {
    const oid = refs.get(name)
    if (oid === undefined) continue
    const commit = await peelToCommit(repo, oid)
    if (commit !== null) commits.push(commit)
  }
  return commits
}

/**
 * Ref labels per commit, in the order git prints them.
 *
 * git walks refs alphabetically and prepends each label, so a commit's labels
 * read in reverse ref order; HEAD is pulled to the front, spelled
 * `HEAD -> branch` when attached (the branch's own label is absorbed) and
 * `HEAD` alone when detached. Pinned against git 2.50.
 */
export async function decorations(repo: Repo): Promise<Map<string, string[]>> {
  const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
  const resolved = await resolvedRefs(repo)
  const labels = new Map<string, string[]>()
  for (const name of [...resolved.keys()].sort()) {
    if (name === HEAD_REF) continue
    const oid = resolved.get(name)
    if (oid === undefined) continue
    const commit = await peelToCommit(repo, oid)
    if (commit === null) continue
    const list = labels.get(commit.oid) ?? []
    list.unshift(refLabel(name))
    labels.set(commit.oid, list)
  }
  await decorateHead(repo, refs, resolved, labels)
  return labels
}

/** One ref's decoration label, in git's spelling. */
function refLabel(name: string): string {
  if (name.startsWith(TAG_PREFIX)) return `tag: ${name.slice(TAG_PREFIX.length)}`
  if (name.startsWith(BRANCH_PREFIX)) return name.slice(BRANCH_PREFIX.length)
  if (name.startsWith(REMOTE_PREFIX)) return name.slice(REMOTE_PREFIX.length)
  return name
}

/** Prepend the HEAD label, absorbing the attached branch's own. */
async function decorateHead(
  repo: Repo,
  refs: ReadonlyMap<string, string>,
  resolved: ReadonlyMap<string, string>,
  labels: Map<string, string[]>,
): Promise<void> {
  const oid = resolved.get(HEAD_REF)
  if (oid === undefined) return
  const commit = await peelToCommit(repo, oid)
  if (commit === null) return
  const list = labels.get(commit.oid) ?? []
  const raw = refs.get(HEAD_REF) ?? ''
  if (raw.startsWith(SYMREF_PREFIX)) {
    const branch = refLabel(raw.slice(SYMREF_PREFIX.length).trim())
    const at = list.indexOf(branch)
    if (at !== -1) list.splice(at, 1)
    list.unshift(`HEAD -> ${branch}`)
  } else {
    list.unshift(HEAD_REF)
  }
  labels.set(commit.oid, list)
}

/**
 * Walk history from a set of commits, newest first, along every parent.
 *
 * Ordered by committer time with ties broken by insertion, which is what a
 * git log without `--topo-order` prints. Each commit is visited once however
 * many branches reach it.
 */
async function* walkHistory(
  repo: Repo,
  starts: readonly CommitFacts[],
): AsyncGenerator<CommitFacts> {
  const seen = new Set<string>()
  const queue: CommitFacts[] = []
  for (const start of starts) {
    if (seen.has(start.oid)) continue
    seen.add(start.oid)
    queue.push(start)
  }
  while (queue.length > 0) {
    queue.sort((a, b) => b.committerTime - a.committerTime)
    const next = queue.shift()
    if (next === undefined) break
    yield next
    for (const parent of next.parents) {
      if (seen.has(parent)) continue
      seen.add(parent)
      queue.push(await commitFacts(repo, parent))
    }
  }
}

/**
 * The commits a log invocation prints, in the order it prints them.
 *
 * Order of operations is git's: walk history, drop what the filters reject, cut
 * to `-n`, and only then reverse. Reversing last is what makes
 * `-S <name> --reverse` name the commit that introduced a string rather than the
 * most recent one to touch it.
 *
 * @param repo repository to walk
 * @param starts the commits to walk back from; more than one when `--all`
 *   seeds every ref
 * @param flags the parsed invocation
 */
export async function select(
  repo: Repo,
  starts: readonly CommitFacts[],
  flags: LogFlags,
): Promise<CommitFacts[]> {
  const selected: CommitFacts[] = []
  for await (const commit of walkHistory(repo, starts)) {
    if (flags.since !== null && commit.authorTime <= flags.since) continue
    if (flags.until !== null && commit.authorTime > flags.until) continue
    if (flags.search !== null && !(await touches(repo, commit.oid, commit.parents, flags.search))) {
      continue
    }
    selected.push(commit)
    if (flags.maxCount !== null && selected.length >= flags.maxCount) break
  }
  if (flags.reverse) selected.reverse()
  return selected
}
