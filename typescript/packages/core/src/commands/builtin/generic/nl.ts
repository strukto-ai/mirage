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

import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { BreError, searchBre } from '../utils/bre.ts'
import { quoteText } from '../../quote.ts'
import { resolveSource } from '../utils/stream.ts'
import { operandsIo, readOperands, singleChunk } from '../utils/operands.ts'
import { FlagView, type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'
import { C_SPACE } from '../constants.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function shouldNumber(line: string, numbering: string, pattern: RegExp | null): boolean {
  if (numbering === 'n') return false
  if (numbering === 'a') return true
  if (numbering === 'p' && pattern !== null) return pattern.test(line)
  return line.trim() !== ''
}

// The counter is a bigint, not a number. GNU counts in intmax_t, so a
// float64 both loses digits past 2**53 (`nl -v 9223372036854775807` printed
// 9223372036854776000 where python printed the value) and cannot tell whether
// the next increment would overflow, which is the abort GNU performs.
function formatNumber(value: bigint, width: number, format: string): string {
  const raw = String(value)
  if (format === 'ln') return raw.padEnd(width, ' ')
  if (format === 'rz') return raw.padStart(width, '0')
  return raw.padStart(width, ' ')
}

// Map each logical-page delimiter line to the section it opens.
//
// GNU pads a one-character -d with ':' as its second character, and an empty
// -d disables delimiter matching entirely (it does not restore the default
// `\:`).
//
// "One character" is glibc strlen, i.e. one BYTE, the same measure
// blankPrefix takes off the separator. Neither JavaScript's UTF-16 units nor
// python's code points answer it: `-d 'é'` is two bytes and is used unpadded,
// so `ééé` opens a header while `é:é:é:` is ordinary text, and both hosts
// padded it while only one of them padded a four-byte emoji. A longer
// argument is used WHOLE and never truncated, so `-d xyz` looks for
// `xyzxyzxyz`.
function sectionDelimiters(delimiter: string): Record<string, string> {
  if (delimiter === '') return {}
  const pair = ENC.encode(delimiter).length > 1 ? delimiter : `${delimiter}:`
  return { [pair.repeat(3)]: 'header', [pair.repeat(2)]: 'body', [pair]: 'footer' }
}

interface NlConfig {
  numbering: Record<string, string>
  patterns: Record<string, RegExp | null>
  start: bigint
  increment: bigint
  width: number
  separator: string
  numberFormat: string
  delimiters: Record<string, string>
  joinBlankLines: number
  noRenumber: boolean
}

interface NlState {
  number: bigint
  section: string
  blankRun: number
  // The advance has left intmax_t; the NEXT line that needs a number is the
  // one that dies (NL3-F).
  overflowed: boolean
  // That death has happened, so a second operand must not be numbered.
  aborted: boolean
}

// What GNU writes in place of a number on an unnumbered line.
//
// Not the number field plus the separator: GNU builds one `print_no_line_fmt`
// of `lineno_width` blanks followed by `strlen(separator_str)` MORE blanks, so
// the separator is padded over rather than printed. The default line is
// therefore seven spaces, not six spaces and a TAB, and the difference is
// visible on every unnumbered line (`nl -b n`, a blank line under `-b t`, a
// line a `-b p` pattern did not match).
//
// Two things the count does NOT depend on. `-n`'s format is irrelevant --
// `ln`, `rn` and `rz` all pad to the same width -- and so is how wide the
// number would have been, because the declared width is what is padded. What
// it does depend on is the separator's length in BYTES, which is glibc's
// `strlen`: `-s 'é'` pads by two, not one, so the length is taken off the
// encoded form rather than off the UTF-16 unit count. That also keeps this
// host and the python twin emitting the same byte count, since JavaScript
// counts UTF-16 units and python counts code points.
//
// All od-verified on GNU coreutils 9.4 (ground-truth section W): `-w 3` pads
// 4, `-w 10` pads 11, `-s ''` pads 6, `-s '::'` pads 8, `-w 3 -s '::'` pads 5.
function blankPrefix(config: NlConfig): string {
  return ' '.repeat(config.width + ENC.encode(config.separator).length)
}

