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

import { enoent, isFsError, isWalkError } from '../../../errors/fs.ts'
import { drain, yieldBytes } from '../../../io/stream.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { DispatchFn, ShellFn } from '../../../runtime/types.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { shellJoin } from '../../../shell/join.ts'
import { concat } from '../../../utils/bytes.ts'
import { gnuBasename as basename } from '../../../utils/path.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import {
  FileType,
  LineFacts,
  PathSpec,
  type FileStat,
  type ReaddirFn,
  type StatFn,
} from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { specOf } from '../../spec/builtins.ts'
import { OPERAND } from '../../spec/constants.ts'
import { FlagView, specFlagNames } from '../../spec/flag_view.ts'
import { clapConflict, clapShown } from '../../spec/usage.ts'
import { FileTypes } from '../rg_filetypes.ts'
import {
  type IgnoreSources,
  IgnoreRules,
  Overrides,
  compileGlob,
  ignoreLines,
  walkCandidate,
} from '../rg_glob.ts'
import { type Haystack, WalkFilter, walkHaystacks } from '../rg_scan.ts'
import { type RgFlags, type Tally, smartCaseFolds } from '../rg_search.ts'
import { type RgProgram, openRg, streamHaystack } from '../rg_stream.ts'
import { dispatchOf, linkResolver, mountRoot, mountsOf } from '../utils/links.ts'
import { vfsReaddirPath, vfsStatPath } from '../utils/paths.ts'
import { WalkBudget } from '../utils/tree.ts'
import { mountParentReaddir, mountParentStat, toPathspec } from '../utils/wrap.ts'
import { ignoreReader, parseFlags as rgFlags } from './rg.ts'

const TYPES = new Map([
  ['f', 'file'],
  ['file', 'file'],
  ['d', 'directory'],
  ['dir', 'directory'],
  ['directory', 'directory'],
  ['l', 'symlink'],
  ['symlink', 'symlink'],
  ['b', 'block-device'],
  ['block-device', 'block-device'],
  ['c', 'char-device'],
  ['char-device', 'char-device'],
  ['x', 'executable'],
  ['executable', 'executable'],
  ['e', 'empty'],
  ['empty', 'empty'],
  ['s', 'socket'],
  ['socket', 'socket'],
  ['p', 'pipe'],
  ['pipe', 'pipe'],
])
const TYPE_NAMES =
  'file, directory, symlink, block-device, char-device, executable, empty, socket, pipe'
const KINDS = new Map<FileType, string>([
  [FileType.FILE, 'file'],
  [FileType.DIRECTORY, 'directory'],
  [FileType.SYMLINK, 'symlink'],
  [FileType.BLOCK_DEVICE, 'block-device'],
  [FileType.CHAR_DEVICE, 'char-device'],
  [FileType.SOCKET, 'socket'],
  [FileType.FIFO, 'pipe'],
])
const PLACEHOLDER = /\{(?:\/\.|\/\/|\/|\.)?\}/g
const REGEX_NOTE =
  "\n\nNote: You can use the '--fixed-strings' option to search for a literal string " +
  "instead of a regular expression. Alternatively, you can also use the '--glob' option " +
  'to match on a glob pattern.'
const HELP_HINT = "\n\nFor more information, try '--help'."
// fd 10.2.0's cli.rs by flag name: -x, -X and -l are one group whose members
// refuse each other and --max-results, -q and -1; each pair below refuses its
// other; the later of an overriding pair drops the earlier.
const EXECS = ['exec', 'exec_batch', 'list_details'] as const
const AGAINST_EXECS = new Set(['max_results', 'quiet', 'args_1'])
const CONFLICTS = new Set(
  [
    ['exec', 'exec_batch'],
    ['glob', 'fixed_strings'],
    ['exact_depth', 'max_depth'],
    ['exact_depth', 'min_depth'],
    ['quiet', 'max_results'],
    ['strip_cwd_prefix', 'paths'],
  ].flatMap(([a, b]) => [`${a ?? ''} ${b ?? ''}`, `${b ?? ''} ${a ?? ''}`]),
)
const OVERRIDES = new Map([
  ['glob', 'regex'],
  ['regex', 'glob'],
  ['max_results', 'args_1'],
  ['args_1', 'max_results'],
  ['case_sensitive', 'ignore_case'],
  ['ignore_case', 'case_sensitive'],
])
const UNDECLARED = new Map([['list_details', '--list-details']])
const FLAGS = [...specFlagNames(specOf('fd'))].sort(compareCodePoints)

