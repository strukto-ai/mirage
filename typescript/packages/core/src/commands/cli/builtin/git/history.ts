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
import { RegexError } from '../../../../rs/errors.ts'
import { byteView, encodeText, utf8Locale } from '../../../../shell/bytes.ts'
import { posixRegex, type PosixRegex } from '../../../../rs/regex.ts'
import {
  AmbiguousArgumentError,
  BadRevisionError,
  GitError,
  NoSuchPathError,
  PatternCompileError,
  RevisionAndFilenameError,
} from './errors.ts'
import { HEAD, TEMPLATE_KINDS } from './constants.ts'

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
import { entries, shows, type DiffFlags } from './diff_output.ts'
import { HUNK_CONTEXT } from './patch.ts'
import type { Pickaxe } from './pickaxe.ts'
import { BRANCH_PREFIX, loadRefs, REMOTE_PREFIX, SYMREF_PREFIX, TAG_PREFIX } from './refs.ts'
import { commitFacts, configBool, repoArgs, type Repo } from './repo.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { sha1Hex } from '../../../../utils/hash.ts'
import { compilePosixRegex, POSIX_CLASSES } from '../../../../utils/posix.ts'
import { loadMailmap, mappedIdentity, useMailmap } from './mailmap.ts'
import { dateClock, parseDateMode } from './dates.ts'
import { configValues } from './fs.ts'
import { MARKER, maybeBool, splitMarked, startPoint } from './util.ts'
import { absoluteOperand, pathspecPatterns } from './pathspec.ts'
import { exists } from './io.ts'
import { splitRevisions } from './revparse.ts'
import { PathSpec } from '../../../../types.ts'
import type { Context } from '../../../config.ts'
import { Decoration, type DateMode, type MailmapEntry } from './types.ts'

// How many hidden commits a limited walk takes past the point where only
// hidden ones are queued, git's SLOP.
const SLOP = 5
// The diff a walk's pickaxe searches when the caller read no diff options: no
// renames paired and merges not diffed.
const PLUMBING_DIFF: DiffFlags = {
  nameOnly: false,
  nameStatus: false,
  stat: false,
  numstat: false,
  shortstat: false,
  summary: false,
  patch: false,
  noPatch: false,
  renames: null,
  merge: 'off',
  raw: false,
  abbrev: false,
  functionContext: false,
  forceText: false,
  context: HUNK_CONTEXT,
  quotePathFully: true,
  pathspecs: [],
}
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
/** A `--grep`, `--author` or `--committer` pattern: `-P` in the host's engine, the rest POSIX. */
export type LinePattern = RegExp | PosixRegex

export interface LogFlags {
  /** `--author` patterns, any of which may match. */
  readonly authors: readonly LinePattern[]
  /** `--grep` patterns, any of which may match a line of the message. */
  readonly greps: readonly LinePattern[]
  /** `--committer` patterns, any of which may match. */
  readonly committers: readonly LinePattern[]
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
  /** `-S` or `-G`, null for neither. */
  readonly pickaxe: Pickaxe | null
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
  /** `--boundary`, print the commits the walk stops at after the ones it shows. */
  readonly boundary: boolean
  /** The repository-relative patterns the history is limited to, none for the whole tree. */
  readonly pathspecs: readonly string[]
  /**
   * Whether `-m` or `--diff-merges` asks for merges' diffs against their
   * parents. Only then does a path walk keep merges' whole history; the
   * first-parent diff `--first-parent` implies leaves it simplified (git 2.47.3).
   */
  readonly mergeDiffs: boolean
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
  /** The `--boundary` commits, in the order they print after the walk. */
  readonly boundary: readonly CommitFacts[]
  /**
   * The parents a path-limited walk prints each of its commits with: under
   * `--graph` the nearest shown commits along the history it kept, otherwise
   * the ones it followed; empty when the walk is not limited.
   */
  readonly parents: ReadonlyMap<string, readonly string[]>
}

/**
 * What a walk records for `--boundary`: every commit it took off its queue,
 * hidden ones included, in that order, and the commits it hid.
 */
interface Trace {
  readonly popped: string[]
  readonly hidden: Set<string>
}

