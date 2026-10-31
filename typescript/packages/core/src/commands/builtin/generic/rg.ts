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

import { GzipDataError, gunzipStream } from '../../../utils/compress.ts'
import { mountParentReaddir, mountParentStat, toPathspec } from '../utils/wrap.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { MountView } from '../../../view/types.ts'
import { FileStat, FileType, LineFacts, type PathSpec } from '../../../types.ts'
import { enoent, isFsError, isWalkError, walkRefusal } from '../../../errors/fs.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { WalkLimitError } from '../../../errors/types.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView, flagOccurrences } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { decodeText, encodeText, textView } from '../../../shell/bytes.ts'
import { scanned } from '../../../rs/scan.ts'
import { resolvePattern } from '../grep_pattern.ts'
import { exitCodeFor } from '../grep_scan.ts'
import { FileTypes, typeListing, type TypeChange, type TypeSelection } from '../rg_filetypes.ts'
import { IgnoreRules, Overrides, Verdict, walkCandidate } from '../rg_glob.ts'
import { shellJoin } from '../../../shell/join.ts'
import type { DispatchFn, ShellFn } from '../../../runtime/types.ts'
import {
  osErrorText,
  type Haystack,
  WalkFilter,
  onOtherMount,
  openErrorLine,
  walkErrorLine,
  walkHaystacks,
} from '../rg_scan.ts'
import { Totals, recordEnd, printsContext, type RgFlags, type Tally } from '../rg_search.ts'
import {
  type RgProgram,
  formatOutput,
  formatMessage,
  latin1,
  openRg,
  streamHaystack,
  totalsConfig,
} from '../rg_stream.ts'
import { OutputStream, ensureStream } from '../../../io/stream.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { type LinkResolver, linkResolver, mountsOf, dispatchOf, mountRoot } from '../utils/links.ts'
import { formatRecords } from '../utils/output.ts'
import { isStdin, stdinStream } from '../utils/stream.ts'
import { concat } from '../../../utils/bytes.ts'
import { NOT_FOUND_STATUS } from '../../../shell/constants.ts'

const ENC = new TextEncoder()
// ripgrep's own words for a line with no pattern, exit 2 (14.1.1).
export const RG_NO_PATTERN = 'rg: ripgrep requires at least one pattern to execute a search'
// The names -z searches decompressed, and the rule ripgrep frames gzip's
// refusal in (14.1.1).
const GZIP_NAMES = ['.gz', '.tgz']
const GZIP_RULE = '-'.repeat(79)
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
// The options whose values mirage-rs reads, with the switches that decide
// among them.
const SCANNED = [
  'threads',
  'encoding',
  'no_encoding',
  'color',
  'colors',
  'hyperlink_format',
  'dfa_size_limit',
  'regex_size_limit',
  'passthru',
  'passthrough',
  'after_context',
  'before_context',
  'context',
  'sort',
  'sortr',
  'sort_files',
  'no_sort_files',
  'pcre2',
  'no_pcre2',
  'engine',
  'auto_hybrid_regex',
  'no_auto_hybrid_regex',
  'max_columns',
  'path_separator',
  'max_count',
  'max_depth',
  'max_filesize',
  'context_separator',
  'no_context_separator',
  'field_match_separator',
  'field_context_separator',
]

/**
 * What rg's scan reads, every value checked as ripgrep 14.1.1 checks it. The
 * separators are byte views, and null where the line asks for none
 * (--no-context-separator) or for ripgrep's own. Mirrors Python's `RgValues`.
 */
export interface RgValues {
  readonly threads: number | null
  readonly encoding: string
  readonly dfa_size_limit: number | null
  readonly regex_size_limit: number | null
  readonly passthru: boolean
  readonly context_before: number
  readonly context_after: number
  readonly sort: string | null
  readonly sort_reverse: boolean
  readonly engine: string
  readonly max_columns: number | null
  readonly path_separator: string | null
  readonly max_count: number | null
  readonly max_depth: number | null
  readonly max_filesize: number | null
  readonly context_separator: string | null
  readonly field_match_separator: string
  readonly field_context_separator: string
}
type Stat = (p: PathSpec) => Promise<FileStat>
type Readdir = (p: PathSpec) => Promise<string[]>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

export type { RgFlags } from '../rg_search.ts'