/**
 * What --type keeps, as fd reads its values: the entry kinds it lists, then
 * executable and empty as tests every kept entry must also pass. empty
 * alone lists empty files and directories. Mirrors Python's Kinds.
 */
export interface Kinds {
  readonly kinds: ReadonlySet<string>
  readonly executable: boolean
  readonly empty: boolean
}

/** fd's options, parsed once. Mirrors Python's FdFlags. */
export interface FdFlags {
  readonly pattern: string
  readonly syntax: 'regex' | 'glob' | 'fixed'
  readonly ignoreCase: boolean
  readonly fullPath: boolean
  readonly hidden: boolean
  readonly sources: IgnoreSources
  readonly ignoreFiles: readonly PathSpec[]
  readonly kinds: Kinds
  readonly extensions: readonly string[]
  readonly excludes: readonly string[]
  readonly maxDepth: number | null
  readonly minDepth: number | null
  readonly absolute: boolean
  readonly follow: boolean
  readonly print0: boolean
  readonly maxResults: number | null
  readonly quiet: boolean
  // Each -x's command, run in turn for every result.
  readonly execCommands: readonly (readonly string[])[] | null
  // Each -X's command, run in turn once with every result.
  readonly batchCommands: readonly (readonly string[])[] | null
  readonly stripPrefix: string
}

function clapError(body: string): UsageError {
  return new UsageError(`error: ${body}${HELP_HINT}`, 2)
}

function count(fl: FlagView, dest: string, shown: string): number | null {
  const value = fl.asStr(dest)
  if (value === undefined) return null
  if (!/^[0-9]+$/.test(value)) {
    const reason =
      value === '' ? 'cannot parse integer from empty string' : 'invalid digit found in string'
    throw clapError(`invalid value '${value}' for '${shown}': ${reason}`)
  }
  return Number(value)
}

function kindsOf(values: readonly string[]): Kinds {
  if (values.length === 0) return { kinds: new Set(), executable: false, empty: false }
  const named = new Set<string>()
  for (const value of values) {
    const kind = TYPES.get(value)
    if (kind === undefined)
      throw clapError(
        `invalid value '${value}' for '--type <filetype>'\n  [possible values: ${TYPE_NAMES}]`,
      )
    named.add(kind)
  }
  const executable = named.has('executable')
  const empty = named.has('empty')
  const kinds = new Set([...named].filter((kind) => kind !== 'executable' && kind !== 'empty'))
  if (executable) kinds.add('file')
  if (empty && !kinds.has('file') && !kinds.has('directory')) {
    kinds.add('file')
    kinds.add('directory')
  }
  return { kinds, executable, empty }
}

function last(fl: FlagView, ...dests: string[]): string | undefined {
  const typed = fl.typedOrder(...dests)
  return typed[typed.length - 1]
}

function commands(
  fl: FlagView,
  dest: string,
  shown: string,
): readonly (readonly string[])[] | null {
  if (fl.raw(dest) === undefined) return null
  const typed = fl
    .occurrences(dest)
    .map(([, value]) => value)
    .filter((value): value is string[] => Array.isArray(value))
  const found = typed.length > 0 ? typed : [fl.asList(dest)]
  if (found.some((words) => words.length === 0))
    throw clapError(`a value is required for '${shown}' but none was supplied`)
  return found
}

/**
 * The arguments a line typed, by flag or operand name, in the order clap's
 * matcher holds them: where each was first typed, the earlier of an
 * overriding pair dropped. Mirrors Python's _typed.
 */
