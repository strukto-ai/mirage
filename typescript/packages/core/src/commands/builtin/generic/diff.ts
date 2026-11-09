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

import { chunks } from '../../../io/cooperative.ts'
import { PipeClosed } from '../../../io/errors.ts'
import { OutputStream, closeQuietly } from '../../../io/stream.ts'
import { DiffPool } from '../../../rs/diff_pool.ts'
import type { DiffComputer, DiffMode, PairResult } from '../../../rs/diff_types.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { byteView } from '../../../shell/bytes.ts'
import { refused } from '../../../rs/scan.ts'
import { openStreamSync } from '../../../rs/stream.ts'
import type { Argument } from '../../spec/types.ts'
import { compileSpec } from '../../spec/compile.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { concat } from '../../../utils/bytes.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, PathSpec, type ReaddirFn, type StatFn } from '../../../types.ts'
import { gnuBasename } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { Context } from '../../config.ts'
import type { StatPath } from '../../../view/types.ts'
import { formatFsError } from '../../../errors/render.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { fsStrerror, isEnoent, isFsError } from '../../../errors/fs.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { followedStat } from '../../../view/namespace_view.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'
import { isStdin, stdinStat, stdinStream } from '../utils/stream.ts'
import { UsageError } from '../../errors.ts'
import { beforeFullWalk } from '../utils/tree.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { shellQuote } from '../../../utils/quote.ts'
import { contextTime, fullIsoTime } from '../utils/formatting.ts'
import { UTC_ZONE, zoneFromEnv, type Zone } from '../../../utils/timezone.ts'
import { linksOf, dispatchOf } from '../utils/links.ts'
import { vfsStatPath } from '../utils/paths.ts'
import { systemDate } from '../../../utils/clock.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

/** diff's line, parsed: one output style, what the comparison sets aside,
 * and how lines are written; patterns and widths are spelled one character
 * per byte, as the engine reads them. Mirrors Python's DiffFlags. */
export interface DiffFlags {
  readonly mode: DiffMode
  readonly ignoreCase: boolean
  readonly ignoreAllSpace: boolean
  readonly ignoreSpaceChange: boolean
  readonly ignoreTabExpansion: boolean
  readonly ignoreTrailingSpace: boolean
  readonly stripTrailingCr: boolean
  readonly ignoreBlankLines: boolean
  readonly ignoreLines: readonly string[]
  readonly functionLines: readonly string[]
  readonly showCFunction: boolean
  readonly expandTabs: boolean
  readonly initialTab: boolean
  readonly widths: readonly string[]
  readonly suppressCommon: boolean
  readonly leftColumn: boolean
  readonly text: boolean
  readonly labels: readonly string[]
  readonly utf8: boolean
  readonly context: number
  readonly brief: boolean
  readonly recursive: boolean
  /** -N reads a file missing on either side as empty. */
  readonly newFile: boolean
  /** --unidirectional-new-file (or -N) reads one missing from the first so. */
  readonly newFirst: boolean
  /** -s reports a pair that does not differ. */
  readonly identical: boolean
  readonly exclude: readonly string[]
  readonly excludeFrom: readonly PathSpec[]
}

// Each output style and the options that ask for it.
const STYLES: readonly (readonly [DiffMode, readonly string[]])[] = [
  ['normal', ['normal']],
  ['context', ['c', 'C', 'context']],
  ['unified', ['u', 'U', 'unified']],
  ['ed', ['ed']],
  ['rcs', ['rcs']],
  ['sides', ['side_by_side']],
]
const HINT = "diff: Try 'diff --help' for more information.\n"
const WHEN: readonly string[] = ['always', 'never', 'auto']

// Each value the options were typed with, in order, null for a bare long
// one. Mirrors Python's `_typed`.
function typed(fl: FlagView, ...names: string[]): (string | null)[] {
  return fl
    .occurrences(...names)
    .filter(([, value]) => value !== false)
    .map(([, value]) => (value === true ? null : String(value)))
}