/**
 * Read a date flag as an epoch second, refusing what it cannot read.
 *
 * Accepts an ISO-8601 date or a bare epoch second. git accepts far more
 * (`2 weeks ago`, `yesterday`); anything else is refused here rather than
 * silently ignored, which would quietly widen the window. An empty value is
 * now, as git reads a date that says nothing (git 2.47: `--since=` lists no
 * past commit).
 */
function timestamp(value: string | null, flag: string, now: number): number | null {
  if (value === null) return null
  if (value === '') return now
  const parsed = isoTimestamp(value)
  if (parsed !== null) return parsed
  const asNumber = Number(value)
  if (value.trim() !== '' && Number.isFinite(asNumber)) return asNumber
  throw new BadDateError(flag, value)
}

/**
 * One end of the date window, from the last of its two spellings: `--after`
 * and `--since` (`--before` and `--until`) set one limit, and each occurrence
 * overwrites it, so the one typed last wins. Mirrors Python's `_window_end`.
 */
function windowEnd(
  fl: FlagView,
  names: readonly [string, string],
  flag: string,
  now: number,
): number | null {
  const last = fl.typedOrder(...names).at(-1)
  return timestamp(last === undefined ? null : (fl.asStr(last) ?? null), flag, now)
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
 * git words it; the reason after that is glibc's
 * for a basic expression and the host engine's otherwise.
 */
function pattern(
  value: string,
  syntax: string,
  ignoreCase: boolean,
  origin: string,
  utf8: boolean,
): LinePattern {
  try {
    if (syntax === PERL_REGEXP) return perlRegex(value, ignoreCase)
    if (syntax === FIXED_STRINGS) {
      const fold = ignoreCase ? 'i' : ''
      return compilePosixRegex(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), fold)
    }
    return posixRegex(byteView(value, utf8), syntax === EXTENDED_REGEXP, 'posix', ignoreCase, utf8)
  } catch (err) {
    if (err instanceof RegexError || err instanceof SyntaxError)
      throw new PatternCompileError(origin, value, err.message)
    throw err
  }
}