// The name ripgrep prints for an operand. `-` is `<stdin>`; `/dev/stdin`
// reads the same bytes, but ripgrep opens it as the path it is and names it
// as typed.
function operandName(p: PathSpec): string {
  return p.rawPath === '-' ? STDIN_NAME : p.rawPath
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

// How rg treats a binary file, the last word of its group deciding: `text`
// under -a, which searches every byte as text; `binary` under --binary or
// -uuu, which searches what a walk would skip but still reports a binary
// match by its notice; `auto` otherwise, and after --no-text or --no-binary.
// Mirrors Python's _binary_mode.
function binaryModeOf(fl: FlagView, unrestricted: number): 'auto' | 'binary' | 'text' {
  let mode: 'auto' | 'binary' | 'text' = 'auto'
  for (const name of fl.typedOrder('text', 'no_text', 'binary', 'no_binary', 'unrestricted')) {
    if (name === 'unrestricted') {
      if (unrestricted >= 3 && mode === 'auto') mode = 'binary'
    } else {
      mode = name === 'text' ? 'text' : name === 'binary' ? 'binary' : 'auto'
    }
  }
  return mode
}

/**
 * Convert the raw flag bag into RgFlags, the only string-keyed reads.
 * Options that override one another are read in line order, the last one
 * winning as it does in ripgrep: -i/-s/-S, -w/-x, -n/-N, -H/-I, every option
 * and its --no- negation, --hidden/--no-hidden/-uu, the output modes
 * -c/--count-matches/-l/--files-without-match, --heading/--no-heading,
 * --passthru and the context options, --sort/--sortr/--sort-files/
 * --no-sort-files, and --context-separator/--no-context-separator. Every
 * value is read by mirage-rs (`RgValues`), and one ripgrep refuses throws its
 * words. Mirrors Python's `parse_flags`.
 */
export function parseFlags(fl: FlagView): RgFlags {
  const values = scanned('rg', fl.texts(...SCANNED)) as unknown as RgValues
  const caseMode = last(fl, 'ignore_case', 'case_sensitive', 'smart_case')
  const bounds = last(fl, 'word_regexp', 'line_regexp')
  const listing = last(fl, 'count', 'count_matches', 'files_with_matches', 'files_without_match')
  // -p turns on --heading and -n, each overridden by a later negation.
  const numbers = last(fl, 'line_number', 'no_line_number', 'pretty')
  const vimgrep = fl.asBool('vimgrep')
  const columns = last(fl, 'column', 'no_column')
  const column = columns !== null ? columns === 'column' : vimgrep
  // --json prints its own records: no heading or separators, and line
  // numbers unless -N turned them off.
  const jsonRecords = last(fl, 'json', 'no_json') === 'json'
  const preCommand = last(fl, 'pre', 'no_pre') === 'pre' ? (fl.asStr('pre') ?? '') : ''
  const unrestricted = fl.asInt('unrestricted') ?? 0
  const binaryMode = binaryModeOf(fl, unrestricted)
  let hidden = false
  for (const name of fl.typedOrder('hidden', 'no_hidden', 'unrestricted')) {
    if (name === 'hidden') hidden = fl.asBool(name)
    else if (name === 'no_hidden') hidden = !fl.asBool(name) && hidden
    else if (unrestricted >= 2) hidden = true
  }
  const separator = values.context_separator
  const pathSeparator = values.path_separator
  const selections: TypeSelection[] = []
  for (const [name, value] of fl.occurrences('type', 'type_not')) {
    if (typeof value === 'string') selections.push([value, name === 'type_not'])
  }
  const changes: TypeChange[] = []
  for (const [name, value] of fl.occurrences('type_clear', 'type_add')) {
    if (typeof value === 'string') changes.push([name === 'type_clear' ? 'clear' : 'add', value])
  }
  return {
    engine: values.engine,
    unicode: !['no_unicode', 'no_pcre2_unicode'].includes(
      last(fl, 'unicode', 'no_unicode', 'pcre2_unicode', 'no_pcre2_unicode') ?? '',
    ),
    ignoreCase: caseMode === 'ignore_case',
    smartCase: caseMode === 'smart_case',
    invert: last(fl, 'invert_match', 'no_invert_match') === 'invert_match',
    wholeWord: bounds === 'word_regexp',
    lineRegexp: bounds === 'line_regexp',
    fixedString: last(fl, 'fixed_strings', 'no_fixed_strings') === 'fixed_strings',
    lineNumbers: numbers !== null ? numbers !== 'no_line_number' : column || vimgrep || jsonRecords,
    column,
    vimgrep,
    byteOffsets: last(fl, 'byte_offset', 'no_byte_offset') === 'byte_offset',
    onlyMatching: fl.asBool('only_matching'),
    replace: fl.asStr('replace') ?? null,
    trim: last(fl, 'trim', 'no_trim') === 'trim',
    maxColumns: values.max_columns,
    maxColumnsPreview:
      last(fl, 'max_columns_preview', 'no_max_columns_preview') === 'max_columns_preview',
    null: fl.asBool('null'),
    nullData: fl.asBool('null_data'),
    crlf: last(fl, 'crlf', 'no_crlf') === 'crlf' && !fl.asBool('null_data'),
    multiline: last(fl, 'multiline', 'no_multiline', 'stop_on_nonmatch') === 'multiline',
    stats: last(fl, 'stats', 'no_stats') === 'stats',
    searchZip: last(fl, 'search_zip', 'no_search_zip') === 'search_zip',
    // --pre with no command, or after --no-pre, preprocesses nothing.
    pre: preCommand === '' ? null : preCommand,
    preGlobs: fl.asList('pre_glob'),
    json: jsonRecords,
    multilineDotall: last(fl, 'multiline_dotall', 'no_multiline_dotall') === 'multiline_dotall',
    pathSeparator: pathSeparator === null ? null : textView(pathSeparator),
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
    heading:
      ['heading', 'pretty'].includes(last(fl, 'heading', 'no_heading', 'pretty') ?? '') &&
      !vimgrep &&
      !jsonRecords,
    passthru: values.passthru,
    maxCount: values.max_count,
    stopOnNonmatch: last(fl, 'stop_on_nonmatch', 'multiline') === 'stop_on_nonmatch',
    contextAfter: values.context_after,
    contextBefore: values.context_before,
    contextSeparator: separator === null || jsonRecords ? null : textView(separator),
    fieldMatchSeparator: textView(values.field_match_separator),
    fieldContextSeparator: textView(values.field_context_separator),
    globs: fl.asList('glob'),
    iglobs: fl.asList('iglob'),
    globCaseInsensitive:
      last(fl, 'glob_case_insensitive', 'no_glob_case_insensitive') === 'glob_case_insensitive',
    typeChanges: changes,
    typeSelections: selections,
    hidden,
    maxDepth: values.max_depth,
    maxFilesize: values.max_filesize,
    follow: last(fl, 'follow', 'no_follow') === 'follow',
    oneFileSystem: last(fl, 'one_file_system', 'no_one_file_system') === 'one_file_system',
    binary: binaryMode !== 'auto',
    sort: values.sort,
    sortReverse: values.sort_reverse,
    noMessages: last(fl, 'no_messages', 'messages') === 'no_messages',
    threads: values.threads,
    text: binaryMode === 'text',
    encoding: values.encoding,
    regexSizeLimit: values.regex_size_limit,
    dfaSizeLimit: values.dfa_size_limit,
  }
}

// What the walk keeps, the globs and types compiled; a glob or a type
// ripgrep refuses throws its words.
export function walkFilter(f: RgFlags, types?: FileTypes, ignores?: IgnoreRules): WalkFilter {
  return new WalkFilter(
    new Overrides(f.globs, f.iglobs, f.globCaseInsensitive),
    types ?? new FileTypes(f.typeChanges, f.typeSelections),
    f.hidden,
    f.maxDepth,
    f.maxFilesize,
    f.binary,
    ignores ?? new IgnoreRules(),
  )
}

/**
 * --ignore-file's rules, each file read through the dispatcher. A file
 * ripgrep cannot read is reported in `notes` and skipped, the search going on
 * with its exit status untouched (14.1.1); --no-ignore-files drops every one.
 * Mirrors Python's ignore_rules.
 */
export async function ignoreRules(
  fl: FlagView,
  dispatch: DispatchFn | undefined,
  notes: string[],
): Promise<IgnoreRules> {
  if (last(fl, 'ignore_files', 'no_ignore_files') === 'no_ignore_files') return new IgnoreRules()
  const lines: string[] = []
  for (const path of fl.asPaths('ignore_file')) {
    try {
      if (dispatch === undefined) throw enoent(path.rawPath)
      const [data] = await dispatch('read', path)
      for (const item of decodeText(await materialize(data as ByteSource)).split(/\r?\n/))
        lines.push(item)
    } catch (err) {
      if (!isFsError(err)) throw err
      notes.push(`rg: ${path.rawPath}: ${osErrorText(err)}`)
    }
  }
  return new IgnoreRules(lines)
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

function usage(message: string, exitCode = 2): CommandFnResult {
  return [null, new IOResult({ exitCode, stderr: ENC.encode(`${message}\n`) })]
}

/**
 * Run ripgrep-style search over backend paths or stdin. Interprets the flags
 * itself (Python `rg` parity), so backend wrappers only wire paths, texts,
 * the bag, and backend I/O. An empty `paths` searches stdin as an implicit
 * `-`. `unbounded` is the walk to take when no `--max-depth` bounds it (one
 * the mount answers whole), else `readdir` and `stat`.
 */
export async function rgGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stat: Stat,
  readdir: Readdir,
  stream: Stream,
  unbounded?: [Readdir, Stat],
): Promise<CommandFnResult> {
  // Every `-` operand reads stdin through one cursor, as grep's do. With no
  // operand typed, the implicit one below is stdin's sole reader, so a search
  // that stops early closes the input.
  stream = stdinStream(stream, ctx.stdin, paths.length === 0)
  const fl = new FlagView(ctx.flags, specOf('rg'))
  const f = parseFlags(fl)
  if (unbounded !== undefined && f.maxDepth === null) [readdir, stat] = unbounded
  const types = new FileTypes(f.typeChanges, f.typeSelections)
  if (f.typeList) return [formatRecords(typeListing(types.definitions)), new IOResult()]
  const notes: string[] = []
  const walk = walkFilter(f, types, await ignoreRules(fl, dispatchOf(ctx), notes))
  let pat: RgProgram | null = null
  if (!f.listFiles) {
    const resolution = await resolvePattern('rg', texts, fl, stream)
    if (resolution.error !== null) {
      return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(resolution.error) })]
    }
    if (resolution.pattern === null) return usage(RG_NO_PATTERN)
    pat = await openRg(
      resolution.pattern,
      resolution.neverMatch,
      f,
      f.regexSizeLimit ?? null,
      f.dfaSizeLimit ?? null,
    )
  }
  try {
    // A line that names no path searches a piped stdin as an implicit `-`
    // operand, so -l, -H, -c and context answer as they do for a typed one
    // (ripgrep's Paths::from_low_args, 14.1.1).
    if (paths.length === 0) {
      if (ctx.stdin === null) {
        pat?.stream.close()
        return usage(RG_NO_PATTERN)
      }
      paths = [STDIN_OPERAND]
    }
    const [first = STDIN_OPERAND] = paths
    const mounts = mountsOf(ctx)
    const rd = mountParentReaddir((p: string) => readdir(toPathspec(p)), mounts, mountRoot(ctx))
    const st = mountParentStat((p: string) => stat(toPathspec(p)), mounts)
    if (
      pat !== null &&
      paths.length === 1 &&
      f.stats !== true &&
      f.json !== true &&
      f.searchZip !== true &&
      (f.pre ?? null) === null
    ) {
      const single = await searchSingle(first, pat, f, st, rd, stream, ctx.signal)
      if (single !== null) return await noted(owned(pat, single), notes, f)
    }
    const warnings: string[] = []
    // ripgrep's "nothing searched" speaks for the whole walk, so it waits while
    // a fan-out searches the mounts below the cwd in runs of its own. A typed ''
    // shares the synthetic operand's spelling; the walk's verdict is what tells
    // them apart.
    const implicit = paths.some(
      (p) =>
        p.rawPath === IMPLICIT_CWD &&
        p.walkError === null &&
        (f.oneFileSystem || mounts === undefined || mounts.descendants(p.virtual).length === 0),
    )
    // A mount below the operand shadows whatever the backend holds there; the
    // fan-out that would search the mount itself is off too.
    const boundary = f.oneFileSystem ? (mounts ?? null) : null
    const stopped = new Set<string>()
    let found = haystacks(
      paths,
      rd,
      st,
      ctx.cwd.virtual,
      walk,
      f,
      warnings,
      boundary,
      linkResolver(ctx),
      stopped,
    )
    if (f.sort !== null && f.sort !== 'none' && !(f.sort === 'path' && !f.sortReverse)) {
      const listed: Haystack[] = []
      for await (const h of found) listed.push(h)
      found = replay(sortHaystacks(listed, f))
    }
    const io = new IOResult()
    const out =
      pat === null
        ? listFiles(found, f, warnings, io)
        : searchAll(
            found,
            paths,
            pat,
            f,
            stream,
            warnings,
            implicit,
            ctx.cwd.virtual,
            io,
            stopped,
            ctx.signal,
            ctx.shell,
          )
    return await noted(owned(pat, [out, io]), notes, f)
  } catch (error) {
    pat?.stream.close()
    throw error
  }
}