// One input line as nl writes it, or null to abort.
//
// null means "this line needs a number and the counter has already
// overflowed", which is GNU's fatal `line number overflow`. The check is here
// rather than after the advance because the abort is DEFERRED to the next line
// that needs a number: `nl -v 9223372036854775805` on three lines prints all
// three and exits 0, while the same start on four lines prints three and exits
// 1. An unnumbered line in between still prints
// (`printf 'a\n\nb\n' | nl -v <max>` writes the numbered line and the padded
// blank, then dies on the `b`). Measured, NL3-F.
function renderLine(line: string, config: NlConfig, state: NlState): Uint8Array | null {
  const section = config.delimiters[line]
  if (section !== undefined) {
    state.section = section
    state.blankRun = 0
    if (!config.noRenumber) state.number = config.start
    // GNU writes an empty line in place of the delimiter itself.
    return ENC.encode('\n')
  }
  const numbering = config.numbering[state.section] ?? 'n'
  const pattern = config.patterns[state.section] ?? null
  let numberLine = shouldNumber(line, numbering, pattern)
  if (numbering === 'a' && line === '') {
    state.blankRun += 1
    numberLine = state.blankRun >= config.joinBlankLines
    if (numberLine) state.blankRun = 0
  } else {
    state.blankRun = 0
  }
  if (numberLine) {
    if (state.overflowed) return null
    const prefix = formatNumber(state.number, config.width, config.numberFormat)
    const advanced = state.number + config.increment
    if (advanced < INTMAX_MIN || advanced > INTMAX_MAX) {
      state.overflowed = true
    } else {
      state.number = advanced
    }
    return ENC.encode(`${prefix}${config.separator}${line}\n`)
  }
  return ENC.encode(`${blankPrefix(config)}${line}\n`)
}

// Number one source's lines, stopping if the counter overflows.
//
// GNU numbers the line, prints it, and THEN adds the increment; an addition
// that leaves intmax_t marks the counter, and the next line that NEEDS a
// number is the one that dies. So the line whose number was the limit is still
// written (`nl -v 9223372036854775807` prints line 1 and exits 1), and a run
// that ends exactly on the limit never dies at all
// (`nl -v 9223372036854775805` exits 0 on three lines and 1 on four). The
// counter advances only for a line nl NUMBERED, which is why
// `nl -b n -v 9223372036854775807` never overflows.
//
// Reported by mutating the caller's IOResult, because the exit code is decided
// after the handler already returned its stream. `error(EXIT_FAILURE, 0, ...)`
// means errnum 0, so there is no colon clause here -- unlike every option
// refusal in this module.
async function* nlStream(
  source: AsyncIterable<Uint8Array>,
  config: NlConfig,
  state: NlState,
  io?: IOResult,
): AsyncIterable<Uint8Array> {
  const iter = new AsyncLineIterator(source)
  for await (const raw of iter) {
    const line = DEC.decode(raw)
    const rendered = renderLine(line, config, state)
    if (rendered === null) {
      if (io !== undefined) {
        io.exitCode = 1
        io.stderr = ENC.encode('nl: line number overflow\n')
      }
      state.aborted = true
      return
    }
    yield rendered
  }
}

async function* nlMulti(
  buffers: readonly Uint8Array[],
  config: NlConfig,
  io?: IOResult,
): AsyncIterable<Uint8Array> {
  const state: NlState = {
    number: config.start,
    section: 'body',
    blankRun: 0,
    overflowed: false,
    aborted: false,
  }
  for (const data of buffers) {
    for await (const rendered of nlStream(singleChunk(data), config, state, io)) yield rendered
    if (state.aborted) return
  }
}

