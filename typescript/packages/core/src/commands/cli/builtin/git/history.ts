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
import { BreError, PosixSyntax, searchBre, translateEre } from '../../../builtin/utils/bre.ts'
import { GitError } from './errors.ts'
import { HEAD } from './constants.ts'

import type { FlagView } from '../../../spec/flag_view.ts'
import { isoTimestamp } from '../../../../utils/dates.ts'
import {
  BadDateError,
  IncompatibleLogOptionsError,
  InvalidDecorateError,
  UnrecognizedArgumentError,
  UsageError,
} from './errors.ts'
import {
  MEDIUM,
  needsDecorations,
  parsePretty,
  type CommitFacts,
  type LogFormat,
} from './format.ts'
import { greps, touches } from './pickaxe.ts'
import { loadRefs, SYMREF_PREFIX } from './refs.ts'
import { commitFacts, repoArgs, type Repo } from './repo.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { compilePosixRegex, POSIX_CLASSES } from '../../../../utils/posix.ts'
import { mappedIdentity } from './mailmap.ts'
import { dateClock, parseDateMode } from './dates.ts'
import { configValues } from './fs.ts'
import { maybeBool } from './util.ts'
import { Decoration, type DateMode, type MailmapEntry } from './types.ts'

const BRANCH_PREFIX = 'refs/heads/'
// How many hidden commits a limited walk takes past the point where only
// hidden ones are queued, git's SLOP.
const SLOP = 5
const TAG_PREFIX = 'refs/tags/'
const REMOTE_PREFIX = 'refs/remotes/'
const BASIC_REGEXP = 'basic_regexp'
const EXTENDED_REGEXP = 'extended_regexp'
const FIXED_STRINGS = 'fixed_strings'
const PERL_REGEXP = 'perl_regexp'
// The pattern syntax switches; the last one on the line wins.
const PATTERN_SYNTAXES = [BASIC_REGEXP, EXTENDED_REGEXP, FIXED_STRINGS, PERL_REGEXP]
const COMMAND_LINE_ORIGIN = 'command line'
const HEADER_ORIGIN = 'header'
// The punctuation a `u` regex still accepts after a backslash.
const U_SYNTAX = '^$\\.*+?()[]{}|/'
// PCRE's subject anchors; git matches a line at a time, so `\Z` is `\z`.
const PERL_ANCHORS: Readonly<Record<string, string>> = { A: '^', z: '$', Z: '$' }

/** The parsed shape of a `git log` invocation. */
export interface LogFlags {
  /** `--author` patterns, any of which may match. */
  readonly authors: readonly RegExp[]
  /** `--grep` patterns, any of which may match a line of the message. */
  readonly greps: readonly RegExp[]
  /** `--committer` patterns, any of which may match. */
  readonly committers: readonly RegExp[]
  /** The worktree `.mailmap`, which `%aN`-style placeholders always read. */
  readonly mailmap: readonly MailmapEntry[]
  /**
   * `log.mailmap` or `--[no-]mailmap`: map the header identities and what
   * `--author` and `--committer` match.
   */
  readonly useMailmap: boolean
  /** `-i`, which folds case for `--grep`, `--author` and `-S` alike. */
  readonly ignoreCase: boolean
  readonly minParents: number | null
  readonly maxParents: number | null
  readonly firstParent: boolean
  readonly date: DateMode
  /**
   * How commits are labelled with their refs; parseFlags leaves it off, and
   * `decorationFor` settles it once the repository's config can be read.
   */
  readonly decorate: Decoration
  /** `-n`/`--max-count`, how many commits to print; null when unlimited. */
  readonly maxCount: number | null
  /** `--oneline`, one abbreviated row per commit. */
  readonly oneline: boolean
  /** `--reverse`, oldest first. */
  readonly reverse: boolean
  /** `-S`, the pickaxe string, or its pattern under `--pickaxe-regex`. */
  readonly search: string | RegExp | null
  /** `-G`, the pattern an added or removed line must match. */
  readonly changed: RegExp | null
  /** Search binary changed lines under `--text`. */
  readonly forceText: boolean
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
  /** `--graph`, draw the history beside the commits. */
  readonly graph: boolean
  /**
   * The walk order: newest first (`default`), `topo` (`--topo-order`, which
   * `--graph` implies) or `date` (`--date-order`).
   */
  readonly order: 'default' | 'topo' | 'date'
}