function owned(
  pat: RgProgram | null,
  result: [ByteSource | null, IOResult],
): [ByteSource | null, IOResult] {
  if (pat === null) return result
  const [output, io] = result
  if (output === null || output instanceof Uint8Array) {
    pat.stream.close()
    return result
  }
  const source = ensureStream(output)[Symbol.asyncIterator]()
  return [
    new OutputStream(source, async () => {
      try {
        await source.return?.()
      } finally {
        pat.stream.close()
      }
    }),
    io,
  ]
}

// A search's result with --ignore-file's notes ahead of its stderr, as
// ripgrep prints them before it searches.
async function noted(
  result: [ByteSource | null, IOResult],
  notes: readonly string[],
  f: RgFlags,
): Promise<[ByteSource | null, IOResult]> {
  const [out, io] = result
  if (notes.length > 0 && !f.noMessages)
    io.stderr = concat([
      formatRecords(notes),
      io.stderr === null ? new Uint8Array() : await materialize(io.stderr),
    ])
  return [out, io]
}

// gzip's output up to where its input is damaged, the damage kept in
// `faults`: ripgrep searches what gzip wrote before it failed.
async function* upToDamage(
  source: AsyncIterable<Uint8Array>,
  faults: GzipDataError[],
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of source) yield chunk
  } catch (err) {
    if (!(err instanceof GzipDataError)) throw err
    faults.push(err)
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* replay(found: readonly Haystack[]): AsyncGenerator<Haystack> {
  for (const h of found) yield h
}

// ripgrep's own refusal of an operand it cannot open, exit 2 rather than the
// shared handler's 1.
function refused(line: string, f: RgFlags): CommandFnResult {
  const stderr = f.noMessages ? null : ENC.encode(`${line}\n`)
  return [new Uint8Array(0), new IOResult({ exitCode: 2, stderr })]
}

// One operand that is a file or stdin, streamed, or null for a directory the
// walk has to answer.
async function searchSingle(
  p: PathSpec,
  pat: RgProgram,
  f: RgFlags,
  st: (path: string) => Promise<FileStat>,
  rd: (path: string) => Promise<string[]>,
  stream: Stream,
  signal?: AbortSignal,
): Promise<CommandFnResult | null> {
  if (!isStdin(p)) {
    // The probes below go by `virtual`, which cannot carry the walk's verdict:
    // the empty name would read as the cwd and walk it.
    if (p.walkError !== null) return refused(walkErrorLine(p.rawPath, walkRefusal(p)), f)
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
        return refused(walkErrorLine(p.rawPath, err), f)
      }
    }
    if (s.type === FileType.DIRECTORY) return null
  }
  const name = printedPath(operandName(p), f)
  const label = (f.withFilename || f.vimgrep) && !f.noFilename ? name : null
  const io = new IOResult({ exitCode: 1 })
  const tally: Tally = { selected: false }
  return [
    settled(
      streamHaystack(stream(p), pat, f, name, label, tally, signal, true, isStdin(p)),
      f,
      label,
      tally,
      io,
      p.rawPath,
      name,
      pat,
    ),
    io,
  ]
}