// The context the context and unified options give, with every length,
// width and pattern checked by the diff engine before any operand is read.
// Mirrors Python's `_engine_checks`.
function engineChecks(
  lengths: readonly (string | null)[],
  widths: readonly string[],
  ignoreLines: readonly string[],
  functionLines: readonly string[],
): number | IOResult {
  let engine
  try {
    engine = openStreamSync('diff', {
      lengths: lengths.map((text) => (text === null ? null : byteView(text))),
      widths: widths.map((text) => byteView(text)),
      ignore_lines: ignoreLines.map((text) => byteView(text)),
      function_lines: functionLines.map((text) => byteView(text)),
    })
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  try {
    const { context } = JSON.parse(DEC.decode(engine.metadata())) as { context: number }
    return context
  } finally {
    engine.close()
  }
}

/**
 * diff's options, the ones diffutils refuses before any operand refused
 * here: two output styles, a third --label, an unknown --color, and a
 * length, width or pattern the diff engine refuses (exit 2). A valid
 * --color changes nothing: output is never colored. Mirrors Python's
 * `parse_flags`.
 */
export function parseFlags(bag: Record<string, FlagValue>, utf8 = false): DiffFlags | IOResult {
  const fl = new FlagView(bag, specOf('diff'))
  const styles = STYLES.filter(([, names]) =>
    fl.occurrences(...names).some(([, value]) => value !== false),
  ).map(([style]) => style)
  if (styles.length > 1)
    return new IOResult({
      exitCode: 2,
      stderr: ENC.encode(`diff: conflicting output style options\n${HINT}`),
    })
  const labels = fl.asList('label')
  if (labels.length > 2)
    return new IOResult({ exitCode: 2, stderr: ENC.encode('diff: too many file label options\n') })
  for (const value of typed(fl, 'color')) {
    if (value !== null && !WHEN.includes(value))
      return new IOResult({
        exitCode: 2,
        stderr: ENC.encode(`diff: invalid color '${value}'\n${HINT}`),
      })
  }
  const showCFunction = fl.asBool('show_c_function')
  const mode: DiffMode = styles[0] ?? (showCFunction ? 'context' : 'normal')
  const ignoreLines = fl.asList('ignore_matching_lines')
  const functionLines = fl.asList('show_function_line')
  const widths = typed(fl, 'width').filter((text): text is string => text !== null)
  const lengths = typed(fl, 'C', 'context', 'U', 'unified')
  const context = engineChecks(lengths, widths, ignoreLines, functionLines)
  if (context instanceof IOResult) return context
  const newFile = fl.asBool('new_file')
  return {
    mode,
    ignoreCase: fl.asBool('ignore_case'),
    ignoreAllSpace: fl.asBool('ignore_all_space'),
    ignoreSpaceChange: fl.asBool('ignore_space_change'),
    ignoreTabExpansion: fl.asBool('ignore_tab_expansion'),
    ignoreTrailingSpace: fl.asBool('ignore_trailing_space'),
    stripTrailingCr: fl.asBool('strip_trailing_cr'),
    ignoreBlankLines: fl.asBool('ignore_blank_lines'),
    ignoreLines: ignoreLines.map((text) => byteView(text)),
    functionLines: functionLines.map((text) => byteView(text)),
    showCFunction,
    expandTabs: fl.asBool('expand_tabs'),
    initialTab: fl.asBool('initial_tab'),
    widths: widths.map((text) => byteView(text)),
    suppressCommon: fl.asBool('suppress_common_lines'),
    leftColumn: fl.asBool('left_column'),
    text: fl.asBool('text'),
    labels,
    utf8,
    context,
    brief: fl.asBool('brief'),
    recursive: fl.asBool('recursive'),
    newFile,
    newFirst: newFile || fl.asBool('unidirectional_new_file'),
    identical: fl.asBool('report_identical_files'),
    exclude: fl.asList('exclude'),
    excludeFrom: fl.asPaths('exclude_from'),
  }
}

interface Walk {
  readonly computer: DiffComputer
  readonly signal: AbortSignal | undefined
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>
  readdir: ReaddirFn
  stat: StatFn
  flags: DiffFlags
  excluded: readonly string[]
  switches: string
  statPath: StatPath | null
  zone: Zone
  // An entry diff could not compare, reported as it goes on (exit 2).
  readonly trouble: Uint8Array[]
  // The directory a path resolves to, where diff follows links.
  real: ((virtual: string) => string) | null
  // A regular file's size, null when unknown, for -q to answer unread.
  sizeOf: ((p: PathSpec) => Promise<number | null>) | null
}

type Absent = readonly [boolean, boolean]

const PRESENT: Absent = [false, false]

// The characters GNU diff spells as a C escape in a header name. Any other
// control character is three octal digits.
const HEADER_ESCAPES: Readonly<Record<string, string>> = {
  '\x07': 'a',
  '\b': 'b',
  '\t': 't',
  '\n': 'n',
  '\v': 'v',
  '\f': 'f',
  '\r': 'r',
  '"': '"',
  '\\': '\\',
}

/**
 * A file name as GNU diff writes it in a header line. GNU diff double-quotes
 * a name holding a space, a double quote, a backslash or a control
 * character, and writes each of those but the space as a C escape
 * (`"sp ace"`, `"t\\tab"`); any other name, bytes above ASCII included, is
 * written as it is. The `---` and `+++` lines and the `diff -r` line use it;
 * the `Only in` and `Files ... differ` lines do not. Mirrors Python's
 * `quote_header_name`.
 */
export function quoteHeaderName(name: string): string {
  const special = (ch: string): boolean =>
    ch === ' ' || Object.hasOwn(HEADER_ESCAPES, ch) || ch < ' '
  if (!Array.from(name).some(special)) return name
  let out = ''
  for (const ch of name) {
    const escape = Object.hasOwn(HEADER_ESCAPES, ch) ? HEADER_ESCAPES[ch] : undefined
    if (escape !== undefined) out += '\\' + escape
    else if (ch < ' ') out += '\\' + ch.charCodeAt(0).toString(8).padStart(3, '0')
    else out += ch
  }
  return `"${out}"`
}

// The time a unified or context header gives one side, as diffutils prints
// it: the modification time as `%Y-%m-%d %H:%M:%S.%N %z` for a unified header
// and `%a %b %e %T %Y` for a context one, in the zone `TZ` names, read
// through the dispatcher as `stat` reads it, so a time `touch` keeps in the
// namespace shows; the epoch for a side -N reads as absent; and the present
// moment for standard input, as POSIX asks and diffutils does.
async function headerTime(walk: Walk, path: PathSpec, absent: boolean): Promise<string> {
  const layout = walk.flags.mode === 'context' ? contextTime : fullIsoTime
  if (absent) return layout(null, walk.zone)
  if (isStdin(path)) return layout(systemDate().toISOString(), walk.zone)
  const info =
    (walk.statPath !== null ? await walk.statPath(path) : null) ?? (await walk.stat(path))
  return layout(info.modified, walk.zone)
}

// A side's name, or the --label given for it. Mirrors Python's `_labelled`.
function labelled(walk: Walk, path: PathSpec, side: number): string {
  return walk.flags.labels[side] ?? path.rawPath
}

function childSpec(parent: PathSpec, name: string): PathSpec {
  const childPath = `${rstripSlash(parent.virtual)}/${name}`
  return new PathSpec({
    virtual: childPath,
    directory: childPath,
    resolved: false,
    vfsPath: mountKey(childPath, mountPrefixOf(parent.virtual, parent.vfsPath)),
    rawPath: `${rstripSlash(parent.rawPath)}/${name}`,
  })
}

function takesValue(option: Argument): boolean {
  return option.action !== 'store_true' && option.action !== 'count' && !(option.nargs === '?')
}

/**
 * The option words of a diff line, as GNU echoes them. GNU diff permutes its
 * options in front of its operands and prints them, word for word and in
 * order, on each `diff -r` header line: an option's detached value is its
 * own word, `--` is kept, and every operand is left out.
 */
export function switchWords(argv: readonly string[]): string[] {
  const options = compileSpec(specOf(CommandName.DIFF)).options
  const shorts = new Map(
    options.flatMap((o) =>
      o.names.filter((name) => !name.startsWith('--')).map((name) => [name.slice(1), o]),
    ),
  )
  const longs = new Map(
    options.flatMap((o) =>
      o.names.filter((name) => name.startsWith('--')).map((name) => [name.slice(2), o]),
    ),
  )
  const words: string[] = []
  let i = 0
  while (i < argv.length) {
    const word = argv[i] ?? ''
    i += 1
    if (word === '--') {
      words.push(word)
      break
    }
    if (!word.startsWith('-') || word === '-') continue
    words.push(word)
    if (word.startsWith('--')) {
      const name = word.slice(2).split('=')[0] ?? ''
      const found = longs.get(name)
      const matches =
        found !== undefined
          ? [found]
          : [...longs].filter(([n]) => n.startsWith(name)).map(([, o]) => o)
      const only = matches.length === 1 ? matches[0] : undefined
      if (!word.includes('=') && only !== undefined && takesValue(only) && i < argv.length) {
        words.push(argv[i] ?? '')
        i += 1
      }
      continue
    }
    for (let at = 1; at < word.length; at++) {
      const option = shorts.get(word[at] ?? '')
      if (option !== undefined && takesValue(option)) {
        if (at === word.length - 1 && i < argv.length) {
          words.push(argv[i] ?? '')
          i += 1
        }
        break
      }
    }
  }
  return words
}

// Whether -q knows the pair differs from its sizes alone: with no option
// that sets bytes aside it compares bytes, so two known sizes that differ answer it before
// either file is read. A stdin operand, a size not known, or a stat that
// fails leaves it to the read, which reports the failure. Mirrors Python's
// _sizes_differ.
async function sizesDiffer(
  walk: Walk,
  paths: readonly [PathSpec, PathSpec],
  absent: Absent,
): Promise<boolean> {
  const flags = walk.flags
  const sizeOf = walk.sizeOf
  if (
    sizeOf === null ||
    flags.ignoreCase ||
    flags.ignoreAllSpace ||
    flags.ignoreSpaceChange ||
    flags.ignoreTabExpansion ||
    flags.ignoreTrailingSpace ||
    flags.stripTrailingCr ||
    flags.ignoreBlankLines ||
    flags.ignoreLines.length > 0
  )
    return false
  const sizes: number[] = []
  for (const [index, path] of paths.entries()) {
    if (absent[index] === true) {
      sizes.push(0)
      continue
    }
    if (isStdin(path)) return false
    let size: number | null
    try {
      size = await sizeOf(path)
    } catch (err) {
      if (!isFsError(err)) throw err
      console.debug(`diff: no size for ${path.virtual}: ${String(err)}`)
      return false
    }
    if (size === null) return false
    sizes.push(size)
  }
  return sizes[0] !== sizes[1]
}

async function diffPair(
  walk: Walk,
  path1: PathSpec,
  path2: PathSpec,
  absent: Absent = PRESENT,
): Promise<PairResult> {
  const flags = walk.flags
  const name1 = labelled(walk, path1, 0)
  const name2 = labelled(walk, path2, 1)
  const headed = flags.mode === 'unified' || flags.mode === 'context'
  const headers: string[] = []
  const sides: readonly (readonly [PathSpec, boolean])[] = [
    [path1, absent[0]],
    [path2, absent[1]],
  ]
  for (const [side, [path, gone]] of sides.entries()) {
    const label = flags.labels[side]
    if (!headed) headers.push('')
    else if (label !== undefined) headers.push(label)
    else headers.push(`${quoteHeaderName(path.rawPath)}\t${await headerTime(walk, path, gone)}`)
  }
  const result: PairResult =
    flags.brief && (await sizesDiffer(walk, [path1, path2], absent))
      ? { outcome: 'different', output: [], status: 1, stderr: [] }
      : await walk.computer.compare(
          {
            mode: flags.mode,
            context: flags.context,
            ignore_case: flags.ignoreCase,
            ignore_all_space: flags.ignoreAllSpace,
            ignore_space_change: flags.ignoreSpaceChange,
            ignore_tab_expansion: flags.ignoreTabExpansion,
            ignore_trailing_space: flags.ignoreTrailingSpace,
            strip_trailing_cr: flags.stripTrailingCr,
            ignore_blank_lines: flags.ignoreBlankLines,
            ignore_lines: [...flags.ignoreLines],
            function_lines: [...flags.functionLines],
            show_c_function: flags.showCFunction,
            expand_tabs: flags.expandTabs,
            initial_tab: flags.initialTab,
            widths: [...flags.widths],
            suppress_common: flags.suppressCommon,
            left_column: flags.leftColumn,
            text: flags.text,
            brief: flags.brief,
            utf8: flags.utf8,
            old_label: name1,
            new_label: name2,
            old_header: headers[0] ?? '',
            new_header: headers[1] ?? '',
          },
          () => (absent[0] ? new Uint8Array() : walk.stream(path1)),
          () => (absent[1] ? new Uint8Array() : walk.stream(path2)),
          walk.signal,
        )
  if (result.outcome === 'equal' && flags.identical && result.status === 0)
    return {
      ...result,
      output: [...result.output, ENC.encode(`Files ${name1} and ${name2} are identical\n`)],
    }
  if (result.outcome === 'different' && flags.brief && result.status === 1)
    return {
      ...result,
      output: [ENC.encode(`Files ${name1} and ${name2} differ\n`)],
    }
  return result
}

async function entries(walk: Walk, path: PathSpec, absent: boolean): Promise<Set<string>> {
  if (absent) return new Set()
  const names = (await walk.readdir(path)).map((e) => gnuBasename(e))
  return new Set(names.filter((name) => !walk.excluded.some((pattern) => fnmatch(name, pattern))))
}

// What an entry is, as diff's stat follows it; null, and the entry named in
// `trouble`, for one it cannot stat or a link that leads nowhere. GNU names
// each such entry on each side and goes on with the rest, the pair left
// uncompared (exit 2). Mirrors Python's _entry_kind.
async function entryKind(walk: Walk, path: PathSpec): Promise<FileType | null> {
  let row: FileStat
  try {
    row = await walk.stat(path)
  } catch (err) {
    if (!isFsError(err)) throw err
    walk.trouble.push(ENC.encode(`diff: ${path.rawPath}: ${String(fsStrerror(err))}\n`))
    return null
  }
  if (row.type === FileType.SYMLINK) {
    walk.trouble.push(ENC.encode(`diff: ${path.rawPath}: ${posixPhrase('ENOENT')}\n`))
    return null
  }
  return row.type
}

/**
 * Compare two directories, one of which -N may read as empty; returns the
 * report and whether any pair differed. Where diff follows links, a pair whose
 * every side is a directory already open above it on that side (`above`, as
 * the paths they resolve to) is GNU's recursive directory loop: named and left
 * unread (exit 2).
 */
async function diffDirs(
  walk: Walk,
  dirA: PathSpec,
  dirB: PathSpec,
  absent: Absent = PRESENT,
  above: readonly [readonly string[], readonly string[]] = [[], []],
): Promise<[readonly ByteSource[], boolean]> {
  const flags = walk.flags
  const real = walk.real
  const opened: readonly [readonly string[], readonly string[]] =
    real === null
      ? above
      : [
          absent[0] ? above[0] : [...above[0], real(dirA.virtual)],
          absent[1] ? above[1] : [...above[1], real(dirB.virtual)],
        ]
  const namesA = await entries(walk, dirA, absent[0])
  const namesB = await entries(walk, dirB, absent[1])
  const names = [...new Set([...namesA, ...namesB])].sort(compareCodePoints)
  const left = rstripSlash(dirA.rawPath)
  const right = rstripSlash(dirB.rawPath)
  const parts: ByteSource[] = []
  let differ = false
  for (const name of names) {
    const inA = namesA.has(name)
    const inB = namesB.has(name)
    if (!inB && !flags.newFile) {
      parts.push(ENC.encode(`Only in ${left}: ${name}\n`))
      differ = true
      continue
    }
    if (!inA && !flags.newFirst) {
      parts.push(ENC.encode(`Only in ${right}: ${name}\n`))
      differ = true
      continue
    }
    const childA = childSpec(dirA, name)
    const childB = childSpec(dirB, name)
    const kindA = inA ? await entryKind(walk, childA) : null
    const kindB = inB ? await entryKind(walk, childB) : null
    if ((inA && kindA === null) || (inB && kindB === null)) continue
    const aDir = kindA === FileType.DIRECTORY
    const bDir = kindB === FileType.DIRECTORY
    const gone: Absent = [!inA, !inB]
    if ((aDir || !inA) && (bDir || !inB)) {
      if (
        real !== null &&
        [childA, childB].every(
          (child, i) => gone[i] === true || opened[i]?.includes(real(child.virtual)) === true,
        )
      ) {
        const named = inA ? childA : childB
        walk.trouble.push(ENC.encode(`diff: ${named.rawPath}: recursive directory loop\n`))
        continue
      }
      const [body, changed] = await diffDirs(walk, childA, childB, gone, opened)
      for (const chunk of body) parts.push(chunk)
      differ ||= changed
    } else if (!aDir && !bDir) {
      const pair = await diffPair(walk, childA, childB, gone)
      for (const chunk of pair.stderr) walk.trouble.push(chunk)
      if (pair.status === 2 && pair.stderr.length === 0)
        walk.trouble.push(ENC.encode('diff: comparison failed\n'))
      differ ||= pair.outcome === 'different'
      // Side by side shows an equal pair's common lines too, so its header
      // comes with every pair the lines are not suppressed for.
      if (
        !flags.brief &&
        (pair.outcome === 'different' || (flags.mode === 'sides' && !flags.suppressCommon))
      )
        parts.push(
          ENC.encode(
            `diff${walk.switches} ${quoteHeaderName(labelled(walk, childA, 0))} ${quoteHeaderName(labelled(walk, childB, 1))}\n`,
          ),
        )
      for (const chunk of pair.output) parts.push(chunk)
    } else if (aDir) {
      differ = true
      parts.push(
        ENC.encode(
          `File ${childA.rawPath} is a directory while file ${childB.rawPath} is a regular file\n`,
        ),
      )
    } else {
      differ = true
      parts.push(
        ENC.encode(
          `File ${childA.rawPath} is a regular file while file ${childB.rawPath} is a directory\n`,
        ),
      )
    }
  }
  return [parts, differ]
}

async function missing(stat: StatFn, path: PathSpec, allowed: boolean): Promise<boolean> {
  if (!allowed || isStdin(path)) return false
  try {
    await stat(path)
  } catch (err) {
    if (isEnoent(err)) return true
    throw err
  }
  return false
}

async function excludedPatterns(
  flags: DiffFlags,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<string[]> {
  const patterns = [...flags.exclude]
  for (const path of flags.excludeFrom) {
    const text = DEC.decode(await materialize(stream(path)))
    for (const line of text.split('\n')) if (line !== '') patterns.push(line)
  }
  return patterns
}

export async function diffGeneric(
  flags: DiffFlags,
  paths: PathSpec[],
  ctx: Context,
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
  readdir: ReaddirFn,
  backendStat: StatFn,
  sizeOf: ((p: PathSpec) => Promise<number | null>) | null = null,
): Promise<[ByteSource | null, IOResult]> {
  if (paths.length > 2) throw extraOperandError(CommandName.DIFF, paths[2]?.rawPath ?? '')
  if (paths.length < 2)
    throw missingOperandError(CommandName.DIFF, paths[0]?.rawPath ?? null, ctx.argv ?? [])
  const p0 = paths[0]
  const p1 = paths[1]
  if (p0 === undefined || p1 === undefined) return [null, new IOResult()]
  // Both name the one stdin, which GNU sees as the same file.
  if (isStdin(p0) && isStdin(p1)) return [null, new IOResult()]
  const stream = stdinStream(read, ctx.stdin)
  const stat = stdinStat(backendStat)
  const dash0 = p0.rawPath === '-'
  const dash1 = p1.rawPath === '-'
  const errorPaths = [...paths, ...flags.excludeFrom]
  const links = linksOf(ctx)
  const trouble: Uint8Array[] = []
  let output: readonly ByteSource[] | undefined
  let differ = false
  const owned = ctx.diff === undefined ? new DiffPool() : undefined
  const computer = ctx.diff ?? owned
  if (computer === undefined) throw new Error('diff computer is missing')
  try {
    const walk: Walk = {
      computer,
      signal: ctx.signal,
      stream,
      readdir,
      // diff compares what each link leads to (its default --dereference),
      // the operands' own taken there at dispatch.
      stat: (p: PathSpec) => followedStat(stat, links, p),
      flags,
      excluded: await excludedPatterns(flags, stream),
      switches: switchWords(ctx.argv ?? [])
        .map((word) => ` ${shellQuote(word)}`)
        .join(''),
      statPath: vfsStatPath(ctx.vfs) ?? null,
      zone: zoneFromEnv(ctx.env) ?? UTC_ZONE,
      trouble,
      real: links === undefined ? null : (virtual: string) => links.resolve(virtual),
      sizeOf,
    }
    if (dash0 !== dash1) {
      if ((await stat(dash0 ? p1 : p0)).type === FileType.DIRECTORY) {
        return [
          null,
          new IOResult({
            exitCode: 2,
            stderr: ENC.encode("diff: cannot compare '-' to a directory\n"),
          }),
        ]
      }
    }
    // A missing operand -N reads as empty only beside one that is there:
    // two missing ones are both reported.
    const absent: Absent = [
      await missing(stat, p0, flags.newFirst),
      await missing(stat, p1, flags.newFile),
    ]
    if (absent[0] && absent[1]) {
      const lines: Uint8Array[] = []
      for (const path of paths) {
        try {
          await stat(path)
        } catch (err) {
          if (!isFsError(err)) throw err
          lines.push(formatFsError('diff', err, [path]))
        }
      }
      return [null, new IOResult({ exitCode: 2, stderr: concat(lines) })]
    }
    if (flags.recursive && !absent[0] && !absent[1]) {
      const bothDirs =
        (await stat(p0)).type === FileType.DIRECTORY && (await stat(p1)).type === FileType.DIRECTORY
      if (bothDirs) {
        for (const path of [p0, p1]) await beforeFullWalk(dispatchOf(ctx), path, 'diff')
        ;[output, differ] = await diffDirs(walk, p0, p1)
      }
    }
    if (output === undefined) {
      const pair = await diffPair(walk, p0, p1, absent)
      output = pair.output
      differ = pair.outcome === 'different'
      for (const chunk of pair.stderr) trouble.push(chunk)
      if (pair.status === 2 && pair.stderr.length === 0)
        trouble.push(ENC.encode('diff: comparison failed\n'))
    }
  } catch (err) {
    if (err instanceof StreamRefusal)
      return [
        err.output,
        new IOResult({ exitCode: 2, stderr: ENC.encode(`diff: ${err.message}\n`) }),
      ]
    if (!isFsError(err)) {
      if (
        err instanceof UsageError ||
        err instanceof CommandTimeoutError ||
        err instanceof PipeClosed ||
        (err instanceof Error && err.name === 'AbortError')
      )
        throw err
      return [
        null,
        new IOResult({
          exitCode: 2,
          stderr: ENC.encode(`diff: ${err instanceof Error ? err.message : String(err)}\n`),
        }),
      ]
    }
    // GNU diff reserves exit 1 for "files differ"; trouble (a missing or
    // unreadable operand) is exit 2.
    return [null, new IOResult({ exitCode: 2, stderr: formatFsError('diff', err, errorPaths) })]
  } finally {
    await owned?.close()
  }
  const held = output
  const out: ByteSource = new OutputStream(outputChunks(held), () => closeParts(held))
  if (trouble.length > 0) return [out, new IOResult({ exitCode: 2, stderr: concat(trouble) })]
  return [out, new IOResult({ exitCode: differ ? 1 : 0 })]
}

async function* outputChunks(parts: readonly ByteSource[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield* chunks(part)
}

async function closeParts(parts: readonly ByteSource[]): Promise<void> {
  for (const part of parts) await closeQuietly(part)
}
