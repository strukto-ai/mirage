import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { PathSpec } from '../../../../types.ts'
import { loadRefs, resolveSymbolic, validBranchName, validRefName } from './refs.ts'
import { shortenRef } from './ref_fields.ts'
import { abbrevWidth } from './format.ts'
import git from 'isomorphic-git'
import { VERSION } from '../../../../version.ts'

import { compareCodePoints } from '../../../../utils/sort.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { CommandSpec, Argument, type FlagValue } from '../../../spec/types.ts'
import { parseCommand, parseToKwargs } from '../../../spec/parser.ts'
import { UsageStyle } from '../../../spec/types.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import {
  AbbrevModeError,
  AmbiguousArgumentError,
  ConfigUsageError,
  GitError,
  NoSuchPathError,
  NotAWorkTreeError,
  SelectorError,
  SingleRevisionError,
  UnknownSubcommandError,
  UnrecognizedArgumentError,
  UsageError,
} from './errors.ts'
import { inPrintOrder, parseFlags, refCommits, walkEnds, walkOperands, walked } from './history.ts'
import { resolveRef, uniqueAbbreviations } from './ref_list.ts'
import type { CommitFacts } from './format.ts'
import { commitFacts, configBool, objectType, repoArgs, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { configLines, type ConfigLine } from './fs.ts'
import { exists, readFile, readOptional } from './io.ts'
import { absoluteOperand } from './pathspec.ts'
import { fnmatch } from '../../../../utils/fnmatch.ts'
import {
  expandSelector,
  mergeBases,
  NEGATION,
  RANGE,
  rangeEnds,
  SELECTOR_OPEN,
  refsNamed,
  resolveCommit,
  resolveObject,
} from './revparse.ts'
import {
  checkOperands,
  checkSwitches,
  escaped,
  fatal,
  MARKER,
  loneHelp,
  optionOperand,
  offending,
  startPoint,
  verbUsage,
} from './util.ts'
import { gitOptionRefusal, gitUsage, leafRefusal } from '../../refusal.ts'
import { GIT_LONG_OPTIONS } from '../../constants.ts'
import { HEAD } from './constants.ts'
import { inGitDir, isBare } from './discover.ts'
import type { RepoLocation } from './types.ts'
import type { Files } from '../../../../workspace/files.ts'
import { GLOB_CHARS } from '../../../../utils/glob_walk.ts'

const ENC = new TextEncoder()
const SHOW_TOPLEVEL = '--show-toplevel'
const ALL_REFS = '--all'
const GLOB_OPTION = '--glob'
const EXCLUDE_OPTION = '--exclude'
const REF_NAMESPACES = new Map([
  ['--branches', 'refs/heads/'],
  ['--tags', 'refs/tags/'],
  ['--remotes', 'refs/remotes/'],
])
const PATH_ABSOLUTE = 'absolute'
const PATH_RELATIVE = 'relative'
const OBJECT_FORMAT_MODES = ['storage', 'input', 'output']
const PARENT_SUFFIX = '^'
const SYMBOLIC_AS_TYPED = 'as-typed'
const SYMBOLIC_FULL = 'full'
const SYMBOLIC_ABBREVIATED = 'abbreviated'
// Paths a linked worktree reads from the repository it was cut from.
const SHARED_PATHS = new Set([
  'branches',
  'common',
  'config',
  'hooks',
  'info',
  'logs',
  'lost-found',
  'objects',
  'packed-refs',
  'refs',
  'remotes',
  'rr-cache',
  'shallow',
  'svn',
  'worktrees',
])
const PER_WORKTREE_PATHS = [
  'config.worktree',
  'info/sparse-checkout',
  'logs/HEAD',
  'logs/refs/bisect',
  'logs/refs/rewritten',
  'logs/refs/worktree',
  'refs/bisect',
  'refs/rewritten',
  'refs/worktree',
]
// Real rev-parse options this build does not have; printing one back would read
// as though the option had done its work.
const UNBUILT_REV_PARSE_OPTIONS = new Set([
  '--after',
  '--before',
  '--disambiguate',
  '--exclude-hidden',
  '--flags',
  '--keep-dashdash',
  '--local-env-vars',
  '--no-flags',
  '--no-revs',
  '--parseopt',
  '--prefix',
  '--resolve-git-dir',
  '--revs-only',
  '--shared-index-path',
  '--show-superproject-working-tree',
  '--since',
  '--sq',
  '--sq-quote',
  '--stop-at-non-option',
  '--stuck-long',
  '--until',
])
const GET_URL = new CommandSpec({
  arguments: [
    new Argument('--push', {
      action: 'store_true',
      help: 'query push URLs rather than fetch URLs',
    }),
    new Argument('--all', { action: 'store_true', help: 'return all URLs' }),
    new Argument('--no-push', { action: 'store_true' }),
    new Argument('--no-all', { action: 'store_true' }),
    new Argument('name'),
    new Argument('texts', { metavar: '', nargs: '*' }),
  ],
})

export async function remote(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const [word] = texts
  if (word === 'get-url') return await remoteGetUrl(texts, ctx)
  checkOperands(ctx, texts)
  if (word !== undefined) throw new UnknownSubcommandError(word, verbUsage(ctx))
  const repo = await opened(ctx, fl)
  const rows = (await git.listRemotes(repoArgs(repo))).sort((a, b) =>
    compareCodePoints(a.remote, b.remote),
  )
  const cfg = await configLines(
    new TextDecoder().decode(await readFile(repo.vfs, repo.location.commondir.join('config'))),
  )
  const lines: string[] = []
  for (const row of rows) {
    if (!fl.asBool('verbose')) lines.push(row.remote)
    else {
      const [urls, push] = remoteUrls(cfg, row.remote)
      if (urls[0]) lines.push(`${row.remote}\t${urls[0]} (fetch)`)
      for (const url of push.length ? push : urls) lines.push(`${row.remote}\t${url} (push)`)
    }
  }
  return [ENC.encode(lines.length ? `${lines.join('\n')}\n` : ''), new IOResult()]
}

/** Apply the longest matching URL prefix once, as Git does. */
export function rewriteUrl(url: string, rules: readonly [string, string][]): string {
  let matched: [string, string] | undefined
  for (const rule of rules) {
    if (url.startsWith(rule[0]) && (matched === undefined || rule[0].length > matched[0].length))
      matched = rule
  }
  return matched === undefined ? url : matched[1] + url.slice(matched[0].length)
}

/** Each `insteadOf` and `pushInsteadOf` prefix with its base. */
export function urlRules(cfg: readonly ConfigLine[]): [[string, string][], [string, string][]] {
  const rules: [string, string][] = [],
    pushRules: [string, string][] = []
  for (const line of cfg) {
    if (!line.path.startsWith('url.')) continue
    const end = line.path.lastIndexOf('.')
    const base = line.path.slice(4, end),
      key = line.path.slice(end + 1)
    if (key === 'insteadof') rules.push([line.value ?? '', base])
    if (key === 'pushinsteadof') pushRules.push([line.value ?? '', base])
  }
  return [rules, pushRules]
}

/** Fetch and push URLs, with Git's longest-prefix config rewrites. */
export function remoteUrls(cfg: readonly ConfigLine[], name: string): [string[], string[]] {
  let urls = cfg
    .filter((line) => line.path === `remote.${name}.url`)
    .map((line) => line.value ?? '')
  let push = cfg
    .filter((line) => line.path === `remote.${name}.pushurl`)
    .map((line) => line.value ?? '')
  if (!urls.length && push.length) urls = [name]
  const [rules, pushRules] = urlRules(cfg)
  const fetch = urls.map((url) => rewriteUrl(url, rules))
  if (push.length) push = push.map((url) => rewriteUrl(url, rules))
  else {
    push = urls
      .filter((url) => pushRules.some(([prefix]) => url.startsWith(prefix)))
      .map((url) => rewriteUrl(url, pushRules))
    if (!push.length) push = fetch
  }
  return [fetch, push]
}

/** Read the get-url remainder through the shared option parser. */
export async function remoteGetUrl(texts: string[], ctx: Context): Promise<CommandFnResult> {
  const parsed = parseCommand(
    GET_URL,
    [...texts.slice(1)],
    ctx.cwd.virtual,
    '',
    undefined,
    false,
    GIT_LONG_OPTIONS.get('remote get-url'),
  )
  if (parsed.optionErrorKinds.length > 0) {
    const [stderr, exitCode, stdout] = leafRefusal(
      UsageStyle.GIT,
      new Uint8Array(),
      parsed,
      'remote get-url',
      GET_URL,
    )
    return [stdout, new IOResult({ exitCode, stderr })]
  }
  const names = parsed.args.map(([word]) => word)
  const bad = offending(names, escaped(ctx.argv ?? []), new Set())
  if (bad !== null) throw new UsageError(...gitOptionRefusal(bad, 'remote get-url', GET_URL))
  const [name] = names
  if (names.length !== 1 || name === undefined)
    throw new UsageError('', gitUsage('remote get-url', GET_URL))
  const fl = new FlagView(parseToKwargs(parsed), GET_URL)
  const repo = await opened(ctx, new FlagView(ctx.flags))
  const cfg = await configLines(
    new TextDecoder().decode(await readFile(repo.vfs, repo.location.commondir.join('config'))),
  )
  const [urls, push] = remoteUrls(cfg, name)
  if (!urls.length)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: ENC.encode(`error: No such remote '${name}'\n`) }),
    ]
  let selected = fl.typedOrder('push', 'no_push').at(-1) === 'push' ? push : urls
  if (fl.typedOrder('all', 'no_all').at(-1) !== 'all') selected = selected.slice(0, 1)
  return [ENC.encode(selected.map((url) => `${url}\n`).join('')), new IOResult()]
}