// The style a -b/-f/-h argument selects, as GNU reads it.
//
// GNU switches on the argument's FIRST character and keeps the rest only to
// compile a `p` style's pattern, so `-b nn` is the `n` style and prints no
// numbers rather than an unrecognized style falling through to `t`.
// Anything but a/t/n/p was already refused by optionErrors, and so was a `p`
// style whose BRE does not compile, so this cannot throw.
//
// The pattern is a POSIX BRE, not this host's dialect: GNU compiles it with
// `RE_SYNTAX_POSIX_BASIC`, where `\(` groups and a bare `(` is a literal --
// the inverse of both JavaScript `RegExp` and python `re`. It goes through the
// shared translator so the two hosts cannot answer differently, which is what
// they did when each handed the text to its own engine (`nl -b 'p['` said
// `Invalid regular expression: /[/: Unterminated character class` here and
// `unterminated character set at position 0` there, and neither was GNU's
// `Invalid regular expression`).
function parseNumbering(raw: string): [string, RegExp | null] {
  if (raw.startsWith('p')) return ['p', searchBre(raw.slice(1))]
  return [raw.slice(0, 1), null]
}

// gnulib appends strerror(ERANGE) when a value parsed but fell outside the
// option's range, and strerror(EOVERFLOW) when the value did not fit the type
// it was scanned into. Measured under LC_ALL=C on glibc; these are the two
// strings here most likely to read differently under another libc or locale.
// One numeric option value as `strtol` reads it: a run of C whitespace, then
// at most one sign, then decimal digits, then NOTHING.
//
// The leading run is real GNU behavior and easy to miss: `nl -v $'\t5'`,
// `' 5'`, `$'\n5'` and `'  +5'` are all accepted and number from 5, while
// `'5 '` and `'  3  '` are refused -- leading whitespace is skipped, trailing
// whitespace is garbage. The class is spelled out rather than written `\s`
// because it is C `isspace`: JavaScript's `\s` also matches every Unicode
// space plus U+FEFF, so it would accept a great deal GNU refuses. No
// whitespace may sit BETWEEN the sign and the digits (`'+ 5'` is refused), and
// there is only ever one sign. Measured, ground truth NL3-C.
const NUMBER = new RegExp(`^${C_SPACE}[+-]?[0-9]+$`)

const ERANGE = 'Numerical result out of range'
const EOVERFLOW = 'Value too large for defined data type'

// The two type limits nl's four numeric options are bounded by. Held as
// bigint because INTMAX_MAX is past Number.MAX_SAFE_INTEGER, so a float64
// comparison would accept 9223372036854775808 that GNU refuses.
const INT_MAX = 2n ** 31n - 1n
const INTMAX_MAX = 2n ** 63n - 1n
const INTMAX_MIN = -(2n ** 63n)

// Where the sub-minimum side of -w and -l switches from the ERANGE wording to
// the EOVERFLOW one, measured by bisection on coreutils 9.4 / glibc 2.39 /
// x86-64: `-w -1073741824` is ERANGE and `-w -1073741825` is EOVERFLOW,
// deterministically and whatever else the line carries. -2**30 matches no
// type boundary and no stated range end, so treat this as an unexplained
// gnulib artifact of that platform rather than a rule with a reason; it is
// the value here most likely to move elsewhere.
//
// It belongs to -w and -l ALONE. -v and -i switch at the type boundary
// instead (`-i -9223372036854775808` numbers happily and only
// -9223372036854775809 is refused), so they carry INTMAX_MIN here and the
// ERANGE clause is unreachable for them.
const WIDTH_OVERFLOW_LOW = -(2n ** 30n)