// One streamed haystack's output, headed when --heading names it, with the
// exit status settled however the output ends.
async function* settled(
  chunks: AsyncIterable<Uint8Array>,
  f: RgFlags,
  label: string | null,
  tally: Tally,
  io: IOResult,
  // The operand as typed, which a failed read names.
  shown: string,
  // The haystack as rg prints it, which a search that gave up names.
  name: string,
  program: RgProgram,
): AsyncGenerator<Uint8Array> {
  let printed = false
  let failed = false
  try {
    for await (const chunk of chunks) {
      const heading = printed ? null : lead(f, label, false, tally.binary === true, program)[1]
      if (heading !== null && heading.length > 0) yield heading
      printed = true
      yield chunk
    }
  } catch (err) {
    if (!isFsError(err)) throw err
    // A read that fails once the stream is open is the searcher's to report,
    // exit 2, as ripgrep reports it for any file it searches.
    failed = true
    io.stderr = f.noMessages ? null : ENC.encode(`${openErrorLine(shown, err)}\n`)
    io.exitCode = 2
  } finally {
    if (tally.error !== undefined && !failed) {
      // A -P search that gave up ends the file with PCRE2's error.
      failed = true
      if (!f.noMessages) io.stderr = ENC.encode(`rg: ${name}: ${tally.error}\n`)
      io.exitCode = 2
    }
    const listed = f.filesWithoutMatch && !f.quiet ? printed : null
    if (!failed) io.exitCode = (listed ?? tally.selected) ? 0 : 1
  }
}