function typedArguments(fl: FlagView): string[] {
  const names: string[] = []
  let operands = 0
  for (const [key, value] of fl.occurrences(OPERAND, ...FLAGS)) {
    if (typeof value !== 'string' && !Array.isArray(value) && !value) continue
    let name = key
    if (name === OPERAND) {
      operands += 1
      name = operands === 1 ? 'text' : 'paths'
    }
    const loser = OVERRIDES.get(name)
    const at = loser === undefined ? -1 : names.indexOf(loser)
    if (at !== -1) names.splice(at, 1)
    if (!names.includes(name)) names.push(name)
  }
  return names
}

function shownArgument(name: string): string {
  return UNDECLARED.get(name) ?? clapShown('fd', name)
}

/**
 * Refuse the first typed argument another typed one conflicts with, as
 * clap's validator does: a group's members unrolled where its first typed
 * member stands. Mirrors Python's _refuse_conflicts.
 */
function refuseConflicts(names: readonly string[]): void {
  const inExecs = (name: string): boolean => (EXECS as readonly string[]).includes(name)
  for (const name of names) {
    const partners: string[] = []
    for (const other of names) {
      if (other === name) continue
      const grouped = AGAINST_EXECS.has(name) && inExecs(other)
      if (
        grouped ||
        (AGAINST_EXECS.has(other) && inExecs(name)) ||
        CONFLICTS.has(`${name} ${other}`)
      )
        partners.push(other)
      if (grouped) partners.push(...EXECS)
    }
    if (partners.length > 0)
      throw clapError(
        clapConflict(
          'fd',
          shownArgument(name),
          [...new Set(partners.map(shownArgument))],
          names.filter((n) => !partners.includes(n)),
        ),
      )
  }
}

/**
 * fd's options, the last of each overriding pair winning, refused as clap
 * refuses them: a bad value first, then a conflict. Mirrors Python's
 * parse_flags.
 */
export function parseFlags(fl: FlagView, texts: readonly string[]): FdFlags {
  const pattern = texts[0] ?? ''
  const syntax =
    last(fl, 'glob', 'regex') === 'glob' ? 'glob' : fl.asBool('fixed_strings') ? 'fixed' : 'regex'
  const caseMode = last(fl, 'case_sensitive', 'ignore_case')
  const ignoreCase =
    caseMode === 'ignore_case'
      ? true
      : caseMode === 'case_sensitive'
        ? false
        : syntax === 'glob'
          ? pattern === pattern.toLowerCase()
          : smartCaseFolds(pattern, syntax === 'fixed')
  const unrestricted = fl.asInt('unrestricted') ?? 0
  const noIgnore = fl.asBool('no_ignore') || unrestricted > 0
  const vcs = !noIgnore && !fl.asBool('no_ignore_vcs')
  const sources: IgnoreSources = {
    vcs,
    exclude: vcs,
    dot: !noIgnore,
    custom: '.fdignore',
    parents: !fl.asBool('no_ignore_parent'),
    requireGit: !fl.asBool('no_require_git'),
    bom: false,
  }
  const exact = count(fl, 'exact_depth', '--exact-depth <depth>')
  let maxDepth = count(fl, 'max_depth', '--max-depth <depth>')
  let minDepth = count(fl, 'min_depth', '--min-depth <depth>')
  if (exact !== null) maxDepth = minDepth = exact
  let maxResults = count(fl, 'max_results', '--max-results <count>')
  if (last(fl, 'max_results', 'args_1') === 'args_1') maxResults = 1
  if (maxResults === 0) maxResults = null
  count(fl, 'threads', '--threads <num>')
  const execCommands = commands(fl, 'exec', '--exec <cmd>...')
  const batchCommands = commands(fl, 'exec_batch', '--exec-batch <cmd>...')
  refuseConflicts(typedArguments(fl))
  return {
    pattern,
    syntax,
    ignoreCase,
    fullPath: fl.asBool('full_path'),
    hidden: fl.asBool('hidden') || unrestricted > 0,
    sources,
    ignoreFiles: fl.asPaths('ignore_file'),
    kinds: kindsOf(fl.asList('type')),
    extensions: fl.asList('extension').map((ext) => ext.replace(/^\./, '').toLowerCase()),
    excludes: fl.asList('exclude'),
    maxDepth,
    minDepth,
    absolute: fl.asBool('absolute_path'),
    follow: fl.asBool('follow'),
    print0: fl.asBool('print0'),
    maxResults,
    quiet: fl.asBool('quiet'),
    execCommands,
    batchCommands,
    stripPrefix: fl.asStr('strip_cwd_prefix') ?? 'auto',
  }
}

