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

import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { cacheAwareStream } from '../../../cache/read_through.ts'
import { mountParentReaddir, mountParentStat } from '../utils/operands.ts'
import { IOResult } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { fsStrerror, isFsError, isWalkError } from '../../../utils/errors.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView, flagOccurrences } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { decodeLine, encodeLine } from '../grep_offsets.ts'
import { buildPatternStr, resolvePattern } from '../grep_pattern.ts'
import { exitCodeFor } from '../grep_scan.ts'
import { FileTypes, typeListing, type TypeChange, type TypeSelection } from '../rg_filetypes.ts'
import { Overrides } from '../rg_glob.ts'
import { type Haystack, WalkFilter, walkHaystacks } from '../rg_scan.ts'
import {
  hostNamedGroups,
  printsContext,
  type RgFlags,
  searchHaystack,
  smartCaseFolds,
  type Tally,
} from '../rg_search.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { formatOptionalRecords, formatRecords } from '../utils/output.ts'
import { isStdin, stdinStream } from '../utils/stream.ts'

const ENC = new TextEncoder()
// ripgrep's own words for a line with no pattern, exit 2 (14.1.1).
export const RG_NO_PATTERN = 'rg: ripgrep requires at least one pattern to execute a search'
// What ripgrep says when a line that named no path searched nothing, exit 2
// (14.1.1).
export const NOTHING_SEARCHED =
  "rg: No files were searched, which means ripgrep probably applied a filter you didn't " +
  'expect.\nRunning with --debug will show why files are being skipped.'
// ripgrep's name for stdin wherever it names the file a line came from.
const STDIN_NAME = '<stdin>'
// The synthetic cwd operand's spelling (routing's CWD_DEFAULT_RAW.rg): a
// line that named no path at all.
const IMPLICIT_CWD = ''
const SORT_KEYS = ['path', 'modified', 'accessed', 'created', 'none']
const COLOR_CHOICES = ['never', 'auto', 'always', 'ansi']
const SIZE = /^([0-9]+)([KMG]?)$/
const SIZE_UNIT: Readonly<Record<string, number>> = { '': 1, K: 1 << 10, M: 1 << 20, G: 1 << 30 }
const U64_MAX = (1n << 64n) - 1n
// The numeric options, each named as ripgrep names it in a refusal. The bag
// keeps no record of which spelling the line typed, so a long one is refused
// under its short name.
const NUMBER_SPELLINGS: Readonly<Record<string, string>> = {
  max_count: '-m',
  after_context: '-A',
  before_context: '-B',
  context: '-C',
  max_depth: '-d',
  threads: '-j',
  max_columns: '-M',
}
const ESCAPES: Readonly<Record<string, string>> = {
  t: '\t',
  n: '\n',
  r: '\r',
  '0': '\0',
  '\\': '\\',
}
const HEX_ESCAPE = /\\x([0-9A-Fa-f]{2})/y

type Stat = (p: PathSpec) => Promise<FileStat>
type Readdir = (p: PathSpec) => Promise<string[]>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>
type Boundary = ((path: string) => boolean) | null

export type { RgFlags } from '../rg_search.ts'

// The name ripgrep prints for an operand. `-` is `<stdin>`; `/dev/stdin`
// reads the same bytes, but ripgrep opens it as the path it is and names it
// as typed.
function operandName(p: PathSpec): string {
  return p.rawPath === '-' ? STDIN_NAME : p.rawPath
}

/**
 * One numeric option's value, refused in ripgrep's words: ripgrep reads
 * every count as an unsigned 64-bit integer, so a sign, a fraction or
 * anything past 2**64-1 is refused, exit 2 (14.1.1).
 */
export function numberFlag(fl: FlagView, dest: string): number | null {
  const raw = fl.raw(dest)
  if (raw === undefined || typeof raw === 'boolean') return null
  const value = String(raw)
  const digits = value.startsWith('+') ? value.slice(1) : value
  let reason: string | null = null
  if (value === '') reason = 'cannot parse integer from empty string'
  else if (!/^[0-9]+$/.test(digits)) reason = 'invalid digit found in string'
  else if (BigInt(digits) > U64_MAX) reason = 'number too large to fit in target type'
  if (reason !== null) {
    throw new UsageError(
      `rg: error parsing flag ${NUMBER_SPELLINGS[dest] ?? dest}: value is not a valid number: ${reason}`,
    )
  }
  return Number(digits)
}