/**
 * The per-user config files `--global` reads, in git's order.
 *
 * `$GIT_CONFIG_GLOBAL` alone when set, else the XDG file then `~/.gitconfig`,
 * each read through the dispatcher from the session's own `HOME` so the answer
 * is the workspace's and never the host's. Only `--list` refuses when neither
 * exists.
 */
async function mergeBaseCommits(repo: Repo, revisions: readonly string[]): Promise<CommitFacts[]> {
  const commits = []
  for (const revision of revisions) {
    try {
      commits.push(await commitFacts(repo, await resolveCommit(repo, revision)))
    } catch (err) {
      if (!(err instanceof AmbiguousArgumentError)) throw err
      throw new GitError(`Not a valid object name ${revision}`)
    }
  }
  return commits
}

async function mergeBaseIds(repo: Repo, revisions: readonly string[]): Promise<[string, string[]]> {
  const [one, other, ...rest] = await mergeBaseCommits(repo, revisions)
  if (one === undefined || other === undefined) throw new GitError('expected two commits')
  return [one.oid, (await mergeBases(repo, one, other, rest)).map((c) => c.oid)]
}

/** The best common ancestors of every commit named. */
async function octopus(repo: Repo, revisions: readonly string[]): Promise<string[]> {
  const commits = await mergeBaseCommits(repo, revisions)
  let found = commits.slice(0, 1)
  for (const other of commits.slice(1)) {
    const seen = new Map<string, CommitFacts>()
    for (const commit of found)
      for (const base of await mergeBases(repo, commit, other, []))
        if (!seen.has(base.oid)) seen.set(base.oid, base)
    found = [...seen.values()]
  }
  return found.map((commit) => commit.oid)
}