// Whether --json writes its records and the summary: only for the printing
// modes, -c and -l printing as they do without it.
export function jsonSummary(f: RgFlags): boolean {
  return f.json === true && !(f.countOnly || f.countMatches || f.filesOnly || f.filesWithoutMatch)
}

// Whether --heading names each file above its lines: only the line output
// has one, never the counts or the listings.
export function headed(f: RgFlags): boolean {
  return (
    f.heading && !(f.countOnly || f.countMatches || f.filesOnly || f.filesWithoutMatch || f.quiet)
  )
}

// Whether ripgrep searches more than one path on its parallel searcher: -j1
// and a sort hold it to one thread.
export function runsParallel(f: RgFlags): boolean {
  return f.threads !== 1 && (f.sort === null || f.sort === 'none')
}

// A path as ripgrep prints it, every `/` spelled as --path-separator asks.
export function printedPath(path: string, f: RgFlags): string {
  return f.pathSeparator === null ? path : path.replaceAll('/', f.pathSeparator)
}

export function betweenFiles(f: RgFlags): string {
  return decodeText(lead(f, null, true, false)[0])
}

function lead(
  f: RgFlags,
  label: string | null,
  printed: boolean,
  binary: boolean,
  program?: RgProgram,
): [Uint8Array, Uint8Array] {
  const message = {
    kind: 'lead',
    heading: f.heading,
    summary: f.countOnly || f.countMatches || f.filesOnly || f.filesWithoutMatch || f.quiet,
    no_filename: f.noFilename,
    context: printsContext(f),
    separator: f.contextSeparator === null ? null : latin1(f.contextSeparator),
    label: label === null ? null : latin1(label),
    terminator: latin1(recordEnd(f)),
    null: f.null,
    printed,
    binary,
  }
  const [gap, heading] = JSON.parse(
    decodeText(program === undefined ? formatMessage(message) : formatOutput(program, message)),
  ) as [number[], number[]]
  return [new Uint8Array(gap), new Uint8Array(heading)]
}