// GNU nl's refusal for one of its four numeric options.
//
// Each option has its own wording and — unlike expand and cut — the WHOLE
// argument is quoted. Same shape as numberFlagError in tail_counts.ts:
// validate first, so the parse below cannot hand back a prefix or NaN.
//
// THREE message shapes, not two, and which one speaks depends on why the
// value failed rather than on which option it was. A value the scanner could
// not read at all keeps the plain two-clause form (`nl -w abc`, `nl -w ''`).
// A value that scanned but fell below the option's minimum adds
// `: Numerical result out of range` (`nl -w 0`, `nl -w -3`). A value too big
// for the type it is scanned into adds `: Value too large for defined data
// type` instead (`nl -w 2147483648`, `nl -v 99999999999999999999`) — which is
// the clause a reimplementation is most likely to miss, because without it
// the value is accepted and then blows up building the pad rather than being
// refused.
//
// The ranges differ per option and split the four two ways. `-v` and `-i`
// take the whole signed range, so GNU numbers from a negative start and counts
// up, `-i -2` genuinely decrements, and zero is legal; neither ever produces
// the ERANGE clause, because their overflowLow IS their low. `-w` and `-l`
// must be at least 1, and `-w` additionally tops out at INT_MAX where `-l`
// tops out at INTMAX_MAX. All four spell a leading `+` the way GNU does, as a
// sign on an otherwise unsigned value.
function numberError(
  label: string,
  raw: string | undefined,
  low: bigint,
  high: bigint,
  overflowLow: bigint,
): string | null {
  if (raw === undefined) return null
  if (!NUMBER.test(raw)) return `nl: ${label}: '${quoteText(raw)}'`
  const value = BigInt(raw)
  if (value > high || value < overflowLow) {
    return `nl: ${label}: '${quoteText(raw)}': ${EOVERFLOW}`
  }
  if (value < low) return `nl: ${label}: '${quoteText(raw)}': ${ERANGE}`
  return null
}

// nl's four numeric options: the dest, the option's own message text, the
// inclusive range GNU accepts, and where the refusal switches to the
// EOVERFLOW wording. The order here is for reading only — which option gets
// to speak is decided by the command line, never by this table.
const NUMERIC_OPTIONS: readonly (readonly [string, string, bigint, bigint, bigint])[] = [
  ['starting_line_number', 'invalid starting line number', INTMAX_MIN, INTMAX_MAX, INTMAX_MIN],
  ['line_increment', 'invalid line number increment', INTMAX_MIN, INTMAX_MAX, INTMAX_MIN],
  ['number_width', 'invalid line number field width', 1n, INT_MAX, WIDTH_OVERFLOW_LOW],
  ['join_blank_lines', 'invalid line number of blank lines', 1n, INTMAX_MAX, WIDTH_OVERFLOW_LOW],
]

// The three style options and the message each one words its refusal with.
// GNU tests only the FIRST character of the argument (its build_type_arg
// switches on `*optarg`), so `-b tt` is the `t` style with a trailing byte
// GNU never reads again, while `-b A` and an empty `-b` fall to the default
// arm and are refused.
const STYLE_OPTIONS: Readonly<Record<string, string>> = {
  body_numbering: 'invalid body numbering style',
  footer_numbering: 'invalid footer numbering style',
  header_numbering: 'invalid header numbering style',
}
const STYLE_HEADS = new Set(['a', 't', 'n', 'p'])

// -n is the one that takes a whole word: GNU strcmps the argument against
// each of the three formats, so `rnn` and `LN` are both refused where
// `-b tt` is accepted. `-d` and `-s` are validated by neither GNU nor us —
// `-d xyz` and `-s ''` are accepted (measured).
const FORMAT_DEST = 'number_format'
const FORMAT_LABEL = 'invalid line numbering format'
const NUMBER_FORMATS = new Set(['ln', 'rn', 'rz'])

// The line usage() prints after a deferred refusal. GNU's numeric options
// never reach it: they exit where they are validated.
const HINT = "Try 'nl --help' for more information."

// GNU's refusal for one occurrence of a style or format option.
function styleError(dest: string, raw: string): string | null {
  const label = STYLE_OPTIONS[dest]
  if (label !== undefined) {
    if (STYLE_HEADS.has(raw.slice(0, 1))) return null
    return `nl: ${label}: '${quoteText(raw)}'`
  }
  if (NUMBER_FORMATS.has(raw)) return null
  return `nl: ${FORMAT_LABEL}: '${quoteText(raw)}'`
}