/** The commits no other named commit reaches, newest first. */
async function independent(repo: Repo, revisions: readonly string[]): Promise<string[]> {
  const named = new Map((await mergeBaseCommits(repo, revisions)).map((c) => [c.oid, c]))
  const kept: CommitFacts[] = []
  for (const commit of named.values()) {
    let reached = false
    for (const other of named.values()) {
      if (other.oid === commit.oid) continue
      if ((await mergeBases(repo, commit, other, [])).some((b) => b.oid === commit.oid))
        reached = true
    }
    if (!reached) kept.push(commit)
  }
  kept.sort((a, b) => b.committerTime - a.committerTime)
  return kept.map((commit) => commit.oid)
}

function validRefname(name: string, onelevel: boolean, pattern: boolean): boolean {
  if (name === '@' || (!onelevel && !name.includes('/'))) return false
  const once = pattern && name.split('*').length === 2
  return validRefName(once ? name.replaceAll('*', 'x') : name)
}

function normalized(name: string): string {
  const parts = name.split('/').filter(Boolean)
  return parts.join('/') + (name.endsWith('/') && parts.length > 0 ? '/' : '')
}

/** `git check-ref-format`: answer whether a name is a well-formed ref, by exit status. */
export async function checkRefFormat(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const argv = ctx.argv ?? []
  const words = argv.slice(argv.indexOf('check-ref-format') + 1)
  const usage = new UsageError('', verbUsage(ctx))
  if (words[0] === '--branch') {
    const name = words[1]
    if (words.length !== 2 || name === undefined) throw usage
    return checkBranch(ctx, fl, name)
  }
  let normalize = false
  let onelevel = false
  let pattern = false
  const names: string[] = []
  for (const word of words) {
    if (word === '--normalize' || word === '--print') normalize = true
    else if (word === '--allow-onelevel') onelevel = true
    else if (word === '--no-allow-onelevel') onelevel = false
    else if (word === '--refspec-pattern') pattern = true
    else if (word.startsWith('-')) throw usage
    else names.push(word)
  }
  const typed = names[0]
  if (names.length !== 1 || typed === undefined) throw usage
  const name = normalize ? normalized(typed) : typed
  if (!validRefname(name, onelevel, pattern)) return [null, new IOResult({ exitCode: 1 })]
  return [normalize ? ENC.encode(`${name}\n`) : null, new IOResult()]
}

/** `check-ref-format --branch`: print the branch name a word gives. */
async function checkBranch(ctx: Context, fl: FlagView, name: string): Promise<CommandFnResult> {
  let resolved = name
  if (name.startsWith(SELECTOR_OPEN)) {
    try {
      const repo = await opened(ctx, fl)
      resolved = await expandSelector(repo, name, name)
    } catch (err) {
      if (err instanceof GitError) throw new GitError(`'${name}' is not a valid branch name`)
      throw err
    }
  }
  if (!validBranchName(resolved)) throw new GitError(`'${name}' is not a valid branch name`)
  return [ENC.encode(`${resolved}\n`), new IOResult()]
}

export async function mergeBase(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  checkSwitches(ctx, texts)
  const repo = await opened(ctx, fl)
  const ancestor = fl.asBool('is_ancestor')
  const all = fl.asBool('all')
  const wantsOctopus = fl.asBool('octopus')
  const wantsIndependent = fl.asBool('independent')
  if (wantsOctopus && wantsIndependent)
    throw new ConfigUsageError("options '--independent' and '--octopus' cannot be used together")
  if (wantsOctopus || wantsIndependent) {
    if (texts.length === 0) return [null, new IOResult({ exitCode: 1 })]
    const found = await (wantsOctopus ? octopus : independent)(repo, texts)
    const shown = wantsIndependent || all ? found : found.slice(0, 1)
    return [
      ENC.encode(shown.map((oid) => `${oid}\n`).join('')),
      new IOResult({ exitCode: found.length ? 0 : 1 }),
    ]
  }
  if (ancestor && all)
    throw new GitError("options '--is-ancestor' and '--all' cannot be used together")
  if (ancestor && texts.length !== 2) throw new GitError('--is-ancestor takes exactly two commits')
  if (texts.length < 2) throw new UsageError('', verbUsage(ctx))
  const [one, bases] = await mergeBaseIds(repo, texts)
  if (ancestor)
    return [
      null,
      new IOResult({
        exitCode: bases.includes(one) ? 0 : 1,
      }),
    ]
  return [
    ENC.encode((all ? bases : bases.slice(0, 1)).map((oid) => `${oid}\n`).join('')),
    new IOResult({ exitCode: bases.length ? 0 : 1 }),
  ]
}