/** One commit of a walk: drawn by `--graph` always, printed unless `-S` passed it by. */
export interface WalkStep {
  readonly commit: CommitFacts
  readonly shown: boolean
}

/** The commits a log walks, in order, and the ones a graph may draw an edge to. */
export interface Walk {
  readonly steps: readonly WalkStep[]
  /**
   * Every commit in the walk that no filter leaves out, which is what makes
   * it a parent `--graph` draws a line to. Filled only for an ordered walk.
   */
  readonly interesting: ReadonlySet<string>
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
 * Read display formats in command-line order, validating every occurrence.
 * --oneline sets the format; its abbreviation side effect is read separately.
 * Bare --pretty resets to medium, while bare --format is always an error
 * (Git 2.50.1).
 */
export function prettyFormat(fl: FlagView): LogFormat {
  let pretty: LogFormat = MEDIUM
  for (const [key, raw] of fl.occurrences('oneline', 'pretty', 'format')) {
    if (key === 'oneline') {
      if (raw === true) pretty = { kind: 'oneline', template: null }
    } else if (typeof raw === 'string') {
      pretty = parsePretty(raw)
    } else if (raw === true) {
      if (key === 'format') throw new UnrecognizedArgumentError('--format')
      pretty = MEDIUM
    }
  }
  return pretty
}

/**
 * One `--grep`, `--author` or `--committer` pattern, compiled.
 *
 * A refusal names where the pattern came from and the pattern itself, as
 * git's `compile_regexp_failed` words it; the reason after that is glibc's
 * for a basic expression and the host engine's otherwise.
 */
function pattern(value: string, syntax: string, ignoreCase: boolean, origin: string): RegExp {
  try {
    if (syntax === PERL_REGEXP) return perlRegex(value, ignoreCase)
    const fold = ignoreCase ? 'i' : ''
    if (syntax === FIXED_STRINGS)
      return compilePosixRegex(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), fold)
    if (syntax === EXTENDED_REGEXP) {
      return compilePosixRegex(translateEre(value, PosixSyntax.EXTENDED)[0], fold)
    }
    return searchBre(value, ignoreCase)
  } catch (err) {
    if (err instanceof BreError || err instanceof SyntaxError)
      throw new GitError(`${origin}, '${value}': ${err.message}`)
    throw err
  }
}

/**
 * A `-P` pattern as a JavaScript `u` regex, which already reads PCRE's
 * `\p{L}`, lookarounds and lazy quantifiers. What `u` lacks or refuses is
 * rewritten to PCRE's meaning: a POSIX class inside a bracket, `\A`, `\z`
 * and `\Z`, a leading `(?i)`, a backslash before punctuation, a `]` first
 * in a bracket and a brace that opens no quantifier are all literals or
 * anchors in PCRE2, the same set Python's `regex` engine reads natively.
 */
function perlRegex(value: string, ignoreCase: boolean): RegExp {
  let flags = ignoreCase ? 'iu' : 'u'
  let source = value
  const inline = /^\(\?([ims]+)\)/.exec(source)
  if (inline) {
    for (const flag of inline[1] ?? '') if (!flags.includes(flag)) flags += flag
    source = source.slice(inline[0].length)
  }
  let out = ''
  let bracket = -1
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i)
    if (ch === '\\' && i + 1 < source.length) {
      const next = source.charAt(i + 1)
      i += 1
      if (bracket < 0 && PERL_ANCHORS[next] !== undefined) out += PERL_ANCHORS[next]
      else if ('pP'.includes(next) && source.charAt(i + 1) === '{' && source.includes('}', i)) {
        const close = source.indexOf('}', i)
        out += ch + next + source.slice(i + 1, close + 1)
        i = close
      } else if (
        /[A-Za-z0-9]/.test(next) ||
        U_SYNTAX.includes(next) ||
        (bracket >= 0 && next === '-')
      )
        out += ch + next
      else out += '\\u{' + (next.codePointAt(0) ?? 0).toString(16) + '}'
      continue
    }
    if (bracket >= 0) {
      const name = /^\[:([a-z]+):\]/.exec(source.slice(i))
      if (name) {
        const members = Object.hasOwn(POSIX_CLASSES, name[1] ?? '')
          ? POSIX_CLASSES[name[1] ?? '']
          : undefined
        if (members === undefined) throw new SyntaxError('unknown POSIX class name')
        out += members
        i += name[0].length - 1
      } else if (ch === ']' && i > bracket) {
        out += ch
        bracket = -1
      } else out += ch === ']' || ch === '[' ? '\\' + ch : ch
      continue
    }
    if (ch === '[') {
      out += ch
      if (source.charAt(i + 1) === '^') {
        out += '^'
        i += 1
      }
      bracket = i + 1
      continue
    }
    if (ch === '{' && !/^\{\d+(?:,\d*)?\}/.test(source.slice(i))) out += '\\{'
    else if (ch === '}' && !/(?<!\\)\{\d+(?:,\d*)?$/.test(out)) out += '\\}'
    else out += ch
  }
  return new RegExp(out, flags)
}