// --max-filesize in bytes, refused in ripgrep's words.
function filesizeFlag(fl: FlagView): number | null {
  const value = fl.asStr('max_filesize')
  if (value === undefined) return null
  const size = SIZE.exec(value)
  if (size === null) {
    throw new UsageError(
      `rg: error parsing flag --max-filesize: invalid size: invalid format for size '${value}', ` +
        "which should be a non-empty sequence of digits followed by an optional 'K', 'M' or 'G' " +
        'suffix',
    )
  }
  return Number(size[1]) * (SIZE_UNIT[size[2] ?? ''] ?? 1)
}

// A value from a fixed set, refused in ripgrep's words.
function choice(
  fl: FlagView,
  dest: string,
  spelling: string,
  choices: readonly string[],
): string | null {
  const value = fl.asStr(dest)
  if (value !== undefined && !choices.includes(value)) {
    throw new UsageError(`rg: error parsing flag ${spelling}: choice '${value}' is unrecognized`)
  }
  return value ?? null
}

// A separator's escapes read as ripgrep reads them (`\t`, `\n`, `\r`, `\0`,
// `\\` and `\xHH`).
export function unescape(value: string): string {
  const out: string[] = []
  let i = 0
  while (i < value.length) {
    HEX_ESCAPE.lastIndex = i
    const hexed = HEX_ESCAPE.exec(value)
    if (hexed !== null) {
      out.push(String.fromCharCode(Number.parseInt(hexed[1] ?? '0', 16)))
      i += hexed[0].length
      continue
    }
    const escaped = value[i] === '\\' ? ESCAPES[value[i + 1] ?? ''] : undefined
    if (escaped !== undefined) {
      out.push(escaped)
      i += 2
      continue
    }
    out.push(value[i] ?? '')
    i += 1
  }
  return out.join('')
}

// The one of `names` the line set last, or null.
function last(fl: FlagView, ...names: string[]): string | null {
  let found: string | null = null
  for (const name of fl.typedOrder(...names)) {
    const raw = fl.raw(name)
    if (fl.asBool(name) || (raw !== undefined && typeof raw !== 'boolean')) {
      found = name
    }
  }
  return found
}

// Which of -H and -I the line set last, the one ripgrep obeys.
export function filenameFlag(fl: FlagView): string | null {
  return last(fl, 'with_filename', 'no_filename')
}

/**
 * --passthru and -A/-B/-C resolved in line order, as ripgrep's ContextMode
 * resolves them: --passthru replaces every context option before it, and a
 * context option after it replaces it and starts afresh. -A and -B, even at
 * 0, outrank -C for their own side. Returns --passthru and the before and
 * after counts.
 */
function contextOf(fl: FlagView): [boolean, number, number] {
  let passthru = false
  let counts = new Map<string, number | null>()
  for (const name of fl.typedOrder(
    'passthru',
    'passthrough',
    'after_context',
    'before_context',
    'context',
  )) {
    if (name === 'passthru' || name === 'passthrough') {
      passthru = true
      counts = new Map()
      continue
    }
    passthru = false
    counts.set(name, numberFlag(fl, name))
  }
  const both = counts.get('context') ?? null
  const before = counts.get('before_context') ?? null
  const after = counts.get('after_context') ?? null
  return [passthru, before ?? both ?? 0, after ?? both ?? 0]
}

// Whether -a, --binary or -uuu, the last word of their group, lift the
// walk's binary-extension skip; --no-text and --no-binary put it back.
function binaryOf(fl: FlagView, unrestricted: number): boolean {
  let on = false
  for (const name of fl.typedOrder('text', 'no_text', 'binary', 'no_binary', 'unrestricted')) {
    if (name === 'unrestricted') on = on || unrestricted >= 3
    else on = name === 'text' || name === 'binary'
  }
  return on
}