/** What an annotated tag finally points at, null for anything else. */
async function peeled(repo: Repo, oid: string): Promise<string | null> {
  let current = oid
  while ((await objectType(repo, current)) === 'tag') {
    const { tag } = await git.readTag({ ...repoArgs(repo), oid: current })
    current = tag.object
  }
  return current === oid ? null : current
}

/** Every row the named refs print. */
async function showRefLines(
  repo: Repo,
  table: ReadonlyMap<string, string>,
  names: readonly string[],
  fl: FlagView,
): Promise<string[]> {
  const digits = fl.raw('hash')
  const onlyId = digits !== undefined
  const wanted = typeof digits === 'string' ? digits : fl.raw('abbrev')
  const width = wanted === undefined ? null : abbrevWidth(wanted, repo.abbrev)
  const rows: [string, string][] = []
  for (const name of names) {
    const [oid] = resolveRef(table, name)
    if (oid === null) continue
    rows.push([oid, name])
    if (fl.asBool('dereference')) {
      const target = await peeled(repo, oid)
      if (target !== null) rows.push([target, `${name}^{}`])
    }
  }
  const lengths =
    width === null
      ? new Map<string, number>()
      : await uniqueAbbreviations(repo, new Map(rows.map(([oid]) => [oid, width])))
  return rows.map(([oid, name]) => {
    const shown = oid.slice(0, lengths.get(oid) ?? oid.length)
    return onlyId ? `${shown}\n` : `${shown} ${name}\n`
  })
}

/** List references, or test named ones with `--verify` and `--exists`. */
export async function showRef(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  checkSwitches(ctx, texts)
  const repo = await opened(ctx, fl)
  const table = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
  if (fl.asBool('exists')) {
    const [only] = texts
    if (only === undefined) throw new GitError('--exists requires a reference')
    if (texts.length > 1) throw new GitError('--exists requires exactly one reference')
    if (resolveRef(table, only)[0] === null)
      return [
        null,
        new IOResult({ exitCode: 2, stderr: ENC.encode('error: reference does not exist\n') }),
      ]
    return [null, new IOResult()]
  }
  const quiet = fl.asBool('quiet')
  const names: string[] = []
  if (fl.asBool('verify')) {
    for (const name of texts) {
      const valid =
        (name === HEAD || name.startsWith('refs/')) && resolveRef(table, name)[0] !== null
      if (!valid) {
        if (quiet) return [null, new IOResult({ exitCode: 1 })]
        throw new GitError(`'${name}' - not a valid ref`)
      }
      names.push(name)
    }
  } else {
    const heads = fl.asBool('heads') || fl.asBool('branches')
    const tags = fl.asBool('tags')
    if (fl.asBool('head') && resolveRef(table, HEAD)[0] !== null) names.push(HEAD)
    for (const ref of [...table.keys()].sort(compareCodePoints)) {
      if (!ref.startsWith('refs/')) continue
      if (
        (heads || tags) &&
        !((heads && ref.startsWith('refs/heads/')) || (tags && ref.startsWith('refs/tags/')))
      )
        continue
      if (texts.length && !texts.some((pattern) => ref === pattern || ref.endsWith(`/${pattern}`)))
        continue
      // A ref that resolves to nothing (a dangling symbolic ref) is skipped
      // silently, as git's ref iteration skips it. Pinned against git 2.47.3.
      if (resolveRef(table, ref)[0] !== null) names.push(ref)
    }
  }
  if (quiet) return [null, new IOResult({ exitCode: names.length ? 0 : 1 })]
  const lines = await showRefLines(repo, table, names, fl)
  return [ENC.encode(lines.join('')), new IOResult({ exitCode: names.length ? 0 : 1 })]
}

export async function revList(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  if (optionOperand(ctx, texts, loneHelp(ctx, texts)) !== null) {
    throw new UsageError('', verbUsage(ctx))
  }
  const repo = await opened(ctx, fl)
  const parsed = parseFlags(fl, null, ctx.signal)
  const [revisions, pathspecs, dashed] = await walkOperands(ctx, fl, repo, texts)
  // A line naming only paths has no revision either (git 2.47.3).
  if (!revisions.length && !parsed.allRefs) throw new UsageError('', verbUsage(ctx))
  const flags = { ...parsed, pathspecs }
  const [shown, hidden] = await walkEnds(repo, revisions, dashed)
  const starts = flags.allRefs ? [...(await refCommits(repo)), ...shown] : shown
  const walk = await walked(repo, starts, flags, hidden)
  const commits = inPrintOrder(walk, flags)
  // A `--boundary` commit's line starts with `-` (git 2.47.3).
  const boundary = new Set(walk.boundary.map((commit) => commit.oid))
  const out = fl.asBool('count')
    ? `${String(commits.length)}\n`
    : commits.map((c) => `${boundary.has(c.oid) ? '-' : ''}${c.oid}\n`).join('')
  return [ENC.encode(out), new IOResult()]
}

export function version(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  _texts: string[],
  _ctx: Context,
): CommandFnResult {
  return [ENC.encode(`git version ${VERSION} (Mirage)\n`), new IOResult()]
}

/** Where a `rev-parse` line runs. */
interface RevParsePlace {
  readonly location: RepoLocation
  readonly start: string
  readonly top: string
  readonly bare: boolean
  readonly inGitDir: boolean
  readonly inWorkTree: boolean
  readonly prefix: string
}