// Every input the line searches, in order: a stdin operand, a named file as
// itself whatever the filters say, and a directory walked. `boundary` is the
// mounts --one-file-system keeps each walk to its operand's own, null when
// the walk may enter any directory; `resolver` the namespace's links and the
// dispatcher past them, which -L walks through; `stopped` the directories a
// search stopped at their mount's `walkLimit`, whose walk ends there.
export async function* haystacks(
  paths: readonly PathSpec[],
  rd: (path: string) => Promise<string[]>,
  st: (path: string) => Promise<FileStat>,
  cwd: string,
  walk: WalkFilter,
  f: RgFlags,
  warnings: string[],
  boundary: MountView | null,
  resolver: LinkResolver | null,
  stopped: ReadonlySet<string>,
): AsyncGenerator<Haystack> {
  // ripgrep holds one path that is not a directory to one thread, as it
  // does -j1 and a sort; every other line runs its parallel walker.
  const parallel = runsParallel(f)
  const several = parallel && paths.length > 1
  for (const p of paths) {
    if (isStdin(p)) {
      yield {
        virtual: p.virtual,
        shown: operandName(p),
        stat: fifoStat(p.rawPath),
        spec: p,
        resolver: null,
      }
      continue
    }
    if (p.walkError !== null) {
      warnings.push(walkErrorLine(p.rawPath, walkRefusal(p), several))
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
        warnings.push(walkErrorLine(p.rawPath, err, several))
        continue
      }
    }
    if (!isDir) {
      yield { virtual: p.virtual, shown: p.rawPath, stat: s, spec: p, resolver: null }
      continue
    }
    let crosses: ((path: string) => boolean) | null = null
    if (boundary !== null) {
      const home = boundary.rootOf(p.virtual)
      crosses = (path) => onOtherMount((q) => boundary.rootOf(q), home, path)
    }
    for await (const found of walkHaystacks(
      rd,
      st,
      p.virtual,
      p.rawPath,
      cwd,
      walk,
      f.sort === 'path' && !f.sortReverse,
      warnings,
      crosses,
      resolver,
      f.follow,
      parallel,
    )) {
      yield found
      if (stopped.has(p.virtual)) break
    }
  }
}

// --files: every path the search would read, and nothing searched.
async function* listFiles(
  found: AsyncIterable<Haystack>,
  f: RgFlags,
  warnings: string[],
  io: IOResult,
): AsyncIterable<Uint8Array> {
  const term = f.null ? '\0' : '\n'
  let selected = false
  try {
    for await (const h of found) {
      selected = true
      if (f.quiet) break
      yield encodeText(printedPath(h.shown, f) + term)
    }
  } finally {
    io.exitCode = exitCodeFor(selected, warnings.length > 0, f.quiet)
    if (warnings.length > 0 && !f.noMessages)
      io.stderr = concat([await materialize(io.stderr), formatRecords(warnings)])
  }
}

/**
 * What --pre's command prints for one file, or ripgrep's report of why it
 * failed: it runs `COMMAND PATH` with the file's contents on stdin, here as a
 * line in the session. Mirrors Python's preprocessed.
 */