/** Whether a `--grep`, `--author` or `--committer` pattern matches `text`. */
function hits(pattern: LinePattern, text: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(text)
  return pattern.search(byteView(text, pattern.utf8)) !== null
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
function pickaxePattern(value: string, ignoreCase: boolean, utf8: boolean): PosixRegex {
  try {
    return posixRegex(byteView(value, utf8), true, 'posix', ignoreCase, utf8, true)
  } catch (err) {
    if (err instanceof RegexError) throw new GitError(`invalid regex: ${err.message}`)
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
  const utf8 = utf8Locale(env ?? undefined)
  let syntax = BASIC_REGEXP
  for (const [key] of fl.occurrences(...PATTERN_SYNTAXES)) syntax = key
  const committers = fl
    .asList('committer')
    .map((value) => pattern(value, syntax, ignoreCase, HEADER_ORIGIN, utf8))
  const authors = fl
    .asList('author')
    .map((value) => pattern(value, syntax, ignoreCase, HEADER_ORIGIN, utf8))
  const greps = fl
    .asList('grep')
    .flatMap((values) =>
      values
        .split('\n')
        .map((value) => pattern(value, syntax, ignoreCase, COMMAND_LINE_ORIGIN, utf8)),
    )
  const search = fl.asStr('S') ?? null
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
  let pickaxe: Pickaxe | null = null
  if (search !== null || changed !== null) {
    pickaxe = {
      needle:
        search !== null && fl.asBool('pickaxe_regex')
          ? pickaxePattern(search, ignoreCase, utf8)
          : search,
      changed: changed === null ? null : pickaxePattern(changed, ignoreCase, utf8),
      ignoreCase,
      forceText: fl.asBool('text'),
      every: fl.asBool('pickaxe_all'),
    }
  }
  const maxCount = fl.asInt('max_count') ?? null
  const clock = dateClock(env)
  return {
    authors,
    committers,
    mailmap: [],
    useMailmap: true,
    greps,
    ignoreCase,
    date: parseDateMode(fl.asStr('date', 'default'), clock),
    decorate: Decoration.NONE,
    // git reads a negative count as no limit at all.
    maxCount: maxCount !== null && maxCount < 0 ? null : maxCount,
    minParents: fl.asBool('merges') ? 2 : (fl.asInt('min_parents') ?? null),
    maxParents: fl.asBool('no_merges') ? 1 : (fl.asInt('max_parents') ?? null),
    firstParent: fl.asBool('first_parent'),
    oneline,
    reverse: fl.asBool('reverse'),
    pickaxe,
    since: windowEnd(fl, ['after', 'since'], '--since', clock.now),
    until: windowEnd(fl, ['before', 'until'], '--until', clock.now),
    allRefs: fl.asBool('all'),
    pretty,
    abbrevCommit: oneline,
    graph,
    order,
    boundary: fl.asBool('boundary'),
    mergeDiffs: fl.asBool('m') || PARENT_DIFFS.has(fl.asStr('diff_merges', 'off')),
    pathspecs: [],
  }
}

// The `--diff-merges` values that diff a merge against its parents, one by one
// or the first alone.
const PARENT_DIFFS = new Set(['on', '1', 'm', 'separate', 'first-parent'])

// What makes an operand a pattern git reads as a path unseen.
const WILDCARDS = ['*', '?', '[', '\\']

/**
 * A walk's operands as revisions and the patterns of the paths it is limited
 * to, and whether `--` was on the line; see `operands`.
 *
 * @param ctx the line's context, carrying its argv
 * @param fl the verb's flags, for `-C`
 * @param repo the opened repository
 * @param texts the operands
 */
export async function walkOperands(
  ctx: Context,
  fl: FlagView,
  repo: Repo,
  texts: readonly string[],
): Promise<[string[], string[], boolean]> {
  const argv = ctx.argv ?? []
  const start = startPoint(fl).virtual
  const [leading, marked] = splitMarked(texts, argv)
  const dashed = argv.includes(MARKER)
  const present = dashed ? new Set<string>() : await presentOperands(repo, start, leading)
  const [revisions, paths] = await operands(repo, leading, dashed, present)
  return [revisions, pathspecPatterns(repo.location, start, [...paths, ...marked]), dashed]
}

/**
 * The commits a walk starts from and hides, as `splitRevisions` reads them,
 * except that with `--` on the line a revision that resolves to nothing is a
 * bad revision (git 2.47.3).
 *
 * @param repo the opened repository
 * @param revisions the revision operands
 * @param dashed whether `--` is on the line
 */
export async function walkEnds(
  repo: Repo,
  revisions: readonly string[],
  dashed: boolean,
): Promise<[CommitFacts[], CommitFacts[]]> {
  try {
    return await splitRevisions(repo, revisions)
  } catch (err) {
    if (!dashed || !(err instanceof AmbiguousArgumentError)) throw err
    throw new BadRevisionError(err.revision)
  }
}

/**
 * The operands that name something in the working tree, as git looks before it
 * reads an operand as a path.
 */
async function presentOperands(
  repo: Repo,
  start: string,
  texts: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>()
  for (const text of texts) {
    if (text && (await exists(repo.vfs, PathSpec.fromStrPath(absoluteOperand(start, text)))))
      found.add(text)
  }
  return found
}

/** Whether an operand is a pattern, which git takes as a path without looking for it. */
function wildcard(text: string): boolean {
  return WILDCARDS.some((char) => text.includes(char))
}

/**
 * Split the operands before any `--` into revisions and paths.
 *
 * With `--` on the line they are all revisions. Without it each is a revision
 * while it resolves as one, and one that also names a file is refused as
 * ambiguous; the first that does not resolve starts the paths, which then have
 * to name something in the working tree, as every later operand does, unless it
 * is a wildcard pattern (git 2.47.3).
 */
async function operands(
  repo: Repo,
  leading: readonly string[],
  dashed: boolean,
  present: ReadonlySet<string>,
): Promise<[string[], string[]]> {
  if (dashed) return [[...leading], []]
  for (const [index, text] of leading.entries()) {
    if (!(await resolves(repo, text))) {
      if (!present.has(text) && !wildcard(text)) throw new AmbiguousArgumentError(text)
      for (const later of leading.slice(index + 1)) {
        if (!present.has(later) && !wildcard(later)) throw new NoSuchPathError(later)
      }
      return [leading.slice(0, index), leading.slice(index)]
    }
    if (present.has(text)) throw new RevisionAndFilenameError(text)
  }
  return [[...leading], []]
}

/**
 * Whether an operand resolves as a revision, the warnings resolving it gives
 * left to the walk, which resolves it again.
 */
async function resolves(repo: Repo, text: string): Promise<boolean> {
  const kept = repo.ambiguous?.length ?? 0
  try {
    await splitRevisions(repo, [text])
    return true
  } catch (err) {
    if (err instanceof AmbiguousArgumentError) return false
    throw err
  } finally {
    repo.ambiguous?.splice(kept)
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
  const refs = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
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
 * The decoration style a value names: a boolean word or number, `short`, `full`
 * or `auto`, which decorates only a terminal and so never here; null for
 * anything else.
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
 * How a `log` or `show` line labels its commits, as git settles it (pinned
 * against git 2.47.3).
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
    const configured = (await configValues(repo.vfs, repo.location, 'log.decorate')).at(-1)
    if (configured !== undefined) style = decorationStyle(configured)
  }
  style ??= Decoration.NONE
  if (!TEMPLATE_KINDS.includes(pretty.kind)) return style
  if (!needsDecorations(pretty)) return Decoration.NONE
  return style === Decoration.NONE ? Decoration.SHORT : style
}

/**
 * How `log` and `show` present commits, once the repository's config can be
 * read: the worktree `.mailmap`, whether the header identities map through it
 * (`log.mailmap` unless the line's `--[no-]mailmap` says otherwise), and the
 * decoration style.
 *
 * @param repo the opened repository
 * @param fl the line's flags
 * @param pretty the line's format
 * @throws BadConfigValueError a `log.mailmap` git cannot read as a boolean
 * @throws InvalidDecorateError a `--decorate` value that names no style
 */
export async function displayed(
  repo: Repo,
  fl: FlagView,
  pretty: LogFormat,
): Promise<[readonly MailmapEntry[], boolean, Decoration]> {
  return [
    await loadMailmap(repo.vfs, repo.location),
    useMailmap(fl, await configBool(repo, 'log.mailmap', true)),
    await decorationFor(repo, fl, pretty),
  ]
}

/**
 * Ref labels per commit, in the order git prints them; null for a line that
 * prints none.
 *
 * git walks refs alphabetically and prepends each label, so a commit's labels
 * read in reverse ref order; HEAD is pulled to the front, spelled
 * `HEAD -> branch` when attached (the branch's own label is absorbed) and
 * `HEAD` alone when detached. Pinned against git 2.50.
 *
 * @param repo the opened repository
 * @param style `FULL` keeps each ref's whole name, `NONE` loads nothing;
 *   anything else shortens it
 */
export async function decorations(
  repo: Repo,
  style: Decoration = Decoration.SHORT,
): Promise<Map<string, string[]> | null> {
  if (style === Decoration.NONE) return null
  const refs = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
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
 * git's default history simplification, for a walk limited to paths.
 *
 * A commit is shown when it is not TREESAME to its parents, its tree and
 * theirs holding the same entries at the paths: a root when the paths hold
 * anything, a commit with one parent when it changed them, and a merge only
 * when no parent is TREESAME to it. A merge TREESAME to a parent leads on to
 * the first such parent alone, so history the paths came by some other way
 * drops out. A parent the walk hid on its way down does not count, while one it
 * was told to hide (`^A`, a range's left end, the merge base of `A...B`) does
 * (git 2.47.3). When merges are diffed against each parent (`-m`,
 * `--diff-merges=first-parent`) git keeps their whole history instead: a merge
 * leads on to every parent and is shown when it differs from any of them, or
 * always where `--graph` draws the history. Mirrors _Simplifier in history.py.
 */
class Simplifier {
  private readonly views = new Map<string, string | null>()
  private readonly nearest = new Map<string, readonly string[]>()
  private hidden: ReadonlySet<string> = new Set()
  readonly followed = new Map<string, readonly string[]>()
  readonly shown = new Map<string, boolean>()

  constructor(
    private readonly repo: Repo,
    private readonly patterns: readonly string[],
    private readonly full = false,
    private readonly graph = false,
    private readonly bottoms: ReadonlySet<string> = new Set(),
  ) {}

  /**
   * A digest of the entries one commit holds at the paths, null when they hold
   * nothing.
   *
   * The walk only asks whether two commits hold the same entries, so only the
   * digest is kept, and a path log over a long history does not hold every
   * file at every commit.
   */
  private async view(oid: string): Promise<string | null> {
    let found = this.views.get(oid)
    if (found === undefined) {
      const tree = (await commitFacts(this.repo, oid)).tree
      const held = await entries(this.repo, tree, true, this.patterns)
      const lines = [...held]
        .sort(([a], [b]) => compareCodePoints(a, b))
        .map(([path, entry]) => `${entry.mode} ${path}\0${entry.oid}`)
      found = held.size ? await sha1Hex(encodeText(lines.join(''))) : null
      this.views.set(oid, found)
    }
    return found
  }

  /** Whether two commits hold the same entries at the paths. */
  private async same(a: string, b: string): Promise<boolean> {
    return (await this.view(a)) === (await this.view(b))
  }

  /**
   * Settle whether a walked commit is shown, and the parents it leads on to.
   *
   * @param commit the commit, just taken off the queue
   * @param parents the parents the walk would follow
   * @param hidden the commits hidden so far
   */
  async follow(
    commit: CommitFacts,
    parents: readonly string[],
    hidden: ReadonlySet<string>,
  ): Promise<readonly string[]> {
    this.hidden = hidden
    let followed = parents
    let shown: boolean
    const [first] = commit.parents
    if (first === undefined) shown = (await this.view(commit.oid)) !== null
    else if (commit.parents.length === 1) shown = !(await this.same(commit.oid, first))
    else if (this.full) {
      shown = this.graph
      for (const parent of parents) if (!(await this.same(commit.oid, parent))) shown = true
    } else {
      let same: string | null = null
      for (const parent of parents) {
        if (hidden.has(parent) && !this.bottoms.has(parent)) continue
        if (await this.same(commit.oid, parent)) {
          same = parent
          break
        }
      }
      shown = same === null
      if (same !== null) followed = [same]
    }
    this.shown.set(commit.oid, shown)
    this.followed.set(commit.oid, followed)
    return followed
  }

  /**
   * A shown commit's parents as `--graph` sees them: each followed parent, or
   * the nearest shown commits it leads on to when it is not shown itself, a
   * hidden one standing for itself.
   */
  rewritten(commit: CommitFacts): readonly string[] {
    const out = new Set<string>()
    for (const parent of this.followed.get(commit.oid) ?? []) {
      for (const oid of this.shownBelow(parent)) out.add(oid)
    }
    return [...out]
  }

  /** The nearest shown commits at or below one, null while not worked out. */
  private known(oid: string): readonly string[] | null {
    if (this.shown.get(oid) === true || this.hidden.has(oid)) return [oid]
    if (!this.followed.has(oid)) return []
    return this.nearest.get(oid) ?? null
  }

  /**
   * The nearest shown commits at or below one the walk followed, itself when
   * it is shown. Worked out from the bottom on a stack of its own, since a path
   * can go unchanged for longer than the engine can recurse.
   */
  private shownBelow(oid: string): readonly string[] {
    const stack = [oid]
    for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
      if (this.known(top) !== null) {
        stack.pop()
        continue
      }
      const followed = this.followed.get(top) ?? []
      const waiting = followed.filter((parent) => this.known(parent) === null)
      if (waiting.length) {
        for (const item of waiting.reverse()) stack.push(item)
        continue
      }
      const out = new Set<string>()
      for (const parent of followed) for (const below of this.known(parent) ?? []) out.add(below)
      this.nearest.set(top, [...out])
      stack.pop()
    }
    return this.known(oid) ?? []
  }
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
  trace: Trace | null = null,
  simplify: Simplifier | null = null,
): AsyncGenerator<CommitFacts> {
  const seen = new Set<string>()
  const excluded = trace?.hidden ?? new Set<string>()
  const visited = new Map<string, CommitFacts>()
  const queue: CommitFacts[] = []
  const held: CommitFacts[] = []
  const hide = async (oids: readonly string[]): Promise<void> => {
    const stack = [...oids]
    for (let oid = stack.pop(); oid !== undefined; oid = stack.pop()) {
      if (excluded.has(oid)) continue
      excluded.add(oid)
      const known = visited.get(oid)
      if (known !== undefined) for (const item of known.parents) stack.push(item)
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
    trace?.popped.push(next.oid)
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
    let parents = firstParent ? next.parents.slice(0, 1) : next.parents
    if (simplify !== null) parents = await simplify.follow(next, parents, excluded)
    if (limited) held.push(next)
    else yield next
    for (const parent of parents) {
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
 * A commit is ready once every child of it in the list is printed; children
 * outside the list do not hold it back, and every parent counts,
 * `--first-parent` or not. `topo` prints the commit a printed child made
 * ready last before the next tip in walk order, so a merge's last parent's
 * line runs to its end before an earlier parent's: git 2.50.1 prints
 * `M P2b P2a P1b P1a base` for a merge `M` of `P1b` and `P2b` whatever their
 * dates. `date` prints the newest ready commit, ties in the order they became
 * ready, the tips first in walk order.
 *
 * @param list the walk, newest first
 * @param order `--topo-order` or `--date-order`
 * @param parents the parents to order by, each commit's own when null
 */
function sortCommits(
  list: readonly CommitFacts[],
  order: 'topo' | 'date',
  parents: ReadonlyMap<string, readonly string[]> | null = null,
): CommitFacts[] {
  const parentsOf = (commit: CommitFacts): readonly string[] =>
    parents === null ? commit.parents : (parents.get(commit.oid) ?? [])
  const byOid = new Map(list.map((commit) => [commit.oid, commit]))
  const unprintedChildren = new Map(list.map((commit) => [commit.oid, 0]))
  for (const commit of list) {
    for (const parent of parentsOf(commit)) {
      const count = unprintedChildren.get(parent)
      if (count !== undefined) unprintedChildren.set(parent, count + 1)
    }
  }
  const tips = list.filter((commit) => unprintedChildren.get(commit.oid) === 0)
  const printed: CommitFacts[] = []
  const printCommit = (commit: CommitFacts): CommitFacts[] => {
    printed.push(commit)
    const freed: CommitFacts[] = []
    for (const parent of parentsOf(commit)) {
      const count = unprintedChildren.get(parent)
      if (count === undefined) continue
      unprintedChildren.set(parent, count - 1)
      const parentCommit = byOid.get(parent)
      if (count === 1 && parentCommit !== undefined) freed.push(parentCommit)
    }
    return freed
  }
  if (order === 'topo') {
    const freed: CommitFacts[] = []
    let upcoming = 0
    for (;;) {
      const commit = freed.length > 0 ? freed.pop() : tips[upcoming++]
      if (commit === undefined) return printed
      for (const item of printCommit(commit)) freed.push(item)
    }
  }
  // The ready commits on a heap keyed newest first and then earliest readied,
  // so the next one to print is at its top.
  const ready: { commit: CommitFacts; arrival: number }[] = []
  let arrivals = 0
  const before = (a: number, b: number): boolean => {
    const x = ready[a]
    const y = ready[b]
    if (x === undefined || y === undefined) return false
    if (x.commit.committerTime !== y.commit.committerTime) {
      return x.commit.committerTime > y.commit.committerTime
    }
    return x.arrival < y.arrival
  }
  const swap = (a: number, b: number): void => {
    const x = ready[a]
    const y = ready[b]
    if (x === undefined || y === undefined) return
    ready[a] = y
    ready[b] = x
  }
  const push = (commit: CommitFacts): void => {
    ready.push({ commit, arrival: arrivals++ })
    for (let at = ready.length - 1; at > 0 && before(at, (at - 1) >> 1); at = (at - 1) >> 1) {
      swap(at, (at - 1) >> 1)
    }
  }
  const pop = (): CommitFacts | undefined => {
    swap(0, ready.length - 1)
    const top = ready.pop()
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
  for (const tip of tips) push(tip)
  for (let next = pop(); next !== undefined; next = pop()) {
    for (const parent of printCommit(next)) push(parent)
  }
  return printed
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
function messageMatches(message: string, greps: readonly LinePattern[]): boolean {
  const lines = message.split('\n')
  return greps.some((pattern) => lines.some((line) => hits(pattern, line)))
}

/**
 * Whether a commit passes `--author`, `--grep`, `--merges`, `--no-merges` and
 * kin. Several `--author`s or several `--grep`s are alternatives, while an
 * `--author` and a `--grep` must both match.
 */
function filtersPass(commit: CommitFacts, flags: LogFlags): boolean {
  const mailmap = flags.useMailmap ? flags.mailmap : []
  // A commit whose text was not UTF-8 is matched as its bytes. The map is read
  // as text, so the identity is looked up the same way; one it leaves alone is
  // matched as its own bytes.
  const bytes = commit.bytes
  const idents: [string, string | undefined, readonly LinePattern[]][] = [
    [`${commit.authorName} <${commit.authorEmail}>`, bytes?.author, flags.authors],
    [`${commit.committerName} <${commit.committerEmail}>`, bytes?.committer, flags.committers],
  ]
  for (const [ident, exact, patterns] of idents) {
    if (patterns.length === 0) continue
    const mapped = mappedIdentity(ident, mailmap)
    const subject = mapped === ident ? (exact ?? ident) : mapped
    if (!patterns.some((re) => hits(re, subject))) return false
  }
  if (flags.greps.length && !messageMatches(bytes?.message ?? commit.message, flags.greps))
    return false
  if (flags.minParents !== null && commit.parents.length < flags.minParents) return false
  return !(
    flags.maxParents !== null &&
    flags.maxParents >= 0 &&
    commit.parents.length > flags.maxParents
  )
}

/**
 * The commits `--boundary` prints after the walk, in git's order.
 *
 * A boundary commit is a parent, any parent, of a walked commit that the walk
 * did not take itself: a hidden one, one a filter left out, or one past `-n`. A
 * pickaxe does not leave a commit out of the walk, so the parents of a commit
 * it passed by count too; the paths do.
 *
 * Under `--date-order` they print newest first. Otherwise they follow the walk:
 * each one leaving the queue with no boundary child listed goes to the front,
 * and each listed one puts its boundary parents right after itself, in parent
 * order, so a run of commits git reaches through one another prints together
 * and later runs print first. The ones `-n` cut off print before them all, and
 * the ones the walk never reached after, newest first (git 2.47.3; the order
 * differs at times where git reaches one only through another's merge).
 *
 * @param repo repository holding the commits
 * @param steps the walked commits
 * @param trace the walk's queue order and hidden set
 * @param byDate `--date-order`
 * @param stopped whether `-n` cut the walk short
 * @param parents the parents the walk prints its commits with, each commit's
 *   own when absent
 */
async function boundaryOf(
  repo: Repo,
  steps: readonly WalkStep[],
  trace: Trace,
  byDate: boolean,
  stopped: boolean,
  parents: ReadonlyMap<string, readonly string[]>,
): Promise<CommitFacts[]> {
  const walkedIds = new Set(steps.map((step) => step.commit.oid))
  const found = new Map<string, CommitFacts>()
  for (const step of steps) {
    for (const parent of parents.get(step.commit.oid) ?? step.commit.parents) {
      if (!walkedIds.has(parent) && !found.has(parent))
        found.set(parent, await commitFacts(repo, parent))
    }
  }
  const time = (oid: string): number => found.get(oid)?.committerTime ?? 0
  const newest = (oids: Iterable<string>): string[] => [...oids].sort((a, b) => time(b) - time(a))
  const facts = (oids: readonly string[]): CommitFacts[] =>
    oids.flatMap((oid) => {
      const commit = found.get(oid)
      return commit === undefined ? [] : [commit]
    })
  if (byDate) return facts(newest(found.keys()))
  const lastStep = steps[steps.length - 1]
  const last =
    stopped && lastStep !== undefined
      ? trace.popped.indexOf(lastStep.commit.oid)
      : trace.popped.length
  const passed = trace.popped.slice(0, last + 1)
  const reached = new Set(passed)
  const cut = newest([...found.keys()].filter((oid) => !trace.hidden.has(oid) && !reached.has(oid)))
  const cutSet = new Set(cut)
  const listed: string[] = []
  for (const oid of passed) {
    if (found.has(oid) && !cutSet.has(oid) && !listed.includes(oid)) listed.unshift(oid)
    const at = listed.indexOf(oid)
    if (at === -1) continue
    for (const parent of found.get(oid)?.parents ?? []) {
      if (found.has(parent) && !cutSet.has(parent) && !listed.includes(parent))
        listed.splice(at + 1, 0, parent)
    }
  }
  const rest = newest([...found.keys()].filter((oid) => !cutSet.has(oid) && !listed.includes(oid)))
  return facts([...cut, ...listed, ...rest])
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
 * @param diff the diff the pickaxe searches: its renames, its merge diff and its paths
 */
export async function walked(
  repo: Repo,
  starts: readonly CommitFacts[],
  flags: LogFlags,
  hidden: readonly CommitFacts[] = [],
  diff: DiffFlags = PLUMBING_DIFF,
): Promise<Walk> {
  const steps: WalkStep[] = []
  const interesting = new Set<string>()
  // The parents a path-limited walk prints its commits with: the ones `--graph`
  // draws, and for a merge the paths cut down to the parent it follows, which
  // only `--boundary` ever prints, that one parent.
  const parents = new Map<string, readonly string[]>()
  if (flags.maxCount === 0) return { steps, interesting, boundary: [], parents }
  const searched: DiffFlags = { ...diff, pickaxe: flags.pickaxe }
  const trace: Trace | null = flags.boundary ? { popped: [], hidden: new Set() } : null
  const simplify = flags.pathspecs.length
    ? new Simplifier(
        repo,
        flags.pathspecs,
        flags.mergeDiffs && (diff.merge === 'separate' || diff.merge === 'first-parent'),
        flags.graph,
        new Set(hidden.map((commit) => commit.oid)),
      )
    : null
  const kept = (commit: CommitFacts): boolean =>
    simplify === null || simplify.shown.get(commit.oid) === true
  let source: AsyncIterable<CommitFacts> | Iterable<CommitFacts> = walkHistory(
    repo,
    starts,
    flags.firstParent,
    hidden,
    trace,
    simplify,
  )
  if (flags.order !== 'default') {
    // The commits the paths leave out still take their place in the order,
    // merges leading only to the parent they follow; they drop out after,
    // which is where a log draws its graph from.
    const window: CommitFacts[] = []
    for await (const commit of source) if (inWindow(commit, flags)) window.push(commit)
    for (const commit of window) {
      if (simplify !== null && flags.graph && kept(commit))
        parents.set(commit.oid, simplify.rewritten(commit))
      if (filtersPass(commit, flags) && kept(commit)) interesting.add(commit.oid)
    }
    source = sortCommits(window, flags.order, simplify?.followed ?? null)
  }
  let printed = 0
  for await (const commit of source) {
    if (!inWindow(commit, flags) || !filtersPass(commit, flags) || !kept(commit)) continue
    const shown = await shows(repo, commit, searched)
    steps.push({ commit, shown })
    if (shown) printed += 1
    if (flags.maxCount !== null && printed >= flags.maxCount) break
  }
  const stopped = flags.maxCount !== null && printed >= flags.maxCount
  if (trace === null) return { steps, interesting, boundary: [], parents }
  const boundary: CommitFacts[] = []
  const date = flags.order === 'date'
  for (const commit of await boundaryOf(repo, steps, trace, date, stopped, parents)) {
    if (await shows(repo, commit, searched)) boundary.push(commit)
  }
  for (const commit of boundary) {
    interesting.add(commit.oid)
    const followed = simplify?.followed.get(commit.oid)
    if (simplify?.shown.get(commit.oid) === false && followed !== undefined)
      parents.set(commit.oid, followed)
  }
  return { steps, interesting, boundary, parents }
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
 * @param diff the diff the pickaxe searches
 */
export async function select(
  repo: Repo,
  starts: readonly CommitFacts[],
  flags: LogFlags,
  hidden: readonly CommitFacts[] = [],
  diff: DiffFlags = PLUMBING_DIFF,
): Promise<CommitFacts[]> {
  return inPrintOrder(await walked(repo, starts, flags, hidden, diff), flags)
}

/**
 * The commits a walk prints, in the order it prints them: the shown ones, then
 * the `--boundary` ones, all of them reversed under `--reverse`.
 *
 * @param walk the walk
 * @param flags the parsed invocation
 */
export function inPrintOrder(walk: Walk, flags: LogFlags): CommitFacts[] {
  const selected = walk.steps.filter((step) => step.shown).map((step) => step.commit)
  for (const item of walk.boundary) selected.push(item)
  if (flags.reverse) selected.reverse()
  return selected
}