/**
 * An fd line reads below every directory it names and walks into the mounts
 * below them; it changes nothing itself. Mirrors Python's facts.
 */
export function facts(_fl: FlagView, _operands: readonly (string | PathSpec)[]): LineFacts {
  return new LineFacts({ walks: true, readsSubtree: true, writes: false })
}

/**
 * A regex refusal with the pattern as fd shows it: ripgrep's engine quotes
 * the group it wraps every pattern in, `(?:...)`, and points three columns
 * further right. A refusal that points at the wrapper itself (`a(b`, whose
 * group the wrapper's `)` closes) keeps the engine's excerpt, which fd,
 * parsing the pattern bare, words differently. Mirrors Python's _unwrapped.
 */
function unwrapped(message: string, pattern: string): string {
  const lines = message.split('\n')
  if (
    lines.length >= 3 &&
    lines[1] === `    (?:${pattern})` &&
    (lines[2] ?? '').startsWith(' '.repeat(7))
  ) {
    lines[1] = `    ${pattern}`
    lines[2] = (lines[2] ?? '').slice(0, 4) + (lines[2] ?? '').slice(7)
  }
  return lines.join('\n')
}

/**
 * Whether an entry's name (or, under -p, its absolute path) matches the
 * pattern: a regex or -F literal runs ripgrep's engine, one record per name,
 * so its syntax and case folding are the Rust regex crate's, as fd's are; a
 * glob compiles to globset's form. Mirrors Python's _Matcher.
 */
class Matcher {
  private constructor(
    private readonly glob: RegExp | null,
    private readonly program: RgProgram | null,
    private readonly rg: RgFlags | null,
  ) {}

  static async open(f: FdFlags): Promise<Matcher> {
    if (f.pattern === '') return new Matcher(null, null, null)
    try {
      if (f.syntax === 'glob') return new Matcher(compileGlob(f.pattern, f.ignoreCase), null, null)
      const rg: RgFlags = {
        ...rgFlags(new FlagView({}, specOf('rg'))),
        ignoreCase: f.ignoreCase,
        smartCase: false,
        fixedString: f.syntax === 'fixed',
        nullData: true,
        quiet: true,
      }
      return new Matcher(null, await openRg(f.pattern, false, rg), rg)
    } catch (error) {
      if (!(error instanceof UsageError)) throw error
      const message = unwrapped(error.message.replace(/^rg: /, ''), f.pattern)
      const note = f.syntax === 'regex' ? REGEX_NOTE : ''
      throw new UsageError(`[fd error]: ${message}${note}`, 1)
    }
  }

  async matches(subject: string): Promise<boolean> {
    if (this.glob !== null) {
      const found = this.glob.exec(subject)
      return found !== null && found.index === 0 && found[0].length === subject.length
    }
    if (this.program === null || this.rg === null) return true
    const tally: Tally = { selected: false }
    await drain(
      streamHaystack(
        yieldBytes(encodeText(subject)),
        this.program,
        this.rg,
        '',
        null,
        tally,
        undefined,
        false,
        false,
      ),
    )
    return tally.selected
  }

  /** Release the engine's stream. */
  close(): void {
    this.program?.stream.close()
  }
}

function absolute(path: string, cwd: string): string {
  if (path.startsWith('/')) return path
  const rest = path.startsWith('./') ? path.slice(2) : path
  if (rest === '' || rest === '.') return cwd
  return cwd === '/' ? `/${rest}` : `${cwd}/${rest}`
}

function rootShown(raw: string): string {
  const stripped = raw.replace(/\/+$/, '')
  return stripped !== '' ? stripped : raw.slice(0, 1)
}