/** What a `rev-parse` line has printed and the modes it is in. */
interface RevParseOutput {
  readonly repo: Repo
  readonly place: RevParsePlace
  readonly table: ReadonlyMap<string, string>
  readonly refs: ReadonlyMap<string, string>
  readonly warn: boolean
  strict: boolean
  quiet: boolean
  verify: boolean
  symbolic: string
  negated: boolean
  width: number | null
  pathFormat: string | null
  fallback: string | null
  excludes: string[]
  filesOnly: boolean
  shown: boolean
  readonly rows: string[]
  readonly counted: string[]
  readonly errors: string[]
  refused: GitError | null
}

/**
 * `--abbrev-ref`: the ref a revision names, shortened as git shortens it, and
 * the error git prints in its place.
 *
 * The name is found by git's rev-parse rules and followed through symbolic
 * refs, so HEAD reads as its branch and `origin/HEAD` as what it points at;
 * then the shortest unambiguous spelling is kept, by every other rule under
 * `strict` and by the earlier ones otherwise. A name two refs answer to prints
 * nothing and an error instead, while `core.warnAmbiguousRefs` is on; a
 * revision that names no ref prints nothing. Pinned against git 2.47.3.
 *
 * @param vfs the session's files
 * @param gitdir this checkout's git directory
 * @param table every ref, as loadRefs reads them
 * @param revision the revision as typed
 * @param strict `=strict`, or `core.warnAmbiguousRefs` when no mode is given
 * @param warn `core.warnAmbiguousRefs`
 * @param full keep the whole name, for `--symbolic-full-name`
 */
async function abbreviated(
  vfs: Files,
  gitdir: PathSpec,
  table: ReadonlyMap<string, string>,
  revision: string,
  strict: boolean,
  warn: boolean,
  full = false,
): Promise<[string, string]> {
  const named = refsNamed(table, revision)
  if (warn && named.length > 1) return ['', `error: refname '${revision}' is ambiguous\n`]
  const [name] = named
  if (name === undefined) return ['', '']
  const found = await resolveSymbolic(vfs, gitdir, table, name, true)
  if (found === null) return ['', '']
  return [`${full ? found.name : shortenRef(found.name, new Set(table.keys()), strict)}\n`, '']
}

/**
 * How strictly `--abbrev-ref` shortens: `strict` against every other rule,
 * `loose` against the earlier ones, and with no mode as
 * `core.warnAmbiguousRefs` says.
 *
 * @param mode the option's value, true when it has none
 * @param warn `core.warnAmbiguousRefs`
 * @throws AbbrevModeError any other mode
 */
function abbrevStrict(mode: FlagValue, warn: boolean): boolean {
  if (mode === 'strict') return true
  if (mode === 'loose') return false
  if (typeof mode === 'string') throw new AbbrevModeError(mode)
  return warn
}

/**
 * The way from one directory to a path; a directory at or above the start ends
 * in a slash, as `--path-format=relative` prints it.
 */
function relative(target: string, start: string): string {
  const to = target.split('/').filter(Boolean)
  const at = start.split('/').filter(Boolean)
  let shared = 0
  while (shared < Math.min(to.length, at.length) && to[shared] === at[shared]) shared += 1
  const ups = '../'.repeat(at.length - shared)
  const rest = to.slice(shared).join('/')
  return rest !== '' ? ups + rest : ups === '' ? './' : ups
}

/** Which git directory holds a path: a linked worktree shares most of them. */
function gitPathBase(location: RepoLocation, path: string): PathSpec {
  const top = path.split('/', 1)[0] ?? ''
  const isPrivate = PER_WORKTREE_PATHS.some((name) => path === name || path.startsWith(`${name}/`))
  return SHARED_PATHS.has(top) && !isPrivate ? location.commondir : location.gitdir
}

async function placeOf(repo: Repo, start: string): Promise<RevParsePlace> {
  const location: RepoLocation = repo.location
  const inGit = inGitDir(start, location)
  const bare = await isBare(repo.vfs, location)
  const top = location.worktree.virtual === '/' ? '/' : `${location.worktree.virtual}/`
  const inWorkTree =
    !inGit && !bare && (start === location.worktree.virtual || start.startsWith(top))
  const prefix =
    inWorkTree && start !== location.worktree.virtual ? `${start.slice(top.length)}/` : ''
  return { location, start, top, bare, inGitDir: inGit, inWorkTree, prefix }
}

/**
 * How a git directory path reads by default: bare at the directory itself,
 * through `.git` from inside the work tree, absolute otherwise.
 */
function beside(place: RevParsePlace, base: string, tail = ''): string {
  if (place.start === base) return tail === '' ? '.' : tail
  if (place.inWorkTree && base === `${place.top}.git`) {
    const ups = '../'.repeat(place.prefix.split('/').length - 1)
    return tail === '' ? `${ups}.git` : `${ups}.git/${tail}`
  }
  return tail === '' ? base : `${base}/${tail}`
}

function formatted(
  place: RevParsePlace,
  form: string | null,
  fallback: string,
  path: string,
): string {
  if (form === PATH_ABSOLUTE) return path
  if (form === PATH_RELATIVE) return relative(path, place.start)
  return fallback
}

/**
 * The line a word that reports where git runs prints, null for any other word.
 * `--show-cdup` prints nothing where no work tree holds the line, and the work
 * tree's own path from outside it.
 */
