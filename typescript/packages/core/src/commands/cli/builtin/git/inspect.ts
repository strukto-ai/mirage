import { PathSpec } from '../../../../types.ts'
import { loadRefs, resolveSymbolic } from './refs.ts'
import { shortenRef } from './ref_fields.ts'
import git from 'isomorphic-git'
import { VERSION } from '../../../../version.ts'

import { compilePosixRegex } from '../../../../utils/posix.ts'
import { BreError, PosixSyntax, translateEre } from '../../../builtin/utils/bre.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { CommandSpec, Operand, Option, type FlagValue } from '../../../spec/types.ts'
import { parseCommand, parseToKwargs } from '../../../spec/parser.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  AbbrevModeError,
  GitError,
  NoWorkspaceError,
  NotAWorkTreeError,
  SingleRevisionError,
  UnknownSubcommandError,
  UsageError,
} from './errors.ts'
import { parseFlags, refCommits, select } from './history.ts'
import { uniqueAbbreviations } from './ref_list.ts'
import { configBool, repoArgs, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { configLines, type ConfigLine } from './fs.ts'
import { readFile, readOptional } from './io.ts'
import { refsNamed, splitRevisions, resolveObject } from './revparse.ts'
import {
  checkOperands,
  checkSwitches,
  escaped,
  fatal,
  optionOperand,
  offending,
  startPoint,
  STDERR,
  STDOUT,
  verbUsage,
} from './util.ts'
import { HELP_SWITCH, gitOptionRefusal, gitUsage } from '../../refusal.ts'
import { GIT_LONG_OPTIONS } from '../../constants.ts'
import { isBare } from './discover.ts'
import type { Dispatch, RepoLocation } from './types.ts'

const ENC = new TextEncoder()
const SHOW_TOPLEVEL = '--show-toplevel'
// git's own global spells `--git-dir` too, so rev-parse cannot declare it: it
// arrives as an operand, and is answered from there.
const GIT_DIR_OPTION = '--git-dir'
const MIN_ABBREV = 4
const HEX_LENGTH = 40
const GET_URL = new CommandSpec({
  options: [
    new Option({ long: '--push', description: 'query push URLs rather than fetch URLs' }),
    new Option({ long: '--all', description: 'return all URLs' }),
    new Option({ long: '--no-push' }),
    new Option({ long: '--no-all' }),
  ],
  positional: [new Operand({ type: 'str', name: 'name', required: true })],
  rest: new Operand({ type: 'str' }),
})

export async function remote(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    const [word] = inv.texts
    if (word === 'get-url') return await remoteGetUrl(inv)
    checkOperands(inv, inv.texts)
    if (word !== undefined) throw new UnknownSubcommandError(word, verbUsage(inv))
    const repo = await opened(fl, inv.doors ?? {})
    const rows = (await git.listRemotes(repoArgs(repo))).sort((a, b) =>
      compareCodePoints(a.remote, b.remote),
    )
    const cfg = await configLines(
      new TextDecoder().decode(
        await readFile(repo.dispatch, repo.location.commondir.join('config')),
      ),
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
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

/** Apply the longest matching URL prefix once, as Git does. */
function rewriteUrl(url: string, rules: readonly [string, string][]): string {
  let matched: [string, string] | undefined
  for (const rule of rules) {
    if (url.startsWith(rule[0]) && (matched === undefined || rule[0].length > matched[0].length))
      matched = rule
  }
  return matched === undefined ? url : matched[1] + url.slice(matched[0].length)
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
export async function remoteGetUrl(inv: CLIInvocation): Promise<CommandFnResult> {
  try {
    const parsed = parseCommand(
      GET_URL,
      [...inv.texts.slice(1)],
      inv.cwd.virtual,
      '',
      undefined,
      true,
      GIT_LONG_OPTIONS.get('remote get-url'),
    )
    const names = parsed.args.map(([word]) => word)
    const bad = offending(names, escaped(inv.argv), new Set())
    if (bad !== null) throw new UsageError(...gitOptionRefusal(bad, 'remote get-url', GET_URL))
    const [name] = names
    if (names.length !== 1 || name === undefined)
      throw new UsageError('', gitUsage('remote get-url', GET_URL))
    const fl = new FlagView(parseToKwargs(parsed), GET_URL)
    const repo = await opened(new FlagView(inv.flags), inv.doors ?? {})
    const cfg = await configLines(
      new TextDecoder().decode(
        await readFile(repo.dispatch, repo.location.commondir.join('config')),
      ),
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
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

/**
 * The per-user config files `--global` reads, in git's order.
 *
 * `$GIT_CONFIG_GLOBAL` alone when set, else the XDG file then `~/.gitconfig`,
 * each read through the dispatcher from the session's own `HOME` so the answer
 * is the workspace's and never the host's. Only `--list` refuses when neither
 * exists.
 */
export async function globalSources(
  inv: CLIInvocation,
  listing: boolean,
): Promise<{ source: string; data: Uint8Array }[]> {
  const dispatch = inv.doors?.dispatch
  if (!dispatch) throw new NoWorkspaceError()
  const home = inv.env.HOME ?? ''
  const override = inv.env.GIT_CONFIG_GLOBAL
  if (override === undefined && !home) throw new GitError('$HOME not set')
  const target = override ?? `${home}/.gitconfig`
  const configured = inv.env.XDG_CONFIG_HOME ?? ''
  const xdg = configured === '' ? `${home}/.config` : configured
  const sources: { source: string; data: Uint8Array }[] = []
  for (const source of override === undefined ? [`${xdg}/git/config`, target] : [target]) {
    const data = await readOptional(dispatch, PathSpec.fromStrPath(source, undefined, '/'))
    if (data !== null) sources.push({ source, data })
  }
  if (!sources.length && listing)
    throw new GitError(`unable to read config file '${target}': No such file or directory`)
  return sources
}

export async function config(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    let sources: { source: string; data: Uint8Array }[]
    if (fl.asBool('global')) sources = await globalSources(inv, fl.asBool('list'))
    else {
      const repo = await opened(fl, inv.doors ?? {})
      const path = repo.location.commondir.join(`config`)
      const ordinary =
        repo.location.commondir.virtual === repo.location.worktree.virtual + '/.git' &&
        startPoint(fl).virtual === repo.location.worktree.virtual
      sources = [
        {
          source: ordinary ? '.git/config' : path.rawPath,
          data: await readFile(repo.dispatch, path),
        },
      ]
    }
    const listing = fl.asBool('list'),
      regexp = fl.asBool('get_regexp'),
      origin = fl.asBool('show_origin')
    if (!listing && !inv.texts.length)
      return [
        null,
        new IOResult({ exitCode: 129, stderr: ENC.encode('error: wrong number of arguments\n') }),
      ]
    const key = inv.texts[0] ?? ''
    let pattern: RegExp | null
    try {
      pattern = regexp
        ? compilePosixRegex(translateEre(configKey(key), PosixSyntax.EXTENDED)[0])
        : null
    } catch (err) {
      if (!(err instanceof SyntaxError) && !(err instanceof BreError)) throw err
      return [
        null,
        new IOResult({ exitCode: 6, stderr: ENC.encode(`error: invalid key pattern: ${key}\n`) }),
      ]
    }
    const values: [string, string, string][] = []
    for (const { source, data } of sources) {
      for (const line of await configLines(new TextDecoder().decode(data))) {
        if (listing || (pattern ? pattern.test(line.path) : line.path === configKey(key)))
          values.push([source, line.path, line.value ?? ''])
      }
    }
    const chosen = listing || regexp ? values : values.slice(-1)
    const out = chosen
      .map(
        ([source, name, value]) =>
          (origin ? `file:${source}\t` : '') +
          (listing || regexp ? name + (listing ? '=' : ' ') : '') +
          value +
          '\n',
      )
      .join('')
    return [ENC.encode(out), new IOResult({ exitCode: chosen.length || listing ? 0 : 1 })]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

export async function showRef(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    checkSwitches(inv, inv.texts)
    const repo = await opened(fl, inv.doors ?? {})
    const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
    const lines: string[] = []
    for (const ref of [...refs.keys()]
      .filter((r) => r.startsWith('refs/'))
      .sort(compareCodePoints)) {
      if (
        inv.texts.length &&
        !inv.texts.some((pattern) => ref === pattern || ref.endsWith(`/${pattern}`))
      )
        continue
      const oid = await git.resolveRef({ ...repoArgs(repo), ref })
      lines.push(`${oid} ${ref}`)
    }
    return [
      ENC.encode(lines.length ? `${lines.join('\n')}\n` : ''),
      new IOResult({ exitCode: lines.length ? 0 : 1 }),
    ]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

export async function revList(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    const sole = inv.argv.slice(-2).join(' ') === `rev-list ${HELP_SWITCH}`
    if (optionOperand(inv, inv.texts, sole ? STDOUT : STDERR) !== null) {
      throw new UsageError('', verbUsage(inv))
    }
    const repo = await opened(fl, inv.doors ?? {})
    const flags = parseFlags(fl)
    if (!inv.texts.length && !flags.allRefs) throw new UsageError('', verbUsage(inv))
    const [shown, hidden] = await splitRevisions(repo, inv.texts)
    const starts = flags.allRefs ? [...(await refCommits(repo)), ...shown] : shown
    const commits = await select(repo, starts, flags, hidden)
    const out = fl.asBool('count')
      ? `${String(commits.length)}\n`
      : commits.map((c) => `${c.oid}\n`).join('')
    return [ENC.encode(out), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

export function version(_inv: CLIInvocation): CommandFnResult {
  return [ENC.encode(`git version ${VERSION} (Mirage)\n`), new IOResult()]
}

function configKey(key: string): string {
  const parts = key.split('.')
  return parts
    .map((part, i) => (i === 0 || i === parts.length - 1 ? part.toLowerCase() : part))
    .join('.')
}

/**
 * The answers rev-parse gives for the options that report where the line runs,
 * keyed by spelling. Pinned against git 2.47: `--git-dir` is `.git` at the top
 * of a work tree, `.` inside the git directory itself, and absolute elsewhere
 * (a subdirectory, a linked worktree); inside the git directory there is no
 * work tree, so `--show-prefix` is empty and `--show-toplevel` is refused.
 */
async function placeAnswers(repo: Repo, start: string): Promise<Map<string, string>> {
  const location: RepoLocation = repo.location
  const inGitDir =
    start === location.gitdir.virtual || start.startsWith(`${location.gitdir.virtual}/`)
  const top = location.worktree.virtual === '/' ? '/' : `${location.worktree.virtual}/`
  const inWorkTree =
    !inGitDir &&
    !(await isBare(repo.dispatch, location)) &&
    (start === location.worktree.virtual || start.startsWith(top))
  const prefix =
    inWorkTree && start !== location.worktree.virtual ? `${start.slice(top.length)}/` : ''
  const gitDir =
    start === location.gitdir.virtual
      ? '.'
      : start === location.worktree.virtual &&
          location.gitdir.virtual === location.worktree.join('.git').virtual
        ? '.git'
        : location.gitdir.virtual
  return new Map([
    [SHOW_TOPLEVEL, `${location.worktree.virtual}\n`],
    [GIT_DIR_OPTION, `${gitDir}\n`],
    ['--show-prefix', `${prefix}\n`],
    ['--is-inside-work-tree', `${String(inWorkTree)}\n`],
  ])
}

/**
 * How many hex digits `--short` keeps: the repository's own width bare, and
 * otherwise the number given, read as strtoul reads it, between git's four and
 * the whole id.
 */
function shortWidth(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback
  const digits = /^\s*\d+/.exec(value)
  const width = digits === null ? 0 : Number(digits[0])
  return Math.min(Math.max(width, MIN_ABBREV), HEX_LENGTH)
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
 * @param dispatch workspace op dispatcher
 * @param gitdir this checkout's git directory
 * @param table every ref, as loadRefs reads them
 * @param revision the revision as typed
 * @param strict `=strict`, or `core.warnAmbiguousRefs` when no mode is given
 * @param warn `core.warnAmbiguousRefs`
 */
async function abbreviated(
  dispatch: Dispatch,
  gitdir: PathSpec,
  table: ReadonlyMap<string, string>,
  revision: string,
  strict: boolean,
  warn: boolean,
): Promise<[string, string]> {
  const named = refsNamed(table, revision)
  if (warn && named.length > 1) return ['', `error: refname '${revision}' is ambiguous\n`]
  const [name] = named
  if (name === undefined) return ['', '']
  const found = await resolveSymbolic(dispatch, gitdir, table, name, true)
  if (found === null) return ['', '']
  return [`${shortenRef(found.name, new Set(table.keys()), strict)}\n`, '']
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
 * `git rev-parse`: each revision's object id, and the answers to the options
 * that report where the line runs, in the order the line gives them. With
 * `--verify` (or `--short`, which implies it) there must be exactly one
 * revision, printed after everything else, and `-q` turns the refusal into a
 * bare exit 1.
 */
export async function revParse(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const quiet = fl.asBool('quiet')
  let repo: Repo | undefined
  try {
    const marked = escaped(inv.argv)
    const revisions = inv.texts.filter((text) => text !== GIT_DIR_OPTION || marked.has(text))
    checkOperands(inv, revisions)
    const verb = inv.argv.indexOf('rev-parse')
    const words = inv.argv.slice(verb + 1)
    const end = words.indexOf('--')
    const named = end === -1 ? words : words.slice(0, end)
    const toplevel = named.includes(SHOW_TOPLEVEL)
    const mode = fl.raw('abbrev_ref')
    if (typeof mode === 'string') abbrevStrict(mode, true)
    repo = await opened(fl, inv.doors ?? {}, toplevel)
    const start = startPoint(fl).virtual
    if (
      toplevel &&
      (start === repo.location.gitdir.virtual ||
        start.startsWith(`${repo.location.gitdir.virtual}/`))
    )
      throw new NotAWorkTreeError()
    const answers = await placeAnswers(repo, start)
    if (fl.asBool('is_shallow_repository')) {
      const shallow = await readOptional(repo.dispatch, repo.location.commondir.join('shallow'))
      answers.set('--is-shallow-repository', `${String(shallow !== null)}\n`)
    }
    const short = fl.raw('short')
    const verify = fl.asBool('verify') || short !== undefined
    const width = shortWidth(short, repo.abbrev)
    const refs = await loadRefs(repo.dispatch, repo.location.gitdir, repo.location.commondir)
    const warn = await configBool(repo, 'core.warnAmbiguousRefs', true)
    const strict = mode === undefined ? warn : abbrevStrict(mode, warn)
    const shown: string[] = []
    const errors: string[] = []
    // What stops the line: git prints what it answered before it, then the
    // revision it could not read as one, then the refusal.
    let failed: GitError | null = null
    for (const revision of revisions) {
      let oid: string
      try {
        oid = (await resolveObject(repo, revision)).oid
      } catch (err) {
        if (!(err instanceof GitError)) throw err
        if (verify) throw new SingleRevisionError()
        shown.push(`${revision}\n`)
        failed = err
        break
      }
      if (mode === undefined) {
        const unique =
          short === undefined
            ? oid.length
            : ((await uniqueAbbreviations(repo, new Map([[oid, width]]))).get(oid) ?? width)
        shown.push(`${oid.slice(0, unique)}\n`)
        continue
      }
      const [line, error] = await abbreviated(
        repo.dispatch,
        repo.location.gitdir,
        refs,
        revision,
        strict,
        warn,
      )
      shown.push(line)
      // git prints each name's error right after its warning, so the error
      // joins the warnings' list; -q keeps it while it drops them.
      if (error === '') continue
      if (quiet || repo.ambiguous === null) errors.push(error)
      else repo.ambiguous.push(error)
    }
    if (verify && shown.length !== 1) throw new SingleRevisionError()
    const rows: string[] = []
    let next = 0
    for (const [at, word] of words.entries()) {
      if (failed !== null && next === shown.length) break
      const ended = end !== -1 && at > end
      const answer = ended ? undefined : answers.get(word)
      if (answer !== undefined) rows.push(answer)
      else if (!verify && (ended || !word.startsWith('-')) && next < shown.length)
        rows.push(shown[next++] ?? '')
    }
    rows.push(...shown.slice(next))
    if (failed !== null) {
      const refused = fatal(failed)
      if (refused !== null) return [ENC.encode(rows.join('')), refused[1]]
    }
    const stderr = errors.length > 0 ? ENC.encode(errors.join('')) : null
    return [ENC.encode(rows.join('')), new IOResult({ stderr })]
  } catch (err) {
    if (err instanceof SingleRevisionError && quiet) return [null, new IOResult({ exitCode: 1 })]
    if (err instanceof GitError) return fatal(err)
    throw err
  } finally {
    if (quiet) repo?.ambiguous?.splice(0)
  }
}