// --path-separator's one byte, null for ripgrep's own `/`; anything but one
// byte is refused (an empty one is the default).
function pathSeparator(fl: FlagView): string | null {
  const value = fl.asStr('path_separator')
  if (value === undefined) return null
  const raw = encodeLine(unescape(value))
  if (raw.length === 0) return null
  if (raw.length !== 1) {
    throw new UsageError(
      'rg: error parsing flag --path-separator: A path separator must be exactly one byte, ' +
        `but the given separator is ${String(raw.length)} bytes: ${value}\nIn some shells on ` +
        "Windows '/' is automatically expanded. Use '//' instead.",
    )
  }
  return decodeLine(raw)
}

/**
 * Convert the raw flag bag into RgFlags, the only string-keyed reads.
 * Options that override one another are read in line order, the last one
 * winning as it does in ripgrep: -i/-s/-S, -w/-x, -n/-N, -H/-I, every option
 * and its --no- negation, --hidden/--no-hidden/-uu, the output modes
 * -c/--count-matches/-l/--files-without-match, --heading/--no-heading,
 * --passthru and the context options, --sort/--sortr/--sort-files/
 * --no-sort-files, and --context-separator/--no-context-separator. A value
 * ripgrep refuses throws its words.
 */
export function parseFlags(fl: FlagView): RgFlags {
  numberFlag(fl, 'threads')
  choice(fl, 'color', '--color', COLOR_CHOICES)
  const caseMode = last(fl, 'ignore_case', 'case_sensitive', 'smart_case')
  const bounds = last(fl, 'word_regexp', 'line_regexp')
  const listing = last(fl, 'count', 'count_matches', 'files_with_matches', 'files_without_match')
  const numbers = last(fl, 'line_number', 'no_line_number')
  const vimgrep = fl.asBool('vimgrep')
  const columns = last(fl, 'column', 'no_column')
  const column = columns !== null ? columns === 'column' : vimgrep
  const [passthru, contextBefore, contextAfter] = contextOf(fl)
  const unrestricted = fl.asInt('unrestricted') ?? 0
  let hidden = false
  for (const name of fl.typedOrder('hidden', 'no_hidden', 'unrestricted')) {
    if (name === 'hidden') hidden = fl.asBool(name)
    else if (name === 'no_hidden') hidden = !fl.asBool(name) && hidden
    else if (unrestricted >= 2) hidden = true
  }
  const sortFlag = last(fl, 'sort', 'sortr', 'sort_files', 'no_sort_files')
  let sort: string | null = null
  if (sortFlag === 'sort_files') sort = 'path'
  else if (sortFlag === 'sort' || sortFlag === 'sortr') {
    sort = choice(fl, sortFlag, `--${sortFlag}`, SORT_KEYS)
  }
  const separator = last(fl, 'context_separator', 'no_context_separator')
  const typedSeparator = fl.asStr('context_separator')
  if (sort === 'created') {
    throw new UsageError('rg: sorting by creation time is not supported by the virtual filesystem')
  }
  const selections: TypeSelection[] = []
  for (const [name, value] of fl.occurrences('type', 'type_not')) {
    if (typeof value === 'string') selections.push([value, name === 'type_not'])
  }
  const changes: TypeChange[] = []
  for (const [name, value] of fl.occurrences('type_clear', 'type_add')) {
    if (typeof value === 'string') changes.push([name === 'type_clear' ? 'clear' : 'add', value])
  }
  return {
    ignoreCase: caseMode === 'ignore_case',
    smartCase: caseMode === 'smart_case',
    invert: last(fl, 'invert_match', 'no_invert_match') === 'invert_match',
    wholeWord: bounds === 'word_regexp',
    lineRegexp: bounds === 'line_regexp',
    fixedString: last(fl, 'fixed_strings', 'no_fixed_strings') === 'fixed_strings',
    lineNumbers: numbers !== null ? numbers === 'line_number' : column || vimgrep,
    column,
    vimgrep,
    byteOffsets: last(fl, 'byte_offset', 'no_byte_offset') === 'byte_offset',
    onlyMatching: fl.asBool('only_matching'),
    replace: fl.asStr('replace') ?? null,
    trim: last(fl, 'trim', 'no_trim') === 'trim',
    maxColumns: numberFlag(fl, 'max_columns'),
    maxColumnsPreview:
      last(fl, 'max_columns_preview', 'no_max_columns_preview') === 'max_columns_preview',
    null: fl.asBool('null'),
    nullData: fl.asBool('null_data'),
    pathSeparator: pathSeparator(fl),
    quiet: fl.asBool('quiet'),
    countOnly: listing === 'count',
    countMatches: listing === 'count_matches',
    includeZero: last(fl, 'include_zero', 'no_include_zero') === 'include_zero',
    filesOnly: listing === 'files_with_matches',
    filesWithoutMatch: listing === 'files_without_match',
    listFiles: fl.asBool('files'),
    typeList: fl.asBool('type_list'),
    withFilename: filenameFlag(fl) === 'with_filename',
    noFilename: filenameFlag(fl) === 'no_filename',
    // --vimgrep prints a location per line, so it never heads a group.
    heading: last(fl, 'heading', 'no_heading') === 'heading' && !vimgrep,
    passthru,
    maxCount: numberFlag(fl, 'max_count'),
    stopOnNonmatch: fl.asBool('stop_on_nonmatch'),
    contextAfter,
    contextBefore,
    contextSeparator:
      separator === 'no_context_separator'
        ? null
        : typedSeparator !== undefined
          ? unescape(typedSeparator)
          : '--',
    fieldMatchSeparator: unescape(fl.asStr('field_match_separator') ?? ':'),
    fieldContextSeparator: unescape(fl.asStr('field_context_separator') ?? '-'),
    globs: fl.asList('glob'),
    iglobs: fl.asList('iglob'),
    globCaseInsensitive:
      last(fl, 'glob_case_insensitive', 'no_glob_case_insensitive') === 'glob_case_insensitive',
    typeChanges: changes,
    typeSelections: selections,
    hidden,
    maxDepth: numberFlag(fl, 'max_depth'),
    maxFilesize: filesizeFlag(fl),
    oneFileSystem: last(fl, 'one_file_system', 'no_one_file_system') === 'one_file_system',
    binary: binaryOf(fl, unrestricted),
    sort,
    sortReverse: sortFlag === 'sortr',
    noMessages: last(fl, 'no_messages', 'messages') === 'no_messages',
  }
}