async function placeAnswer(
  repo: Repo,
  place: RevParsePlace,
  word: string,
  form: string | null,
): Promise<string | null> {
  const location = place.location
  const gitdir = location.gitdir.virtual
  const common = location.commondir.virtual
  switch (word) {
    case SHOW_TOPLEVEL:
      return `${formatted(place, form, location.worktree.virtual, location.worktree.virtual)}\n`
    case '--git-dir': {
      const first = place.start === location.worktree.virtual || place.start === gitdir
      return `${formatted(place, form, first ? beside(place, gitdir) : gitdir, gitdir)}\n`
    }
    case '--git-common-dir':
      return `${formatted(place, form, beside(place, common), common)}\n`
    case '--absolute-git-dir':
      return `${gitdir}\n`
    case '--show-prefix':
      return `${place.prefix}\n`
    case '--show-cdup':
      if (place.inGitDir || place.bare) return ''
      if (!place.inWorkTree) return `${location.worktree.virtual}\n`
      return `${'../'.repeat(place.prefix.split('/').length - 1)}\n`
    case '--is-inside-work-tree':
      return `${String(place.inWorkTree)}\n`
    case '--is-inside-git-dir':
      return `${String(place.inGitDir)}\n`
    case '--is-bare-repository':
      return `${String(place.bare)}\n`
    case '--is-shallow-repository': {
      const shallow = await readOptional(repo.vfs, location.commondir.join('shallow'))
      return `${String(shallow !== null)}\n`
    }
    case '--show-ref-format':
      return 'files\n'
    default:
      return null
  }
}

function impliedGlob(full: string, value: string): string {
  if (GLOB_CHARS.some((char) => value.includes(char))) return full
  return full.endsWith('/') ? `${full}*` : `${full}/*`
}

/**
 * The refs a word that lists them selects, each as its spelling and id, null
 * for any other word. A pattern with no glob character means everything under
 * it, and `--exclude` reads the names the listing itself reads: short under a
 * namespace, whole under `--all`.
 */
function refSet(
  table: ReadonlyMap<string, string>,
  word: string,
  excludes: readonly string[],
): [string, string][] | null {
  const equals = word.indexOf('=')
  const name = equals === -1 ? word : word.slice(0, equals)
  const value = equals === -1 ? '' : word.slice(equals + 1)
  const namespace = REF_NAMESPACES.get(name)
  let prefix: string
  let pattern: string
  if (word === ALL_REFS) {
    prefix = ''
    pattern = 'refs/*'
  } else if (namespace !== undefined) {
    prefix = namespace
    pattern = equals === -1 ? `${namespace}*` : impliedGlob(namespace + value, value)
  } else if (name === GLOB_OPTION && equals !== -1) {
    prefix = ''
    pattern = impliedGlob(value.startsWith('refs/') ? value : `refs/${value}`, value)
  } else {
    return null
  }
  const chosen: [string, string][] = []
  for (const ref of [...table.keys()].sort(compareCodePoints)) {
    if (!fnmatch(ref, pattern)) continue
    const spelled = ref.slice(prefix.length)
    if (!excludes.some((pat) => fnmatch(spelled, pat))) chosen.push([spelled, table.get(ref) ?? ''])
  }
  return chosen
}

async function namedLine(
  out: RevParseOutput,
  spelled: string,
  sign: string,
): Promise<[string, string]> {
  const name = await expandSelector(out.repo, spelled, spelled)
  const [line, error] = await abbreviated(
    out.repo.vfs,
    out.repo.location.gitdir,
    out.table,
    name,
    out.strict,
    out.warn,
    out.symbolic === SYMBOLIC_FULL,
  )
  return [line === '' ? '' : sign + line, error]
}

/** Print one revision in the mode the line is in at this word. */
async function show(
  out: RevParseOutput,
  spelled: string | null,
  oid: string,
  hidden: boolean,
): Promise<string> {
  out.shown = true
  const sign = hidden !== out.negated ? '^' : ''
  if (spelled !== null && out.symbolic === SYMBOLIC_AS_TYPED) return `${sign}${spelled}\n`
  if (spelled !== null && out.symbolic !== '') {
    const [line, error] = await namedLine(out, spelled, sign)
    if (error !== '') {
      if (out.quiet || out.repo.ambiguous === null) out.errors.push(error)
      else out.repo.ambiguous.push(error)
    }
    return line
  }
  if (out.width === null) return `${sign}${oid}\n`
  const unique = await uniqueAbbreviations(out.repo, new Map([[oid, out.width]]))
  return `${sign}${oid.slice(0, unique.get(oid) ?? out.width)}\n`
}

/** Split `A^@`, `A^!`, `A^-` or `A^-n` at its caret, null for anything else. */
function parentSuffix(word: string): [string, string] | null {
  const at = word.lastIndexOf(PARENT_SUFFIX)
  if (at <= 0) return null
  const tail = word.slice(at + 1)
  const numbered =
    tail.startsWith('-') && /^[0-9]+$/.test(tail.slice(1)) && Number(tail.slice(1)) > 0
  return tail === '@' || tail === '!' || tail === '-' || numbered ? [word.slice(0, at), tail] : null
}

type RevRow = [string | null, string, boolean]