// glibc's refusal for a `p` style whose BRE will not compile.
//
// The style itself is already known good here, so a pattern failure prints NO
// `invalid body numbering style` line -- only the compiler's own wording,
// which is glibc's `regerror` string and not coreutils'. It belongs to the
// FATAL family: `nl -b 'p[' -h bogus` prints the regex line alone, so nothing
// to its right is scanned and the `--help` hint never arrives (section U6).
// Only the three style options carry a pattern; `-n` never does.
function patternError(dest: string, raw: string): string | null {
  if (STYLE_OPTIONS[dest] === undefined || !raw.startsWith('p')) return null
  try {
    searchBre(raw.slice(1))
  } catch (err) {
    if (!(err instanceof BreError)) throw err
    return `nl: ${err.message}`
  }
  return null
}

// Everything GNU nl prints for the options one line carried.
//
// GNU validates each value the moment getopt hands it over, which decides
// both which option speaks and how the line ends, and its two families of
// options end it differently:
//
//   * A bad NUMERIC value (-v -i -w -l) is fatal on the spot, so the
//     leftmost one wins and nothing after it is even looked at.
//     `nl -w abc -v xyz` names the width, `nl -v xyz -w abc` names the
//     starting line number, and neither prints the --help hint.
//   * A bad STYLE or FORMAT value (-b -f -h -n) is reported without
//     exiting and parsing continues, so several can accumulate and the line
//     ends in usage(EXIT_FAILURE), which is where the hint comes from. This
//     is why `nl -b bogus -w abc` prints two lines and NO hint (the width
//     killed the parse), `nl -b bogus -w 3` prints one WITH the hint, and
//     `nl -w abc -b bogus` prints only the width (the parse died before -b
//     was scanned). All measured on GNU coreutils 9.4.
//   * A `p` style whose BRE will not compile is a THIRD case that behaves
//     like the numeric one -- fatal where it stands, no hint -- but flushes
//     the style lines already deferred to its left, and prints no style line
//     of its own because the style was accepted. It is checked after the
//     style test, so a bad style never reaches the regex compiler
//     (`nl -b '['` is an invalid style, not an unterminated bracket).
//
// Validation is per OCCURRENCE, not per option: `nl -b bogus -b t` still
// refuses, because GNU had already reported `bogus` when the second -b
// overrode it. That is what valueOccurrences is for — the bag keeps one
// value per scalar option, so it cannot answer for `nl -w abc -w 3`, where
// the value GNU refuses is the one the bag dropped.
//
// Returns the stderr text, one newline-terminated line per error, or null
// when GNU accepts every value.
function optionErrors(fl: FlagView): string | null {
  const camps = new Map<string, readonly [string, bigint, bigint, bigint]>(
    NUMERIC_OPTIONS.map(([dest, label, low, high, overflowLow]) => [
      dest,
      [label, low, high, overflowLow] as const,
    ]),
  )
  const dests = [...camps.keys(), ...Object.keys(STYLE_OPTIONS), FORMAT_DEST]
  const render = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join('')
  const deferred: string[] = []
  for (const [dest, raw] of fl.valueOccurrences(...dests)) {
    const camp = camps.get(dest)
    if (camp !== undefined) {
      const fatal = numberError(camp[0], raw, camp[1], camp[2], camp[3])
      if (fatal !== null) return render([...deferred, fatal])
    } else {
      const err = styleError(dest, raw)
      if (err !== null) {
        deferred.push(err)
        continue
      }
      // The style was accepted, so a `p` style now compiles its BRE, and a
      // failure is fatal where it stands -- with every style line deferred
      // before it flushed first.
      const fatal = patternError(dest, raw)
      if (fatal !== null) return render([...deferred, fatal])
    }
  }
  if (deferred.length > 0) return render([...deferred, HINT])
  return null
}