// A path's place in fd's order, which compares paths component by
// component: NUL sorts below every character a name can hold.
function sortKey(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('\0')
}

function dirname(path: string): string {
  const at = path.lastIndexOf('/')
  if (at === -1) return '.'
  return at === 0 ? '/' : path.slice(0, at)
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function withoutExtension(path: string): string {
  const parent = dirname(path)
  const joined = parent === '/' ? `/${stem(basename(path))}` : `${parent}/${stem(basename(path))}`
  return joined.startsWith('./') ? joined.slice(2) : joined
}

function expand(word: string, path: string): string {
  return word.replace(PLACEHOLDER, (token) => {
    if (token === '{}') return path
    if (token === '{/}') return basename(path)
    if (token === '{//}') return dirname(path)
    if (token === '{.}') return withoutExtension(path)
    return stem(basename(path))
  })
}

/**
 * -x's command for one result: each placeholder filled, or the path
 * appended when the command names none. Mirrors Python's exec_argv.
 */
export function execArgv(words: readonly string[], path: string): string[] {
  if (!words.some((word) => word.search(PLACEHOLDER) !== -1)) return [...words, path]
  return words.map((word) => expand(word, path))
}

/**
 * -X's one command: each word holding a placeholder repeated for every
 * result, or the results appended when it names none. Mirrors Python's
 * batch_argv.
 */
export function batchArgv(words: readonly string[], paths: readonly string[]): string[] {
  if (!words.some((word) => word.search(PLACEHOLDER) !== -1)) return [...words, ...paths]
  const argv: string[] = []
  for (const word of words) {
    if (word.search(PLACEHOLDER) !== -1) argv.push(...paths.map((path) => expand(word, path)))
    else argv.push(word)
  }
  return argv
}

// One entry fd lists: its path from the operand as typed, whether it is a
// directory (output marks one with `/`), and whether it lies below the
// implicit cwd, whose `./` fd strips unless -0, -x or -X asks for it.
interface Result {
  readonly path: string
  readonly isDir: boolean
  readonly implicit: boolean
}

async function isEmpty(
  hit: Haystack,
  readdir: (path: string) => Promise<string[]>,
): Promise<boolean> {
  const stat = hit.stat
  if (stat === null) return false
  if (stat.type === FileType.FILE) return stat.size === 0
  if (stat.type !== FileType.DIRECTORY) return false
  try {
    const entries =
      hit.resolver !== null ? await hit.resolver.readdir(hit.virtual) : await readdir(hit.virtual)
    return entries.length === 0
  } catch (error) {
    if (!isWalkError(error)) throw error
    console.debug(`fd: cannot list ${hit.virtual}: ${String(error)}`)
    return false
  }
}

async function kept(
  hit: Haystack,
  f: FdFlags,
  matcher: Matcher,
  cwd: string,
  readdir: (path: string) => Promise<string[]>,
): Promise<boolean> {
  const stat = hit.stat
  if (stat === null) return false
  if (f.minDepth !== null && (hit.depth ?? 0) < f.minDepth) return false
  const kinds = f.kinds
  if (kinds.kinds.size > 0 && !kinds.kinds.has(KINDS.get(stat.type) ?? '')) return false
  if (kinds.executable && ((stat.mode ?? 0) & 0o111) === 0) return false
  const name = basename(hit.shown)
  if (
    f.extensions.length > 0 &&
    !f.extensions.some((ext) => name.toLowerCase().endsWith(`.${ext}`))
  )
    return false
  const subject = f.fullPath ? absolute(hit.shown, cwd) : name
  if (!(await matcher.matches(subject))) return false
  return !kinds.empty || (await isEmpty(hit, readdir))
}

/**
 * --ignore-file's rules. fd reports a file with one line that does not
 * compile and keeps its other lines; a file with more is kept as quietly, as
 * fd drops the ignore crate's partial error. Mirrors Python's
 * _ignore_rules_of.
 */
async function ignoreRulesOf(
  paths: readonly PathSpec[],
  dispatch: DispatchFn | undefined,
  err: Uint8Array[],
): Promise<IgnoreRules> {
  const lines: string[] = []
  for (const path of paths) {
    if (dispatch === undefined) continue
    let read: string[]
    try {
      const [data] = await dispatch('read', path)
      read = ignoreLines(await materialize(data as ByteSource), false)
    } catch (error) {
      if (!isFsError(error)) throw error
      console.debug(`fd: cannot read ${path.rawPath}: ${String(error)}`)
      continue
    }
    const errors = new IgnoreRules(read).errors
    if (errors.length === 1)
      err.push(
        encodeText(
          `[fd error]: Malformed pattern in custom ignore file. ${path.rawPath}: ${errors[0] ?? ''}.\n`,
        ),
      )
    lines.push(...read)
  }
  return new IgnoreRules(lines)
}

async function run(
  shell: ShellFn | undefined,
  argv: readonly string[],
  out: Uint8Array[],
  err: Uint8Array[],
): Promise<boolean> {
  if (shell === undefined) {
    err.push(encodeText(`[fd error]: Command not found: ${argv[0] ?? ''}\n`))
    return false
  }
  const io = await shell(shellJoin([...argv]), new Uint8Array())
  if (io.stdout !== null) out.push(await materialize(io.stdout))
  if (io.stderr !== null) err.push(await materialize(io.stderr))
  return io.exitCode === 0
}

/**
 * List the entries below each search path whose name matches. fd walks with
 * ripgrep's ignore rules (`.gitignore` inside a repository, `.ignore`,
 * `.fdignore`), skips hidden entries unless -H, and never lists a search path
 * itself. Its results print sorted by path, as fd prints a walk that ends
 * inside its buffering window; a directory ends in `/`. A search path that
 * is not a directory is reported and skipped. Mirrors Python's fd_generic.
 */
export async function fdGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stat: StatFn,
  readdir: ReaddirFn,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, specOf('fd'))
  let f: FdFlags
  let matcher: Matcher
  try {
    f = parseFlags(fl, texts)
    matcher = await Matcher.open(f)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    return [
      null,
      new IOResult({ exitCode: error.exitCode, stderr: encodeText(`${error.message}\n`) }),
    ]
  }
  try {
    return await search(paths, f, matcher, ctx, stat, readdir)
  } finally {
    matcher.close()
  }
}