async function parentRows(repo: Repo, word: string, base: string, tail: string): Promise<RevRow[]> {
  let oid: string
  try {
    oid = await resolveCommit(repo, base)
  } catch (err) {
    if (err instanceof AmbiguousArgumentError) throw new AmbiguousArgumentError(word)
    throw err
  }
  const numbered = (await commitFacts(repo, oid)).parents.map((parent, at): [string, string] => [
    `${base}^${String(at + 1)}`,
    parent,
  ])
  if (tail === '@') return numbered.map(([name, id]) => [name, id, false])
  const head: RevRow = [base, oid, false]
  if (tail === '!') return [head, ...numbered.map(([name, id]): RevRow => [name, id, true])]
  const index = tail.length > 1 ? Number(tail.slice(1)) : 1
  const parent = numbered[index - 1]
  if (parent === undefined) throw new AmbiguousArgumentError(word)
  return [head, [parent[0], parent[1], true]]
}

/** What a range, a negation or a parent shorthand expands to, null otherwise. */
async function revisionRows(repo: Repo, word: string): Promise<RevRow[] | null> {
  const ends = word === RANGE ? null : rangeEnds(word)
  if (ends !== null) {
    const [left, right, symmetric] = ends
    let oldId: string, newId: string
    try {
      oldId = await resolveCommit(repo, left)
      newId = await resolveCommit(repo, right)
    } catch (err) {
      if (err instanceof AmbiguousArgumentError) throw new AmbiguousArgumentError(word)
      throw err
    }
    const rows: RevRow[] = [[right, newId, false]]
    if (!symmetric) return [...rows, [left, oldId, true]]
    rows.push([left, oldId, false])
    const bases = await mergeBases(
      repo,
      await commitFacts(repo, oldId),
      await commitFacts(repo, newId),
    )
    return [...rows, ...bases.map((base): RevRow => [null, base.oid, true])]
  }
  const parent = parentSuffix(word)
  if (parent !== null) return parentRows(repo, word, parent[0], parent[1])
  if (word.startsWith(NEGATION) && word.length > NEGATION.length) {
    const name = word.slice(NEGATION.length)
    try {
      return [[name, (await resolveObject(repo, name)).oid, true]]
    } catch (err) {
      if (err instanceof AmbiguousArgumentError) throw new AmbiguousArgumentError(word)
      throw err
    }
  }
  return null
}

/**
 * Print a revision word, false when it names none. Under `--verify` a single
 * revision waits for the end of the line, while what expands to several prints
 * where it stands.
 */
async function showRevision(out: RevParseOutput, word: string): Promise<boolean> {
  let rows: RevRow[] | null
  try {
    rows = await revisionRows(out.repo, word)
    if (rows === null) {
      const found = await resolveObject(out.repo, word)
      const line = await show(out, word, found.oid, false)
      if (out.verify) out.counted.push(line)
      else out.rows.push(line)
      return true
    }
  } catch (err) {
    if (err instanceof SelectorError || !(err instanceof GitError)) throw err
    out.refused = err
    return false
  }
  const expanded: string[] = []
  for (const [spelled, oid, hidden] of rows) expanded.push(await show(out, spelled, oid, hidden))
  if (out.verify && rows.length === 1 && word.startsWith(NEGATION)) out.counted.push(...expanded)
  else out.rows.push(...expanded)
  return true
}

/** Act on one word of a rev-parse line; returns what stops the line, if anything. */
async function existsFrom(out: RevParseOutput, word: string): Promise<boolean> {
  return exists(out.repo.vfs, PathSpec.fromStrPath(absoluteOperand(out.place.start, word)))
}

function refIds(table: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const refs = new Map<string, string>()
  for (const name of table.keys()) {
    if (!name.startsWith('refs/')) continue
    const [oid] = resolveRef(table, name)
    if (oid !== null) refs.set(name, oid)
  }
  return refs
}

async function revParseWord(
  out: RevParseOutput,
  word: string,
  words: Iterator<string>,
): Promise<GitError | null> {
  const equals = word.indexOf('=')
  const name = equals === -1 ? word : word.slice(0, equals)
  const hasValue = equals !== -1
  const value = hasValue ? word.slice(equals + 1) : ''
  if (word === '--verify') out.verify = true
  else if (word === '-q' || word === '--quiet') out.quiet = true
  else if (name === '--short') {
    out.verify = true
    out.width = abbrevWidth(hasValue ? value : true, out.repo.abbrev)
  } else if (word === '--symbolic' || word === '--symbolic-full-name') {
    if (out.symbolic !== SYMBOLIC_ABBREVIATED)
      out.symbolic = word === '--symbolic' ? SYMBOLIC_AS_TYPED : SYMBOLIC_FULL
  } else if (name === '--abbrev-ref') {
    out.symbolic = SYMBOLIC_ABBREVIATED
    out.strict = abbrevStrict(hasValue ? value : true, out.warn)
  } else if (word === '--not') out.negated = !out.negated
  else if (name === EXCLUDE_OPTION && hasValue) out.excludes.push(value)
  else if (name === '--path-format') {
    if (!hasValue) throw new GitError('--path-format requires an argument')
    if (value !== PATH_ABSOLUTE && value !== PATH_RELATIVE)
      throw new GitError(`unknown argument to --path-format: ${value}`)
    out.pathFormat = value
  } else if (word === '--git-path' || word === '--default') {
    const following = words.next()
    if (following.done === true) throw new GitError(`${word} requires an argument`)
    if (word === '--default') out.fallback = following.value
    else {
      const base = gitPathBase(out.place.location, following.value).virtual
      const path = `${base}/${following.value}`
      const shown = formatted(
        out.place,
        out.pathFormat,
        beside(out.place, base, following.value),
        path,
      )
      out.rows.push(`${shown}\n`)
    }
  } else if (name === '--show-object-format') {
    if (hasValue && !OBJECT_FORMAT_MODES.includes(value))
      throw new GitError(`unknown mode for --show-object-format: ${value}`)
    out.rows.push('sha1\n')
  } else return revParseOperand(out, word, name)
  return null
}