// Whether the search ignores case: -i, or -S over a pattern with no
// uppercase literal in it.
export function foldsCase(pattern: string, fixed: boolean, f: RgFlags): boolean {
  return f.ignoreCase || (f.smartCase && smartCaseFolds(pattern, fixed))
}

/**
 * The pattern list compiled the way the flags ask. -w and -x, whichever the
 * line gave last, bound the whole list: -x to the line, -w to ripgrep's half
 * word boundaries (no word character just before the match or just after
 * it, which `\b` would also demand inside it). -S folds case only when the
 * pattern is all lowercase. `neverMatch` is the zero-pattern sentinel from
 * `resolvePattern`; it is a regex, so it suppresses -F.
 */
export function rgMatcher(pattern: string, neverMatch: boolean, f: RgFlags): RegExp {
  const fixed = f.fixedString && !neverMatch
  let source = buildPatternStr(fixed ? pattern : hostNamedGroups(pattern), fixed)
  if (f.lineRegexp) source = `^(?:${source})$`
  else if (f.wholeWord) source = `(?<!\\w)(?:${source})(?!\\w)`
  return new RegExp(source, (foldsCase(pattern, fixed, f) ? 'i' : '') + (f.nullData ? 'm' : ''))
}

// What the walk keeps, the globs and types compiled; a glob or a type
// ripgrep refuses throws its words.
export function walkFilter(f: RgFlags, types?: FileTypes): WalkFilter {
  return new WalkFilter(
    new Overrides(f.globs, f.iglobs, f.globCaseInsensitive),
    types ?? new FileTypes(f.typeChanges, f.typeSelections),
    f.hidden,
    f.maxDepth,
    f.maxFilesize,
    f.binary,
  )
}