/** Read the raw log flag kwargs into a frozen struct. */
/**
 * A `-G` or `--pickaxe-regex` pattern, compiled as git's diffcore-pickaxe
 * compiles it: POSIX extended whatever -E, -F or -P say, `-i` folding case,
 * and matched one line at a time (REG_NEWLINE). Linux regcomp keeps dot off
 * NUL, unlike Darwin.
 */
function pickaxePattern(value: string, ignoreCase: boolean): RegExp {
  try {
    return compilePosixRegex(
      translateEre(value, PosixSyntax.EXTENDED, false)[0],
      ignoreCase ? 'i' : '',
    )
  } catch (err) {
    if (err instanceof BreError || err instanceof SyntaxError) {
      throw new GitError(`invalid regex: ${err.message}`)
    }
    throw err
  }
}

export function parseFlags(
  fl: FlagView,
  env: Readonly<Record<string, string>> | null = null,
): LogFlags {
  const oneline = fl.asBool('oneline')
  const pretty = prettyFormat(fl)
  const graph = fl.asBool('graph')
  if (graph && fl.asBool('reverse')) throw new IncompatibleLogOptionsError('--graph', '--reverse')
  let order: LogFlags['order'] = graph ? 'topo' : 'default'
  for (const name of fl.typedOrder('topo_order', 'date_order')) {
    if (fl.asBool(name)) order = name === 'topo_order' ? 'topo' : 'date'
  }
  const ignoreCase = fl.asBool('regexp_ignore_case')
  let syntax = BASIC_REGEXP
  for (const [key] of fl.occurrences(...PATTERN_SYNTAXES)) syntax = key
  const committers = fl
    .asList('committer')
    .map((value) => pattern(value, syntax, ignoreCase, HEADER_ORIGIN))
  const authors = fl
    .asList('author')
    .map((value) => pattern(value, syntax, ignoreCase, HEADER_ORIGIN))
  const greps = fl
    .asList('grep')
    .flatMap((values) =>
      values.split('\n').map((value) => pattern(value, syntax, ignoreCase, COMMAND_LINE_ORIGIN)),
    )
  let search: string | RegExp | null = fl.asStr('S') ?? null
  const changed = fl.asStr('G') ?? null
  for (const [option, value] of [
    ['-S', search],
    ['-G', changed],
  ] as const) {
    if (value === '') throw new UsageError('', `error: ${option} requires a non-empty argument\n`)
  }
  if (search !== null && changed !== null) {
    throw new IncompatibleLogOptionsError('-G', '-S', '--find-object')
  }
  if (typeof search === 'string' && fl.asBool('pickaxe_regex')) {
    search = pickaxePattern(search, ignoreCase)
  }
  const maxCount = fl.asInt('max_count') ?? null
  return {
    authors,
    committers,
    mailmap: [],
    useMailmap: true,
    greps,
    ignoreCase,
    date: parseDateMode(fl.asStr('date') ?? 'default', dateClock(env)),
    decorate: Decoration.NONE,
    // git reads a negative count as no limit at all.
    maxCount: maxCount !== null && maxCount < 0 ? null : maxCount,
    minParents: fl.asBool('merges') ? 2 : (fl.asInt('min_parents') ?? null),
    maxParents: fl.asBool('no_merges') ? 1 : (fl.asInt('max_parents') ?? null),
    firstParent: fl.asBool('first_parent'),
    oneline,
    reverse: fl.asBool('reverse'),
    search,
    changed: changed === null ? null : pickaxePattern(changed, ignoreCase),
    forceText: fl.asBool('text'),
    since: timestamp(fl.asStr('after') ?? fl.asStr('since') ?? null, '--since'),
    until: timestamp(fl.asStr('before') ?? fl.asStr('until') ?? null, '--until'),
    allRefs: fl.asBool('all'),
    pretty,
    abbrevCommit: oneline,
    graph,
    order,
  }
}