/** A word that is a report, a ref listing, a stray option, a revision or a file. */
async function revParseOperand(
  out: RevParseOutput,
  word: string,
  name: string,
): Promise<GitError | null> {
  const answer = await placeAnswer(out.repo, out.place, word, out.pathFormat)
  if (answer !== null) {
    out.rows.push(answer)
    return null
  }
  const chosen = refSet(out.refs, word, out.excludes)
  if (chosen !== null) {
    out.excludes = []
    for (const [spelled, oid] of chosen) out.rows.push(await show(out, spelled, oid, false))
    return null
  }
  if (UNBUILT_REV_PARSE_OPTIONS.has(name)) throw new UnrecognizedArgumentError(word)
  if (word.startsWith('-')) {
    if (!out.verify) out.rows.push(`${word}\n`)
    return null
  }
  if (!out.filesOnly && (await showRevision(out, word))) return null
  if (out.verify) throw new SingleRevisionError()
  if (word !== '' && (await existsFrom(out, word))) {
    out.filesOnly = true
    out.rows.push(`${word}\n`)
    return null
  }
  out.rows.push(`${word}\n`)
  return out.filesOnly ? new NoSuchPathError(word) : out.refused
}

/** After `--` the rest prints as it stands, unless `--verify` is on. */
async function revParseWords(
  out: RevParseOutput,
  words: Iterator<string>,
): Promise<GitError | null> {
  for (let item = words.next(); item.done !== true; item = words.next()) {
    if (item.value === MARKER) {
      if (out.verify) return null
      out.rows.push(`${MARKER}\n`)
      for (let rest = words.next(); rest.done !== true; rest = words.next())
        out.rows.push(`${rest.value}\n`)
      return null
    }
    const stopped = await revParseWord(out, item.value, words)
    if (stopped !== null) return stopped
  }
  return null
}

/**
 * `git rev-parse`: answer each word of the line in the order it is written. A
 * mode set by one word applies to the words after it, and a dashed word that
 * means nothing here is printed back. With `--verify` (or `--short`, which
 * implies it) there must be exactly one revision, printed after everything
 * else, and `-q` turns the refusal into a bare exit 1.
 */
export async function revParse(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  let out: RevParseOutput | undefined
  const done = (): Uint8Array | null =>
    out === undefined || out.rows.length === 0 ? null : ENC.encode(out.rows.join(''))
  try {
    optionOperand(ctx, texts, loneHelp(ctx, texts))
    const argv = ctx.argv ?? []
    const verb = argv.indexOf('rev-parse')
    const line = argv.slice(verb + 1)
    const end = line.indexOf(MARKER)
    const named = end === -1 ? line : line.slice(0, end)
    const mode = fl.raw('abbrev_ref')
    if (typeof mode === 'string') abbrevStrict(mode, true)
    const toplevel = named.includes(SHOW_TOPLEVEL)
    const repo = await opened(ctx, fl, toplevel)
    const start = startPoint(fl).virtual
    if (toplevel && inGitDir(start, repo.location)) throw new NotAWorkTreeError()
    const warn = await configBool(repo, 'core.warnAmbiguousRefs', true)
    const table = await loadRefs(repo.vfs, repo.location.gitdir, repo.location.commondir)
    out = {
      repo,
      place: await placeOf(repo, start),
      table,
      refs: refIds(table),
      warn,
      strict: warn,
      quiet: fl.asBool('quiet'),
      verify: false,
      symbolic: '',
      negated: false,
      width: null,
      pathFormat: null,
      fallback: null,
      excludes: [],
      filesOnly: false,
      shown: false,
      rows: [],
      counted: [],
      errors: [],
      refused: null,
    }
    const stopped = await revParseWords(out, line[Symbol.iterator]())
    if (stopped !== null) {
      const refused = fatal(stopped)
      if (refused !== null) return [ENC.encode(out.rows.join('')), refused[1]]
    }
    if (out.fallback !== null && !out.shown) await showRevision(out, out.fallback)
    if (out.verify) {
      if (out.counted.length !== 1) throw new SingleRevisionError()
      out.rows.push(...out.counted)
    }
    const stderr = out.errors.length > 0 ? ENC.encode(out.errors.join('')) : null
    return [ENC.encode(out.rows.join('')), new IOResult({ stderr })]
  } catch (err) {
    if (!(err instanceof GitError) || out === undefined) {
      if (err instanceof GitError) return fatal(err)
      throw err
    }
    if (out.quiet && (err instanceof SingleRevisionError || out.verify))
      return [done(), new IOResult({ exitCode: 1 })]
    const refused = fatal(err)
    return refused === null ? refused : [done(), refused[1]]
  } finally {
    if (out?.quiet === true) out.repo.ambiguous?.splice(0)
  }
}