// nl's flags, read once, exactly as the python NlFlags holds them: the raw
// option words, not the resolved config. Keeping the raw strings here is what
// lets the two hosts share one validation pass and then each build its own
// NlConfig from the same words.
export interface NlFlags {
  readonly bodyNumberingRaw: string | undefined
  readonly startRaw: string | undefined
  readonly incrementRaw: string | undefined
  readonly widthRaw: string | undefined
  readonly separator: string | undefined
  readonly footerNumberingRaw: string | undefined
  readonly headerNumberingRaw: string | undefined
  readonly joinBlankLinesRaw: string | undefined
  readonly numberFormat: string
  readonly delimiter: string
  readonly noRenumber: boolean
}

// Read nl's flags once, refusing every value GNU refuses.
//
// Returns the stderr text instead of the struct when GNU refuses the line,
// the shape every sibling generic's parseFlags uses.
export function parseFlags(bag: Record<string, FlagValue>): NlFlags | string {
  const fl = new FlagView(bag, specOf('nl'))
  const optionErr = optionErrors(fl)
  if (optionErr !== null) return optionErr
  const rawDelimiter = fl.asStr('section_delimiter')
  return {
    bodyNumberingRaw: fl.asStr('body_numbering'),
    startRaw: fl.asStr('starting_line_number'),
    incrementRaw: fl.asStr('line_increment'),
    widthRaw: fl.asStr('number_width'),
    separator: fl.asStr('number_separator'),
    footerNumberingRaw: fl.asStr('footer_numbering'),
    headerNumberingRaw: fl.asStr('header_numbering'),
    joinBlankLinesRaw: fl.asStr('join_blank_lines'),
    numberFormat: fl.asStr('number_format') ?? 'rn',
    // An empty `-d` is not an absent one: GNU disables delimiter matching
    // entirely for it and does NOT fall back to `\:`, so the default can
    // only be substituted for undefined.
    delimiter: rawDelimiter ?? '\\:',
    noRenumber: fl.asBool('no_renumber'),
  }
}

// Turn nl's raw option words into the config the renderer reads, the way the
// python `nl()` entry point does. Every value here was already validated by
// parseFlags, so no parse can fail and no style can fall through.
function buildConfig(parsed: NlFlags): NlConfig {
  const [bodyNumbering, bodyPattern] = parseNumbering(parsed.bodyNumberingRaw ?? 't')
  const [footerNumbering, footerPattern] = parseNumbering(parsed.footerNumberingRaw ?? 'n')
  const [headerNumbering, headerPattern] = parseNumbering(parsed.headerNumberingRaw ?? 'n')
  return {
    numbering: { body: bodyNumbering, footer: footerNumbering, header: headerNumbering },
    patterns: { body: bodyPattern, footer: footerPattern, header: headerPattern },
    start: parsed.startRaw === undefined ? 1n : BigInt(parsed.startRaw),
    increment: parsed.incrementRaw === undefined ? 1n : BigInt(parsed.incrementRaw),
    width: parsed.widthRaw === undefined ? 6 : Number.parseInt(parsed.widthRaw, 10),
    separator: parsed.separator ?? '\t',
    numberFormat: parsed.numberFormat,
    delimiters: sectionDelimiters(parsed.delimiter),
    joinBlankLines:
      parsed.joinBlankLinesRaw === undefined ? 1 : Number.parseInt(parsed.joinBlankLinesRaw, 10),
    noRenumber: parsed.noRenumber,
  }
}

export async function nlGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  const config = buildConfig(parsed)
  if (paths.length > 0) {
    // Operands read eagerly so a missing one is reported up front and the
    // remaining operands still number (GNU); the IOResult is sealed before
    // the output stream is handed back.
    const [ok, err] = await readOperands(paths, stream, 'nl')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    return [
      nlMulti(
        ok.map((o) => o.data),
        config,
        io,
      ),
      io,
    ]
  }
  try {
    const source = resolveSource(opts.stdin, 'nl: missing operand')
    // The IOResult is handed back before the stream is drained, so the
    // overflow abort reports by mutating it as it goes.
    const io = new IOResult()
    return [
      nlStream(
        source,
        config,
        {
          number: config.start,
          section: 'body',
          blankRun: 0,
          overflowed: false,
          aborted: false,
        },
        io,
      ),
      io,
    ]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
}