/**
 * Whether the answer depends on files a pattern search cannot find. A search
 * push-down narrows a walk to the files that contain the pattern, which
 * drops exactly the files -v, --files-without-match, --files, --passthru and
 * --include-zero answer for, so those keep the whole walk. So does
 * --max-filesize, which only a walk's stat can apply (a narrowed file is
 * searched as an operand, whatever its size), and a pattern file, whose
 * patterns the search never saw.
 */
export function needsEveryFile(fl: FlagView, f: RgFlags): boolean {
  const file = fl.raw('file')
  return (
    f.invert ||
    f.filesWithoutMatch ||
    f.listFiles ||
    f.passthru ||
    f.includeZero ||
    f.nullData ||
    f.maxFilesize !== null ||
    (Array.isArray(file) ? file.length > 0 : file !== undefined)
  )
}

/**
 * ripgrep's refusal of a search with no pattern, for a wrapper to answer
 * before it spends a request on one, or null to go on. Not for --files or
 * --type-list, which search nothing, nor when -f named a pattern file: an
 * empty one matches nothing.
 */
export function refuseMissingPattern(
  pattern: string | null,
  fl: FlagView,
  f: RgFlags,
): CommandFnResult | null {
  const file = fl.raw('file')
  if (pattern !== null || file !== undefined || f.listFiles || f.typeList) {
    return null
  }
  return usage(RG_NO_PATTERN)
}

// Whether -g, --iglob, -t or -T filter the files a walk searches.
export function filtersFiles(f: RgFlags): boolean {
  return f.globs.length > 0 || f.iglobs.length > 0 || f.typeSelections.length > 0
}

// A stdin operand's stat: a stream, never a directory to walk.
function fifoStat(path: string): FileStat {
  return new FileStat({ name: path, type: FileType.FIFO })
}

// The timestamp a --sort by time orders one haystack by.
function sortKey(h: Haystack, key: string): string | null {
  if (h.stat === null) return null
  if (key === 'modified') return h.stat.modified
  if (key === 'accessed') return h.stat.atime
  return null
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The haystacks in --sort/--sortr order, where that is a global one.
 * Ascending path order is the walk's own (each directory in name order,
 * operands as typed), so only --sortr path and the time keys reorder the
 * whole list. Like ripgrep, a haystack with no timestamp sorts after every
 * one that has one, and ties keep walk order.
 */
export function sortHaystacks(found: Haystack[], f: RgFlags): Haystack[] {
  if (f.sort === null || f.sort === 'none') return found
  if (f.sort === 'path') {
    if (!f.sortReverse) return found
    return [...found].sort((a, b) => compareStrings(b.shown, a.shown))
  }
  const key = f.sort
  const known = found.filter((h) => sortKey(h, key) !== null)
  const unknown = found.filter((h) => sortKey(h, key) === null)
  known.sort((a, b) => {
    const order = compareStrings(sortKey(a, key) ?? '', sortKey(b, key) ?? '')
    return f.sortReverse ? -order : order
  })
  return f.sortReverse ? [...unknown, ...known] : [...known, ...unknown]
}

function makeSpec(path: string, template: PathSpec): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    vfsPath: mountKey(path, mountPrefixOf(template.virtual, template.vfsPath)),
  })
}

function usage(message: string, exitCode = 2): CommandFnResult {
  return [null, new IOResult({ exitCode, stderr: ENC.encode(`${message}\n`) })]
}

/**
 * Run ripgrep-style search over backend paths or stdin. Interprets the flags
 * itself (Python `rg` parity), so backend wrappers only wire paths, texts,
 * the bag, and backend I/O. An empty `paths` searches stdin as an implicit
 * `-`.
 */