/**
 * fd's walk and output once its flags parsed. -E is rooted at the first
 * search path, as fd roots its overrides. A result limit walks the roots as
 * typed, each directory in name order, and stops once it is met. Each
 * operand's walk stops at its mounts' `walkLimit`, reported in fd's voice.
 * Mirrors Python's _search.
 */
async function search(
  paths: PathSpec[],
  f: FdFlags,
  matcher: Matcher,
  ctx: Context,
  stat: StatFn,
  readdir: ReaddirFn,
): Promise<CommandFnResult> {
  const dispatch = dispatchOf(ctx)
  const cwd = ctx.cwd.virtual
  const mounts = mountsOf(ctx)
  const rd = mountParentReaddir((p: string) => readdir(toPathspec(p)), mounts, mountRoot(ctx))
  const st = mountParentStat((p: string) => stat(toPathspec(p)), mounts)
  const err: Uint8Array[] = []
  const roots: [PathSpec, string][] = []
  const typed = paths.length > 0
  for (const p of typed ? paths : [ctx.cwd]) {
    let isDir = false
    try {
      isDir = (await st(p.virtual)).type === FileType.DIRECTORY
    } catch (error) {
      if (!isWalkError(error)) throw error
      console.debug(`fd: cannot stat ${p.rawPath}: ${String(error)}`)
    }
    if (!isDir) {
      err.push(encodeText(`[fd error]: Search path '${p.rawPath}' is not a directory.\n`))
      continue
    }
    roots.push([p, typed ? rootShown(p.rawPath) : ''])
  }
  if (roots.length === 0) {
    err.push(encodeText('[fd error]: No valid search paths given.\n'))
    return [null, new IOResult({ exitCode: 1, stderr: concat(err) })]
  }
  const walk = new WalkFilter(
    new Overrides(
      f.excludes.map((glob) => `!${glob}`),
      [],
      false,
      walkCandidate(roots[0]?.[1] ?? '', cwd),
    ),
    new FileTypes([], []),
    f.hidden,
    f.maxDepth,
    null,
    true,
    await ignoreRulesOf(f.ignoreFiles, dispatch, err),
  )
  const limit = f.maxResults
  const warnings: string[] = []
  const stopped: string[] = []
  const resolver = linkResolver(ctx)
  const reader = ignoreReader(dispatch)
  const ignore = reader === null ? null : { sources: f.sources, reader }
  const found: Result[] = []
  const readdirPath = vfsReaddirPath(ctx.vfs)
  const statPath = vfsStatPath(ctx.vfs)
  for (const [root, shownRoot] of roots) {
    const home = mounts?.rootOf(root.virtual) ?? null
    const budget = new WalkBudget(root, mounts ?? null)
    const crosses = (path: string): boolean =>
      mounts !== undefined && home !== null && mounts.rootOf(path) !== home
    const listed = async (path: string): Promise<string[]> =>
      readdirPath !== undefined && crosses(path) ? readdirPath(path) : rd(path)
    const walkRd = (path: string): Promise<string[]> =>
      budget.listing((directory) => listed(directory.virtual), PathSpec.fromStrPath(path))
    const walkSt = async (path: string): Promise<FileStat> => {
      if (statPath !== undefined && crosses(path)) {
        const at = await statPath(path)
        if (at === null) throw enoent(path)
        return at
      }
      return st(path)
    }
    for await (const hit of walkHaystacks(
      walkRd,
      walkSt,
      root.virtual,
      shownRoot,
      cwd,
      walk,
      limit !== null,
      warnings,
      null,
      resolver,
      f.follow,
      true,
      ignore,
      true,
    )) {
      if (await kept(hit, f, matcher, cwd, listed)) {
        found.push({
          path: hit.shown,
          isDir: hit.stat?.type === FileType.DIRECTORY,
          implicit: shownRoot === '',
        })
        if (f.quiet || found.length === limit) break
      }
    }
    for (const line of budget.stopped) if (!stopped.includes(line)) stopped.push(line)
    if (found.length > 0 && (f.quiet || found.length === limit)) break
  }
  for (const line of warnings) console.debug(`fd: ${line}`)
  for (const line of stopped) err.push(encodeText(`[fd error]: ${line}\n`))
  if (f.quiet)
    return [null, new IOResult({ exitCode: found.length > 0 ? 0 : 1, stderr: concat(err) })]
  const listedResults = found
    .map((result) => [sortKey(result.path), result] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, result]) => result)
  const prefixed =
    f.stripPrefix === 'never' ||
    (f.stripPrefix === 'auto' && (f.print0 || f.execCommands !== null || f.batchCommands !== null))
  const spelled = (result: Result): string => {
    if (f.absolute) return absolute(result.path, cwd)
    if (prefixed && result.implicit) return `./${result.path}`
    return result.path
  }
  const out: Uint8Array[] = []
  let ok = stopped.length === 0
  if (f.execCommands !== null) {
    for (const result of listedResults) {
      for (const words of f.execCommands) {
        const ran = await run(ctx.shell, execArgv(words, spelled(result)), out, err)
        ok = ran && ok
      }
    }
    return [concat(out), new IOResult({ exitCode: ok ? 0 : 1, stderr: concat(err) })]
  }
  if (f.batchCommands !== null) {
    if (listedResults.length > 0) {
      for (const words of f.batchCommands) {
        const ran = await run(ctx.shell, batchArgv(words, listedResults.map(spelled)), out, err)
        ok = ran && ok
      }
    }
    return [concat(out), new IOResult({ exitCode: ok ? 0 : 1, stderr: concat(err) })]
  }
  const end = f.print0 ? '\0' : '\n'
  for (const result of listedResults) {
    const path = spelled(result)
    const mark = result.isDir && !path.endsWith('/') ? '/' : ''
    out.push(encodeText(path + mark + end))
  }
  return [concat(out), new IOResult({ exitCode: ok ? 0 : 1, stderr: concat(err) })]
}