async function preprocessed(
  command: string,
  path: string,
  name: string,
  data: Uint8Array,
  shell?: ShellFn,
): Promise<[Uint8Array, string | null]> {
  const shown = [command, path].map((word) => `"${word}"`).join(' ')
  const head = `rg: ${name}: preprocessor command`
  const io = shell === undefined ? null : await shell(shellJoin([command, path]), data)
  if (io === null || io.exitCode === NOT_FOUND_STATUS)
    return [
      new Uint8Array(),
      `${head} could not start: '${shown}': No such file or directory (os error 2)`,
    ]
  if (io.exitCode !== 0) {
    const err = io.stderr === null ? '' : decodeText(await materialize(io.stderr))
    const body = err ? `\n${GZIP_RULE}\n${err}${GZIP_RULE}` : '<stderr is empty>'
    return [new Uint8Array(), `${head} failed: '${shown}': ${body}`]
  }
  return [io.stdout === null ? new Uint8Array() : await materialize(io.stdout), null]
}

/**
 * Search every haystack in order and put the output together. ripgrep labels
 * every line when the line named more than one path or walked a directory;
 * -H forces the label and -I drops it. Between one file's context and the
 * next file's goes the context separator, and under --heading a blank line
 * goes between files instead. `implicit` says the line named no path, so
 * ripgrep reports a search that found nothing to search.
 */