export async function rgGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: Stat,
  readdir: Readdir,
  stream: Stream,
): Promise<CommandFnResult> {
  // Every `-` operand reads stdin through one cursor, as grep's do. With no
  // operand typed, the implicit one below is stdin's sole reader, so a search
  // that stops early closes the input.
  stream = stdinStream(cacheAwareStream(stream), opts.stdin, paths.length === 0)
  const fl = new FlagView(opts.flags, specOf('rg'))
  const f = parseFlags(fl)
  const types = new FileTypes(f.typeChanges, f.typeSelections)
  if (f.typeList) return [formatRecords(typeListing(types.definitions)), new IOResult()]
  const walk = walkFilter(f, types)
  let pat: RegExp | null = null
  if (!f.listFiles) {
    const resolution = await resolvePattern(
      'rg',
      texts,
      opts.flags,
      paths,
      opts.mountPrefix,
      stream,
    )
    if (resolution.error !== null) {
      return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(resolution.error) })]
    }
    if (resolution.pattern === null) return usage(RG_NO_PATTERN)
    pat = rgMatcher(resolution.pattern, resolution.neverMatch, f)
  }
  // A line that names no path searches a piped stdin as an implicit `-`
  // operand, so -l, -H, -c and context answer as they do for a typed one
  // (ripgrep's Paths::from_low_args, 14.1.1).
  if (paths.length === 0) {
    if (opts.stdin === null) return usage(RG_NO_PATTERN)
    paths = [STDIN_OPERAND]
  }
  const [first = STDIN_OPERAND] = paths
  const mounts = opts.ns?.mounts
  const rd = mountParentReaddir((p: string) => readdir(makeSpec(p, first)), mounts)
  const st = mountParentStat((p: string) => stat(makeSpec(p, first)), mounts)
  if (pat !== null && paths.length === 1) {
    const single = await searchSingle(first, pat, f, st, rd, stream, opts.signal)
    if (single !== null) return single
  }
  const warnings: string[] = []
  // ripgrep's "nothing searched" speaks for the whole walk, so it waits while
  // a fan-out searches the mounts below the cwd in runs of its own.
  const implicit = paths.some(
    (p) =>
      p.rawPath === IMPLICIT_CWD &&
      (f.oneFileSystem || mounts === undefined || mounts.descendants(p.virtual).length === 0),
  )
  // A mount root below the operand shadows whatever the backend holds there;
  // the fan-out that would search the mount itself is off too.
  const boundary: Boundary =
    f.oneFileSystem && mounts !== undefined ? (p: string) => mounts.isRoot(p) : null
  let found = haystacks(paths, rd, st, opts.cwd, walk, f, warnings, boundary)
  if (f.sort !== null && f.sort !== 'none' && !(f.sort === 'path' && !f.sortReverse)) {
    const listed: Haystack[] = []
    for await (const h of found) listed.push(h)
    found = replay(sortHaystacks(listed, f))
  }
  if (f.listFiles) return listFiles(found, f, warnings)
  if (pat === null) return usage(RG_NO_PATTERN)
  return searchAll(found, paths, pat, f, stream, first, warnings, implicit, opts.signal)
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* replay(found: readonly Haystack[]): AsyncGenerator<Haystack> {
  for (const h of found) yield h
}

// One operand that is a file or stdin, streamed, or null for a directory the
// walk has to answer.
async function searchSingle(
  p: PathSpec,
  pat: RegExp,
  f: RgFlags,
  st: (path: string) => Promise<FileStat>,
  rd: (path: string) => Promise<string[]>,
  stream: Stream,
  signal?: AbortSignal,
): Promise<CommandFnResult | null> {
  if (!isStdin(p)) {
    let s: FileStat
    try {
      s = await st(p.virtual)
    } catch (err) {
      if (!isWalkError(err)) throw err
      try {
        await rd(p.virtual)
        return null
      } catch (inner) {
        if (!isWalkError(inner)) throw inner
        // Neither statable nor listable: ripgrep's own refusal rather than
        // the shared handler's exit 1.
        const stderr = f.noMessages
          ? null
          : ENC.encode(`rg: ${p.rawPath}: ${String(fsStrerror(err))}\n`)
        return [new Uint8Array(0), new IOResult({ exitCode: 2, stderr })]
      }
    }
    if (s.type === FileType.DIRECTORY) return null
  }
  const name = printedPath(operandName(p), f)
  const label = (f.withFilename || f.vimgrep) && !f.noFilename ? name : null
  const io = new IOResult({ exitCode: 1 })
  const tally: Tally = { selected: false }
  return [
    settled(searchHaystack(stream(p), pat, f, name, label, tally, signal), f, label, tally, io),
    io,
  ]
}