/** Whether an isomorphic-git error means "not that object type". */
function isWrongType(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ObjectTypeError'
  )
}

/** Follow tag objects down to the commit a ref ultimately names. */
export async function peelToCommit(repo: Repo, oid: string): Promise<CommitFacts | null> {
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
export async function resolvedRefs(repo: Repo): Promise<Map<string, string>> {
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
  for (const name of [...refs.keys()].sort(compareCodePoints)) {
    const oid = refs.get(name)
    if (oid === undefined) continue
    const commit = await peelToCommit(repo, oid)
    if (commit !== null) commits.push(commit)
  }
  return commits
}

/**
 * `parse_decoration_style`: a boolean word or number, `short`, `full` or
 * `auto`, which decorates only a terminal and so never here; null for anything
 * else.
 *
 * @param value the `--decorate=` or `log.decorate` value
 */
export function decorationStyle(value: string): Decoration | null {
  const flag = maybeBool(value)
  if (flag !== null) return flag ? Decoration.SHORT : Decoration.NONE
  if (value === 'short') return Decoration.SHORT
  if (value === 'full') return Decoration.FULL
  if (value === 'auto') return Decoration.NONE
  return null
}

/**
 * How a `log` or `show` line labels its commits, as git's `cmd_log_init_finish`
 * settles it (pinned against git 2.47.3).
 *
 * `log.decorate` sets the style, a value it cannot read meaning none, and the
 * line's `--decorate[=<style>]` and `--no-decorate` override it, the last one
 * typed winning; `--pretty=raw` ignores the config. A template that prints
 * `%d` or `%D` is decorated even when nothing asked, by short names unless a
 * style says full, and one that prints neither loads no labels at all.
 *
 * @param repo the opened repository
 * @param fl the line's flags
 * @param pretty the line's format
 * @throws InvalidDecorateError a `--decorate` value that names no style
 */
export async function decorationFor(
  repo: Repo,
  fl: FlagView,
  pretty: LogFormat,
): Promise<Decoration> {
  let style: Decoration | null = null
  for (const [key, value] of fl.occurrences('decorate', 'no_decorate')) {
    if (key === 'no_decorate') style = Decoration.NONE
    else if (typeof value !== 'string') style = Decoration.SHORT
    else {
      style = decorationStyle(value)
      if (style === null) throw new InvalidDecorateError(value)
    }
  }
  if (style === null && pretty.kind !== 'raw') {
    const configured = (await configValues(repo.dispatch, repo.location, 'log.decorate')).at(-1)
    if (configured !== undefined) style = decorationStyle(configured)
  }
  style ??= Decoration.NONE
  if (pretty.kind !== 'format' && pretty.kind !== 'tformat') return style
  if (!needsDecorations(pretty)) return Decoration.NONE
  return style === Decoration.NONE ? Decoration.SHORT : style
}

/**
 * Ref labels per commit, in the order git prints them.
 *
 * git walks refs alphabetically and prepends each label, so a commit's labels
 * read in reverse ref order; HEAD is pulled to the front, spelled
 * `HEAD -> branch` when attached (the branch's own label is absorbed) and
 * `HEAD` alone when detached. Pinned against git 2.50.
 *
 * @param repo the opened repository
 * @param style `FULL` keeps each ref's whole name; anything else shortens it
 */
export async function decorations(
  repo: Repo,
  style: Decoration = Decoration.SHORT,
): Promise<Map<string, string[]>> {
  const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
  const resolved = await resolvedRefs(repo)
  const full = style === Decoration.FULL
  const labels = new Map<string, string[]>()
  for (const name of [...resolved.keys()].sort(compareCodePoints)) {
    if (name === HEAD) continue
    const oid = resolved.get(name)
    if (oid === undefined) continue
    const commit = await peelToCommit(repo, oid)
    if (commit === null) continue
    const list = labels.get(commit.oid) ?? []
    list.unshift(refLabel(name, full))
    labels.set(commit.oid, list)
  }
  await decorateHead(repo, refs, resolved, labels, full)
  return labels
}

/** One ref's decoration label, in git's spelling, by its short or its full name. */
function refLabel(name: string, full: boolean): string {
  if (name.startsWith(TAG_PREFIX)) return `tag: ${full ? name : name.slice(TAG_PREFIX.length)}`
  if (full) return name
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
  full: boolean,
): Promise<void> {
  const oid = resolved.get(HEAD)
  if (oid === undefined) return
  const commit = await peelToCommit(repo, oid)
  if (commit === null) return
  const list = labels.get(commit.oid) ?? []
  const raw = refs.get(HEAD) ?? ''
  if (raw.startsWith(SYMREF_PREFIX)) {
    const branch = refLabel(raw.slice(SYMREF_PREFIX.length).trim(), full)
    const at = list.indexOf(branch)
    if (at !== -1) list.splice(at, 1)
    list.unshift(`HEAD -> ${branch}`)
  } else {
    list.unshift(HEAD)
  }
  labels.set(commit.oid, list)
}

/**
 * Walk history from a set of commits, newest first, along every parent.
 *
 * Ordered by committer time with ties broken by insertion, which is what a
 * git log without `--topo-order` prints. Each commit is visited once however
 * many branches reach it.
 *
 * A hidden commit takes its whole ancestry out of the walk, through every
 * parent even under `--first-parent`, which is how git carries a range's
 * exclusion. With anything hidden the walk is git's limited one: it holds what
 * it finds, so a commit that a later hidden one turns out to reach still drops
 * out, and it runs past the point where every queued commit is hidden by
 * git's slop of five hidden commits, restarted whenever one is dated no older
 * than the last shown one. That slack is what keeps a history whose dates run
 * backwards from leaking commits the hidden side reaches late.
 */
async function* walkHistory(
  repo: Repo,
  starts: readonly CommitFacts[],
  firstParent: boolean,
  hidden: readonly CommitFacts[] = [],
): AsyncGenerator<CommitFacts> {
  const seen = new Set<string>()
  const excluded = new Set<string>()
  const visited = new Map<string, CommitFacts>()
  const queue: CommitFacts[] = []
  const held: CommitFacts[] = []
  const hide = async (oids: readonly string[]): Promise<void> => {
    const stack = [...oids]
    for (let oid = stack.pop(); oid !== undefined; oid = stack.pop()) {
      if (excluded.has(oid)) continue
      excluded.add(oid)
      const known = visited.get(oid)
      if (known !== undefined) stack.push(...known.parents)
      else if (!seen.has(oid)) {
        seen.add(oid)
        queue.push(await commitFacts(repo, oid))
      }
    }
  }
  for (const commit of hidden) {
    if (seen.has(commit.oid)) continue
    seen.add(commit.oid)
    excluded.add(commit.oid)
    queue.push(commit)
  }
  for (const start of starts) {
    if (seen.has(start.oid)) continue
    seen.add(start.oid)
    queue.push(start)
  }
  const limited = hidden.length > 0
  let slop = SLOP
  let date = Infinity
  while (queue.length > 0) {
    queue.sort((a, b) => b.committerTime - a.committerTime)
    const next = queue.shift()
    if (next === undefined) break
    visited.set(next.oid, next)
    if (excluded.has(next.oid)) {
      await hide(next.parents)
      if (queue.length === 0) break
      const newest = queue.reduce((most, commit) => Math.max(most, commit.committerTime), -Infinity)
      if (date <= newest || !queue.every((commit) => excluded.has(commit.oid))) slop = SLOP
      else slop -= 1
      if (slop === 0) break
      continue
    }
    date = next.committerTime
    if (limited) held.push(next)
    else yield next
    for (const parent of firstParent ? next.parents.slice(0, 1) : next.parents) {
      if (seen.has(parent)) continue
      seen.add(parent)
      queue.push(await commitFacts(repo, parent))
    }
  }
  for (const commit of held) if (!excluded.has(commit.oid)) yield commit
}

/**
 * Order a walk's commits so no parent comes before any of its children.
 *
 * git's sort_in_topological_order: a commit is emitted once every child in
 * the list has been, children counted only among the commits listed. `topo`
 * keeps a stack, so a merge's second parent's line is followed to its end
 * before the first parent's, and the tips come out in walk order; `date`
 * takes the newest ready commit instead, ties in the order they became ready.
 *
 * @param list the walk, newest first
 * @param order which of git's two orders
 */
function sortCommits(list: readonly CommitFacts[], order: 'topo' | 'date'): CommitFacts[] {
  const indegree = new Map<string, number>()
  const byOid = new Map<string, CommitFacts>()
  for (const commit of list) {
    indegree.set(commit.oid, 1)
    byOid.set(commit.oid, commit)
  }
  for (const commit of list) {
    for (const parent of commit.parents) {
      const count = indegree.get(parent)
      if (count !== undefined && count > 0) indegree.set(parent, count + 1)
    }
  }
  // A stack for topo; for date a heap on (newest, first ready).
  const ready: { commit: CommitFacts; seq: number }[] = []
  let seq = 0
  const before = (a: number, b: number): boolean => {
    const x = ready[a]
    const y = ready[b]
    if (x === undefined || y === undefined) return false
    if (x.commit.committerTime !== y.commit.committerTime) {
      return x.commit.committerTime > y.commit.committerTime
    }
    return x.seq < y.seq
  }
  const swap = (a: number, b: number): void => {
    const x = ready[a]
    const y = ready[b]
    if (x === undefined || y === undefined) return
    ready[a] = y
    ready[b] = x
  }
  const put = (commit: CommitFacts): void => {
    ready.push({ commit, seq })
    seq += 1
    if (order === 'topo') return
    for (let at = ready.length - 1; at > 0 && before(at, (at - 1) >> 1); at = (at - 1) >> 1) {
      swap(at, (at - 1) >> 1)
    }
  }
  const take = (): CommitFacts | undefined => {
    if (order === 'topo' || ready.length <= 1) return ready.pop()?.commit
    const top = ready[0]
    const last = ready.pop()
    if (last !== undefined) ready[0] = last
    for (let at = 0; ;) {
      let next = at
      for (const child of [2 * at + 1, 2 * at + 2]) {
        if (child < ready.length && before(child, next)) next = child
      }
      if (next === at) break
      swap(at, next)
      at = next
    }
    return top?.commit
  }
  for (const commit of list) if (indegree.get(commit.oid) === 1) put(commit)
  // The tips come out in the order the walk found them, which a stack
  // reverses unless it is turned over first.
  if (order === 'topo') ready.reverse()
  const sorted: CommitFacts[] = []
  for (let commit = take(); commit !== undefined; commit = take()) {
    for (const parent of commit.parents) {
      const count = indegree.get(parent)
      if (count === undefined || count === 0) continue
      indegree.set(parent, count - 1)
      const next = byOid.get(parent)
      if (count - 1 === 1 && next !== undefined) put(next)
    }
    indegree.set(commit.oid, 0)
    sorted.push(commit)
  }
  return sorted
}

/** Whether a commit's date is inside `--since`/`--until`. */
function inWindow(commit: CommitFacts, flags: LogFlags): boolean {
  if (flags.since !== null && commit.committerTime < flags.since) return false
  return flags.until === null || commit.committerTime <= flags.until
}

/**
 * Whether a `--grep` pattern matches the message. git searches the message a
 * line at a time, so `^` and `$` anchor to a line, and never the author or
 * committer header.
 */
function messageMatches(message: string, greps: readonly RegExp[]): boolean {
  const lines = message.split('\n')
  return greps.some((pattern) => lines.some((line) => pattern.test(line)))
}

/**
 * Whether a commit passes `--author`, `--grep`, `--merges`, `--no-merges` and
 * kin. Several `--author`s or several `--grep`s are alternatives, while an
 * `--author` and a `--grep` must both match.
 */
function filtersPass(commit: CommitFacts, flags: LogFlags): boolean {
  const mailmap = flags.useMailmap ? flags.mailmap : []
  const idents: [string, readonly RegExp[]][] = [
    [`${commit.authorName} <${commit.authorEmail}>`, flags.authors],
    [`${commit.committerName} <${commit.committerEmail}>`, flags.committers],
  ]
  for (const [ident, patterns] of idents) {
    const mapped = mappedIdentity(ident, mailmap)
    if (patterns.length && !patterns.some((re) => re.test(mapped))) return false
  }
  if (flags.greps.length && !messageMatches(commit.message, flags.greps)) return false
  if (flags.minParents !== null && commit.parents.length < flags.minParents) return false
  return !(
    flags.maxParents !== null &&
    flags.maxParents >= 0 &&
    commit.parents.length > flags.maxParents
  )
}

/**
 * The commits a log walks, in the order it walks them.
 *
 * Order of operations is git's: walk history, drop what the filters reject,
 * and cut at `-n` printed commits. A topological or date order needs the whole
 * walk first (git's limited walk), and is taken over the commits inside the
 * date window before the other filters run. The pickaxe is the one filter that
 * leaves a commit in the walk: git still draws it into the graph and only
 * declines to print it, which is why `--graph -S` shows `...` rows.
 *
 * @param repo repository to walk
 * @param starts the commits to walk back from; more than one when `--all`
 *   seeds every ref
 * @param flags the parsed invocation
 * @param hidden commits whose whole history is left out, the `A` of `A..B`
 */
/**
 * Whether the pickaxe, if any, keeps a commit: `-G`'s changed line, or `-S`'s
 * change in the count of a string or pattern.
 */
async function picked(repo: Repo, commit: CommitFacts, flags: LogFlags): Promise<boolean> {
  if (flags.changed !== null)
    return greps(repo, commit.oid, commit.parents, flags.changed, flags.forceText)
  if (flags.search === null) return true
  if (typeof flags.search === 'string') {
    return touches(repo, commit.oid, commit.parents, flags.search, flags.ignoreCase)
  }
  return touches(repo, commit.oid, commit.parents, flags.search)
}

export async function walked(
  repo: Repo,
  starts: readonly CommitFacts[],
  flags: LogFlags,
  hidden: readonly CommitFacts[] = [],
): Promise<Walk> {
  const steps: WalkStep[] = []
  const interesting = new Set<string>()
  if (flags.maxCount === 0) return { steps, interesting }
  let source: AsyncIterable<CommitFacts> | Iterable<CommitFacts> = walkHistory(
    repo,
    starts,
    flags.firstParent,
    hidden,
  )
  if (flags.order !== 'default') {
    const window: CommitFacts[] = []
    for await (const commit of source) if (inWindow(commit, flags)) window.push(commit)
    for (const commit of window) if (filtersPass(commit, flags)) interesting.add(commit.oid)
    source = sortCommits(window, flags.order)
  }
  let printed = 0
  for await (const commit of source) {
    if (!inWindow(commit, flags) || !filtersPass(commit, flags)) continue
    const shown = await picked(repo, commit, flags)
    steps.push({ commit, shown })
    if (shown) printed += 1
    if (flags.maxCount !== null && printed >= flags.maxCount) break
  }
  return { steps, interesting }
}

/**
 * The commits a log invocation prints, in the order it prints them.
 *
 * The walk's printed commits, reversed last when asked: reversing after the
 * cut is what makes `-S <name> --reverse` name the commit that introduced a
 * string rather than the most recent one to touch it.
 *
 * @param repo repository to walk
 * @param starts the commits to walk back from
 * @param flags the parsed invocation
 * @param hidden commits whose whole history is left out, the `A` of `A..B`
 */
export async function select(
  repo: Repo,
  starts: readonly CommitFacts[],
  flags: LogFlags,
  hidden: readonly CommitFacts[] = [],
): Promise<CommitFacts[]> {
  const selected = (await walked(repo, starts, flags, hidden)).steps
    .filter((step) => step.shown)
    .map((step) => step.commit)
  if (flags.reverse) selected.reverse()
  return selected
}