async function* searchAll(
  found: AsyncIterable<Haystack>,
  paths: readonly PathSpec[],
  pat: RgProgram,
  f: RgFlags,
  stream: Stream,
  warnings: string[],
  implicit: boolean,
  // The session's working directory, which --pre-glob's globs are rooted at.
  cwd: string,
  // Receives the exit status and the warnings, however the output ends.
  io: IOResult,
  // Collects each directory whose walk a read stopped at its mount's
  // `walkLimit`.
  stopped: Set<string>,
  signal?: AbortSignal,
  // Runs --pre's command in the session.
  shell?: ShellFn,
): AsyncIterable<Uint8Array> {
  const multi = paths.length > 1
  let lone = !multi
  const preGlobs = new Overrides(f.preGlobs ?? [], [], false)
  const progressive = f.stats !== true && f.json !== true && f.searchZip !== true
  let printed = false
  let selected = false
  let skipped = false
  let searched = 0
  const listingOrCount = f.countOnly || f.countMatches || f.filesOnly || f.filesWithoutMatch
  const records = jsonSummary(f)
  const totals = new Totals()
  const started = performance.now()
  try {
    for await (const h of found) {
      searched += 1
      const walked = h.spec === null
      lone = lone && !walked
      const name = printedPath(h.shown, f)
      const label = !f.noFilename && (walked || multi || f.withFilename || f.vimgrep) ? name : null
      const tally: Tally = { selected: false }
      const chunks: Uint8Array[] = []
      let filePrinted = false
      let damaged = false
      const faults: GzipDataError[] = []
      const began = performance.now()
      try {
        const opened =
          h.spec === null && h.resolver !== null
            ? h.resolver.read(h.virtual)
            : stream(h.spec ?? toPathspec(h.virtual))
        const pipe = h.spec !== null && isStdin(h.spec)
        let source = opened
        const pre = f.pre ?? null
        if (
          pre !== null &&
          !pipe &&
          preGlobs.verdict(walkCandidate(h.shown, cwd), false) !== Verdict.IGNORE
        ) {
          const [text, refusal] = await preprocessed(
            pre,
            h.shown,
            name,
            await materialize(opened),
            shell,
          )
          if (refusal !== null) {
            warnings.push(refusal)
            continue
          }
          source = ensureStream(text)
        } else if (
          f.searchZip === true &&
          GZIP_NAMES.some((ext) => h.virtual.endsWith(ext)) &&
          !pipe
        ) {
          source = upToDamage(gunzipStream(opened), faults)
        }
        for await (const c of streamHaystack(
          source,
          pat,
          f,
          name,
          label,
          tally,
          signal,
          !walked,
          pipe,
        )) {
          if (!progressive) {
            chunks.push(c)
            continue
          }
          if (!filePrinted) {
            const before = concat(lead(f, label, printed, tally.binary === true, pat))
            if (before.length > 0) yield before
            filePrinted = printed = true
          }
          selected ||= tally.selected
          yield c
        }
        const [fault] = faults
        if (fault !== undefined) throw fault
      } catch (err) {
        if (err instanceof GzipDataError) {
          // -z runs gzip, whose refusal ripgrep frames in rules. gzip's output
          // streams into the search, so the lines it decoded before the damage
          // still print, but not what ripgrep writes once the file is done (a
          // count, --files-without-match), and the file adds to no total.
          warnings.push(`rg: ${name}: \n${GZIP_RULE}\n${err.render(name).trimStart()}${GZIP_RULE}`)
          damaged = true
          if (f.countOnly || f.countMatches || f.filesWithoutMatch) chunks.length = 0
        } else if (err instanceof WalkLimitError) {
          if (!stopped.has(err.directory.virtual)) {
            stopped.add(err.directory.virtual)
            warnings.push(`rg: ${err.message}`)
          }
          continue
        } else {
          if (!isFsError(err)) throw err
          // ripgrep reports the failed input and keeps searching the rest.
          warnings.push(openErrorLine(h.shown, err))
          continue
        }
      }
      if (tally.error !== undefined) {
        warnings.push(`rg: ${name}: ${tally.error}`)
        damaged = true
      }
      const elapsed = (performance.now() - began) / 1000
      selected ||= tally.selected
      skipped ||= tally.skipped === true
      if (records) {
        if (chunks.length > 0) {
          const begin = formatOutput(pat, { kind: 'begin', name: latin1(name) })
          const sent = begin.length + chunks.reduce((sum, c) => sum + c.length, 0)
          yield begin
          yield* chunks
          if (!damaged) {
            totals.add(tally, sent, elapsed)
            yield formatOutput(pat, {
              kind: 'end',
              name: latin1(name),
              nul: tally.nul ?? null,
              selected: tally.selected,
              matches: tally.matches ?? 0,
              matched_lines: tally.matchedLines ?? 0,
              searched: tally.searched ?? 0,
              printed: sent,
              elapsed,
            })
          }
        } else if (f.quiet && tally.selected && !damaged) {
          totals.add(tally, 0, elapsed)
        }
      } else if (chunks.length > 0) {
        const [gap, heading] = lead(f, label, printed, tally.binary === true, pat)
        // -c and -l counts and names are not what --stats counts.
        const sent =
          heading.length + (listingOrCount ? 0 : chunks.reduce((sum, c) => sum + c.length, 0))
        if (gap.length + heading.length > 0) yield concat([gap, heading])
        yield* chunks
        printed = true
        if (!damaged) totals.add(tally, sent, elapsed)
      } else if (!damaged) {
        totals.add(tally, 0, elapsed)
      }
      // --stats and --json count every file, -q or not (14.1.1).
      if (f.quiet && tally.selected && f.stats !== true && f.json !== true) break
    }
    const total = (performance.now() - started) / 1000
    if (records) yield formatOutput(pat, { kind: 'summary', totals: totalsConfig(totals), total })
    else if (f.stats === true) {
      // ripgrep's parallel searcher gives the last --heading group its blank
      // line too; one thread, as for a lone file, does not.
      if (printed && headed(f) && runsParallel(f) && !lone) yield ENC.encode('\n')
      yield formatOutput(pat, { kind: 'stats', totals: totalsConfig(totals), total })
    }
  } finally {
    // ripgrep's status under --files-without-match follows the listing, not
    // the matching: 0 when a file was listed, 1 when every file matched
    // (14.1.1; GNU grep keeps the match status). A walked binary file it
    // skipped counts as one without a match, though no listing names it.
    if (f.filesWithoutMatch && !f.quiet) selected = printed || skipped
    let code = exitCodeFor(selected, warnings.length > 0, f.quiet)
    const shown = f.noMessages ? [] : [...warnings]
    if (implicit && searched === 0) {
      // An error whatever --no-messages says, which only silences it.
      if (!f.noMessages) shown.push(NOTHING_SEARCHED)
      code = 2
    }
    io.exitCode = code
    if (shown.length > 0) io.stderr = concat([await materialize(io.stderr), formatRecords(shown)])
  }
}

// The flags with -H added, unless -I is the line's last word on it.
export function labelFlags(bag: Record<string, FlagValue>): Record<string, FlagValue> {
  const flags = { ...bag }
  flagOccurrences(flags).push(...flagOccurrences(bag))
  if (filenameFlag(new FlagView(bag, specOf('rg'))) !== 'no_filename') flags.with_filename = true
  return flags
}

/**
 * An rg line reads below every path it names, and walks into the mounts
 * below them unless it lists its types (`--type-list`, which reads no path)
 * or keeps to one filesystem. Mirrors Python's `facts`.
 */
export function facts(fl: FlagView, _operands: readonly (string | PathSpec)[]): LineFacts {
  const walks = !(
    fl.asBool('type_list') ||
    last(fl, 'one_file_system', 'no_one_file_system') === 'one_file_system'
  )
  return new LineFacts({ walks, readsSubtree: true })
}