// One streamed haystack's output, headed when --heading names it, with the
// exit status settled as it goes.
async function* settled(
  chunks: AsyncIterable<Uint8Array>,
  f: RgFlags,
  label: string | null,
  tally: Tally,
  io: IOResult,
): AsyncGenerator<Uint8Array> {
  let printed = false
  for await (const chunk of chunks) {
    if (!printed && label !== null && headed(f))
      yield encodeLine(label + (f.null || f.nullData ? '\0' : '\n'))
    printed = true
    yield chunk
  }
  const listed = f.filesWithoutMatch && !f.quiet ? printed : null
  io.exitCode = (listed ?? tally.selected) ? 0 : 1
}

// Whether --heading names each file above its lines: only the line output
// has one, never the counts or the listings.
function headed(f: RgFlags): boolean {
  return (
    f.heading && !(f.countOnly || f.countMatches || f.filesOnly || f.filesWithoutMatch || f.quiet)
  )
}

// A path as ripgrep prints it, every `/` spelled as --path-separator asks.
export function printedPath(path: string, f: RgFlags): string {
  return f.pathSeparator === null ? path : path.replaceAll('/', f.pathSeparator)
}

// Whether a search walks into the mounts below its operand: not for
// --type-list, which reads no path, nor under --one-file-system.
export function walksDescendantMounts(bag: Record<string, FlagValue>): boolean {
  const fl = new FlagView(bag, specOf('rg'))
  return !(
    fl.asBool('type_list') ||
    last(fl, 'one_file_system', 'no_one_file_system') === 'one_file_system'
  )
}

/**
 * What ripgrep prints between one file's output and the next's, for output
 * split over several runs that each labelled their files: a blank line
 * between --heading groups; otherwise the context separator, when context is
 * shown and a separator is set; otherwise nothing. ripgrep 14.1.1 keeps this
 * inter-file separator newline-terminated under --null-data; only intra-file
 * context separators use the record terminator.
 */
export function betweenFiles(f: RgFlags): string {
  if (headed(f) && !f.noFilename) return '\n'
  if (printsContext(f) && f.contextSeparator !== null) return f.contextSeparator + '\n'
  return ''
}

// Every input the line searches, in order: a stdin operand, a named file as
// itself whatever the filters say, and a directory walked.
async function* haystacks(
  paths: readonly PathSpec[],
  rd: (path: string) => Promise<string[]>,
  st: (path: string) => Promise<FileStat>,
  cwd: string,
  walk: WalkFilter,
  f: RgFlags,
  warnings: string[],
  boundary: Boundary,
): AsyncGenerator<Haystack> {
  for (const p of paths) {
    if (isStdin(p)) {
      yield { virtual: p.virtual, shown: operandName(p), stat: fifoStat(p.rawPath), spec: p }
      continue
    }
    let isDir = false
    let s: FileStat | null = null
    try {
      s = await st(p.virtual)
      isDir = s.type === FileType.DIRECTORY
    } catch (err) {
      if (!isWalkError(err)) throw err
      try {
        // A directory that exists only because mounts sit under it answers
        // readdir but not stat.
        await rd(p.virtual)
        isDir = true
      } catch (inner) {
        if (!isWalkError(inner)) throw inner
        warnings.push(`rg: ${p.rawPath}: ${String(fsStrerror(err))}`)
        continue
      }
    }
    if (!isDir) {
      yield { virtual: p.virtual, shown: p.rawPath, stat: s, spec: p }
      continue
    }
    yield* walkHaystacks(
      rd,
      st,
      p.virtual,
      p.rawPath,
      cwd,
      walk,
      f.sort === 'path' && !f.sortReverse,
      warnings,
      boundary,
    )
  }
}

function stderrOf(records: readonly string[]): { stderr?: Uint8Array } {
  const stderr = formatOptionalRecords(records)
  return stderr === null ? {} : { stderr }
}

// --files: every path the search would read, and nothing searched.
async function listFiles(
  found: AsyncIterable<Haystack>,
  f: RgFlags,
  warnings: string[],
): Promise<CommandFnResult> {
  const term = f.null ? '\0' : '\n'
  const out: Uint8Array[] = []
  for await (const h of found) {
    out.push(encodeLine(printedPath(h.shown, f) + term))
    if (f.quiet) break
  }
  const code = exitCodeFor(out.length > 0, warnings.length > 0, f.quiet)
  const body = f.quiet ? new Uint8Array(0) : concat(out)
  return [body, new IOResult({ exitCode: code, ...stderrOf(f.noMessages ? [] : warnings) })]
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/**
 * Search every haystack in order and put the output together. ripgrep labels
 * every line when the line named more than one path or walked a directory;
 * -H forces the label and -I drops it. Between one file's context and the
 * next file's goes the context separator, and under --heading a blank line
 * goes between files instead. `implicit` says the line named no path, so
 * ripgrep reports a search that found nothing to search.
 */
async function searchAll(
  found: AsyncIterable<Haystack>,
  paths: readonly PathSpec[],
  pat: RegExp,
  f: RgFlags,
  stream: Stream,
  template: PathSpec,
  warnings: string[],
  implicit: boolean,
  signal?: AbortSignal,
): Promise<CommandFnResult> {
  const multi = paths.length > 1
  const context = printsContext(f)
  const out: Uint8Array[] = []
  let printed = false
  let selected = false
  let searched = 0
  for await (const h of found) {
    searched += 1
    const walked = h.spec === null
    const name = printedPath(h.shown, f)
    const label = !f.noFilename && (walked || multi || f.withFilename || f.vimgrep) ? name : null
    const tally: Tally = { selected: false }
    const chunks: Uint8Array[] = []
    try {
      const source = stream(h.spec ?? makeSpec(h.virtual, template))
      for await (const c of searchHaystack(source, pat, f, name, label, tally, signal)) {
        chunks.push(c)
      }
    } catch (err) {
      if (!isFsError(err)) throw err
      // ripgrep reports the failed input and keeps searching the rest.
      warnings.push(`rg: ${h.shown}: ${String(fsStrerror(err))}`)
      continue
    }
    selected ||= tally.selected
    if (chunks.length > 0) {
      if (label !== null && headed(f)) {
        if (printed) out.push(ENC.encode('\n'))
        out.push(encodeLine(label + (f.null || f.nullData ? '\0' : '\n')))
      } else if (context && printed && f.contextSeparator !== null) {
        out.push(encodeLine(f.contextSeparator + '\n'))
      }
      out.push(...chunks)
      printed = true
    }
    if (f.quiet && tally.selected) break
  }
  // ripgrep's status under --files-without-match follows the listing, not
  // the matching: 0 when a file was listed, 1 when every file matched
  // (14.1.1; GNU grep keeps the match status).
  if (f.filesWithoutMatch && !f.quiet) selected = printed
  let code = exitCodeFor(selected, warnings.length > 0, f.quiet)
  const shown = f.noMessages ? [] : [...warnings]
  if (implicit && searched === 0) {
    // An error whatever --no-messages says, which only silences it.
    if (!f.noMessages) shown.push(NOTHING_SEARCHED)
    code = 2
  }
  return [concat(out), new IOResult({ exitCode: code, ...stderrOf(shown) })]
}

// The flags with -H added, unless -I is the line's last word on it.
export function labelFlags(bag: Record<string, FlagValue>): Record<string, FlagValue> {
  const flags = { ...bag }
  flagOccurrences(flags).push(...flagOccurrences(bag))
  if (filenameFlag(new FlagView(bag, specOf('rg'))) !== 'no_filename') flags.with_filename = true
  return flags
}

/**
 * Ask for the filename a walk would have printed on its own. A content
 * search hands the generic explicit files where the user named a directory,
 * and the generic labels explicit operands only when there are several, so
 * -H is requested here; an -I the line set after any -H still wins, since
 * forcing -H under it would defeat the suppression in the delegated scan.
 */
export function labelled(opts: CommandOpts): CommandOpts {
  if (filenameFlag(new FlagView(opts.flags, specOf('rg'))) === 'no_filename') return opts
  return { ...opts, flags: labelFlags(opts.flags) }
}
