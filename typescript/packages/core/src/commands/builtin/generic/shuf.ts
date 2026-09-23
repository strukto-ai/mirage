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

import { specOf } from '../../spec/builtins.ts'
import { C_SPACE } from '../constants.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { quoteText } from '../../quote.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

function shuffleInPlace(arr: string[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i] ?? ''
    arr[i] = arr[j] ?? ''
    arr[j] = tmp
  }
}

function choicesWithReplacement(items: readonly string[], k: number): string[] {
  if (items.length === 0) return []
  const out: string[] = []
  for (let i = 0; i < k; i++) {
    out.push(items[Math.floor(Math.random() * items.length)] ?? '')
  }
  return out
}

// `_sample` in shuf.py is the twin: `emitCount` first, so an output too large
// to render is refused before any of it is built.
function processItems(items: string[], repeat: boolean, need: number): string[] {
  if (repeat) return choicesWithReplacement(items, need)
  shuffleInPlace(items)
  return items.slice(0, need)
}

// GNU accepts a leading `+` and reads `+2` as 2, and `0` is a valid head
// count. A `-` is not a sign here but an invalid character, so `-1` is refused
// and quoted whole with no out-of-range clause: shuf rejects the sign while
// scanning rather than range-checking a parsed negative. Anchored at both ends
// so a trailing newline (`shuf -n $'2\n'`) is refused, which is what the
// python twin's `fullmatch` answers.
//
// The leading `C_SPACE` run is `strtoumax`'s own skip and is real GNU
// behavior: `shuf -n ' 2'`, `$'\t2'`, `$'\n2'` and `' +2'` are all accepted
// while `'2 '` is refused. Measured, ground truth NL3-C.
//
// The same scan reads each `-i` bound: GNU splits that argument at the FIRST
// dash and hands each side to its own `strtoumax`, so a bound carries its own
// whitespace and `+`. See parseInputRange.
const UNSIGNED = new RegExp(`^${C_SPACE}\\+?[0-9]+$`)

// GNU's own `xalloc_die` wording, exit 1. It is what real shuf answers with
// when a range is too large to materialize, so it is borrowed rather than
// invented. Measured, ground truth SH5.
export const MEMORY_EXHAUSTED = 'shuf: memory exhausted'

// `-i`'s bounds are `uintmax_t`, so a bound one past UINTMAX_MAX is refused
// with gnulib's LONGINT_OVERFLOW clause appended. The clause is EOVERFLOW's
// `strerror`, not ERANGE's: `nl -w` produces both and they read differently
// (`: Numerical result out of range` is the value outside an option's OWN
// range), while `shuf -i` has no range below the C type's and so only ever
// emits this one. Measured, ground truth SH1.
export const OVERFLOW_CLAUSE = ': Value too large for defined data type'

export const MULTIPLE_RANGES = 'shuf: multiple -i options specified'

export const MULTIPLE_OUTPUTS = 'shuf: multiple output files specified'

const TRY_HELP = "\nTry 'shuf --help' for more information."

export const ECHO_WITH_RANGE = `shuf: cannot combine -e and -i options${TRY_HELP}`

export const UINTMAX_MAX = 18446744073709551615n
export const SIZE_MAX = 18446744073709551615n

// How many lines shuf will render into one byte object before answering
// `memory exhausted`. GNU has no such number: it streams, so a huge range with
// no `-n` merely allocates until the allocator gives up (which it did at 1e8
// elements under a 512 MiB cap and not at all without one, so the threshold is
// an allocator outcome and not a spec -- ground truth SH5). mirage cannot
// stream, because a command answers with one rendered object, so the ceiling is
// stated here instead of being whatever the host happens to survive. This is
// the deliberate divergence: a range GNU would enumerate given enough memory is
// refused above this, with GNU's own wording for the same situation.
export const MAX_OUTPUT_LINES = 1000000n

// Which of GNU's two `-i` refusals an argument earned. Not a pair of sentinels
// but two real answers with different bytes: `invalid` is gnulib's
// LONGINT_INVALID and prints the bare `invalid input range: '<arg>'`, while
// `overflow` is LONGINT_OVERFLOW and appends OVERFLOW_CLAUSE. The span limit
// (SH3) is `invalid`, not `overflow`, even though it is a magnitude that trips
// it. `RangeRefusal` in shuf.py is the twin.
export type RangeRefusal = 'invalid' | 'overflow'

// Render the one `-i` diagnostic, with the clause iff it is earned. The whole
// argument is quoted, as GNU quotes it, and routed through `quote()`.
export function rangeError(raw: string, refusal: RangeRefusal): string {
  const clause = refusal === 'overflow' ? OVERFLOW_CLAUSE : ''
  return `shuf: invalid input range: '${quoteText(raw)}'${clause}\n`
}

// GNU's `-i LO-HI`, read the way GNU reads it.
//
// Split at the FIRST dash and scan each side on its own, which is what
// `strchr(optarg, '-')` plus two `strtoumax` calls amount to. Doing it as one
// regex over the whole argument gets three shapes wrong: `-i +1-3` and
// `-i 1-+3` carry a `+` on either bound independently, `-i '1- 3'` puts the
// blank on the HIGH bound's prefix and is accepted, and `-i '1 -3'` is refused
// because that same blank is trailing garbage on the LOW one.
//
// A `-` is never a sign here, so an empty low bound (`-i -1-3`, where the
// first dash is at index 0) and a negative high bound (`-i 1--3`) are both
// refused, as is a second dash anywhere (`-i 1-2-3`). Measured, ground truth
// NL3-D.
//
// Two magnitude limits sit on top of that shape, they are different limits, and
// they print differently. A bound may be as large as UINTMAX_MAX and one past
// it is `overflow`; the SPAN `high - low` must be strictly under SIZE_MAX and
// the one argument that trips that (`-i 0-18446744073709551615`, whose element
// count is 2**64) is `invalid` with no clause, exactly as a decreasing range is.
// The scan is left to right and stops at the first failure, so an overflowing
// low bound outranks a non-numeric high one (`-i 18446744073709551616-x` is
// `overflow`) while a non-numeric low bound outranks an overflowing high one
// (`-i x-18446744073709551616` is `invalid`). Measured, ground truth SH1, SH3
// and SH4.
//
// The bounds come back as `bigint`, which is the fix for the reviewed bug:
// `Number.parseInt` read a bound at 2**53 as a float64 that increments to
// itself, so enumerating a one-element range there never terminated, and
// 2**53+1 parsed to the wrong integer outright and printed it with exit 0
// (SH2). python's ints are arbitrary precision, so its twin needed nothing.
//
// `parse_input_range` in shuf.py is the twin.
export function parseInputRange(raw: string): [bigint, bigint] | RangeRefusal {
  const dash = raw.indexOf('-')
  if (dash < 0) return 'invalid'
  const lowRaw = raw.slice(0, dash)
  const highRaw = raw.slice(dash + 1)
  if (!UNSIGNED.test(lowRaw)) return 'invalid'
  // `BigInt` skips the same leading C whitespace and single `+` the regex just
  // accepted, and the regex has already refused everything else, so this cannot
  // throw and cannot read a prefix.
  const low = BigInt(lowRaw)
  if (low > UINTMAX_MAX) return 'overflow'
  if (!UNSIGNED.test(highRaw)) return 'invalid'
  const high = BigInt(highRaw)
  if (high > UINTMAX_MAX) return 'overflow'
  if (low > high || high - low >= SIZE_MAX) return 'invalid'
  return [low, high]
}

// How many lines shuf will emit, before any of them are built.
//
// Computed rather than discovered, because `-i` can name 2**64 values and GNU
// answers `-i 1-18446744073709551615 -n 3` instantly by never building the
// population (SH5). Knowing the emitted count up front is what lets the range
// path sample instead of enumerate, and what lets an output larger than
// MAX_OUTPUT_LINES be refused without allocating it.
//
// `-r` draws independently, so it emits exactly the requested count however few
// values it is drawing from -- except from nothing at all, which emits nothing.
// Without `-r` the count is a head count over a permutation, so it cannot
// exceed what is available.
//
// `emit_count` in shuf.py is the twin.
export function emitCount(
  available: bigint,
  count: bigint | null,
  withReplacement: boolean,
): bigint {
  if (withReplacement) {
    if (available === 0n) return 0n
    return count ?? available
  }
  if (count === null) return available
  return count < available ? count : available
}

// A uniform bigint in [0, limit), built from 32-bit `Math.random` chunks and
// rejected down to the exact limit. `Math.random` cannot serve a range wider
// than 2**53 on its own, and `-i`'s span reaches 2**64 - 1, so the range path
// cannot borrow the float32 draw `shuffleInPlace` uses for arrays. The
// rejection loop discards at most half the draws, since `bits` is the limit's
// own bit length. `random.randint` is the python twin and needs no help: its
// integers are arbitrary precision already.
function randomBelow(limit: bigint): bigint {
  const bits = limit.toString(2).length
  const chunks = Math.ceil(bits / 32)
  const shift = BigInt(chunks * 32 - bits)
  for (;;) {
    let drawn = 0n
    for (let i = 0; i < chunks; i++) {
      drawn = (drawn << 32n) | BigInt(Math.floor(Math.random() * 4294967296))
    }
    const value = drawn >> shift
    if (value < limit) return value
  }
}

// Emit `need` values from the inclusive range, never enumerating it.
//
// GNU is lazy exactly here: with a `-n` below the element count it never builds
// the population, which is why `shuf -i 1-18446744073709551615 -n 3` answers
// instantly (ground truth SH5). So the range is materialized only when it is
// small enough to be, and otherwise the sample is drawn value by value.
//
// The draw loop terminates because `need` is at most MAX_OUTPUT_LINES, which
// the first branch has already established is below the element count, so there
// is always an undrawn value left. Drawing in sequence and rejecting a repeat is
// sampling without replacement in order -- the same distribution as shuffling
// the whole population and taking a prefix.
//
// `_range_lines` in shuf.py is the twin.
function rangeLines(low: bigint, high: bigint, need: number, repeat: boolean): string[] {
  const size = high - low + 1n
  if (repeat) {
    const out: string[] = []
    for (let i = 0; i < need; i++) out.push(String(low + randomBelow(size)))
    return out
  }
  if (size <= MAX_OUTPUT_LINES) {
    const items: string[] = []
    // A bigint increment is exact, which is the whole point: read as float64 a
    // bound at 2**53 increments to itself and this loop never ends (SH2).
    for (let value = low; value <= high; value++) items.push(String(value))
    shuffleInPlace(items)
    return items.slice(0, need)
  }
  const drawn = new Set<bigint>()
  const out: string[] = []
  while (out.length < need) {
    const value = low + randomBelow(size)
    if (drawn.has(value)) continue
    drawn.add(value)
    out.push(String(value))
  }
  return out
}

export interface ShufFlags {
  // `bigint`, matching python's arbitrary-precision `int`. `-n` is clamped at
  // SIZE_MAX rather than refused (SH6), and `Number.parseInt` cannot carry that
  // clamp: a 400-digit count parses to `Infinity`, which `BigInt` then refuses
  // outright, where python reads the bignum and clamps it.
  readonly count: bigint | null
  readonly echo: boolean
  readonly zeroTerminated: boolean
  readonly withReplacement: boolean
  readonly inputRange: string | null
  // The raw `-o` word. The python executor promotes a PATH-typed flag to a
  // PathSpec and reads it with as_paths; this bag carries the resolved
  // virtual-path string, so asStr is the twin and the PathSpec is built at
  // the call site.
  readonly output: string | null
}

// Read shuf's flags once, refusing a head count GNU refuses.
//
// GNU quotes the WHOLE `-n` argument, not just the unparsed remainder the way
// expand and cut do, and never appends an out-of-range clause to it.
// Pre-validated the way head/tail do it, so the `BigInt` below cannot hand back
// a prefix and cannot throw. Returns the stderr text instead of the struct when
// GNU refuses the line, the shape every sibling generic's parseFlags uses.
//
// A `-n` past UINTMAX_MAX is CLAMPED, never refused, which is the opposite of
// what `-i` does with the same overflow: `xstrtoumax` answering
// LONGINT_OVERFLOW is fatal for `-i` and is quietly read as SIZE_MAX for `-n`,
// so `shuf -n 99999999999999999999999999` exits 0. Measured, ground truth SH6.
// Read shuf's flags once, refusing what GNU refuses in GNU's order.
//
// GNU validates each option as getopt hands it over, so the refusal that
// wins is the first bad option ON THE LINE: `shuf -i 1-x -n abc` names the
// range and `shuf -n abc -i 1-x` names the count (measured on coreutils
// 9.7). The three value options are therefore declared `multiple`
// (argparse's `append`) and walked in the order their first occurrence was
// typed, each value in turn, which is also what makes a repeat visible: a
// second `-i` is refused outright (`multiple -i options specified`, even
// for the same range), and a second `-o` is refused unless it spells the
// same word. `-e` with `-i` is checked after the scan, so any per-option
// refusal outranks it. Deliberate divergence: an option repeated AFTER a
// different bad one is checked first here (`shuf -i 1-2 -n abc -i 3-4`
// refuses the second `-i` where GNU names the count), because keeping the
// line's own order would take a per-occurrence record across options,
// which neither argparse nor this parser keeps. Mirrors `parse_flags` in
// shuf.py.
export function parseFlags(bag: Record<string, FlagValue>): ShufFlags | string {
  const fl = new FlagView(bag, specOf('shuf'))
  let inputRangeRaw: string | null = null
  let outputRaw: string | null = null
  const typed = fl
    .typedOrder('head_count', 'input_range', 'output')
    .flatMap((dest) => fl.asList(dest).map((raw): [string, string] => [dest, raw]))
  for (const [dest, raw] of typed) {
    if (dest === 'head_count') {
      if (!UNSIGNED.test(raw)) return `shuf: invalid line count: '${quoteText(raw)}'\n`
    } else if (dest === 'input_range') {
      if (inputRangeRaw !== null) return `${MULTIPLE_RANGES}\n`
      const bounds = parseInputRange(raw)
      if (typeof bounds === 'string') return rangeError(raw, bounds)
      inputRangeRaw = raw
    } else if (outputRaw !== null && outputRaw !== raw) {
      // Deliberate divergence: the TypeScript bag carries a PATH option's
      // resolved virtual path, not the word typed, so `-o out -o ./out`
      // reads as one output here where GNU (and the python twin, which
      // still sees the raw word) refuses it as two.
      return `${MULTIPLE_OUTPUTS}\n`
    } else {
      outputRaw = raw
    }
  }
  if (fl.asBool('echo') && inputRangeRaw !== null) return `${ECHO_WITH_RANGE}\n`
  const countValue = fl.asList('head_count').at(-1)
  const count = countValue === undefined ? null : BigInt(countValue)
  return {
    count: count === null || count <= SIZE_MAX ? count : SIZE_MAX,
    echo: fl.asBool('echo'),
    zeroTerminated: fl.asBool('zero_terminated'),
    withReplacement: fl.asBool('repeat'),
    inputRange: inputRangeRaw,
    output: outputRaw,
  }
}

export async function shufGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  const { count: nFlag, inputRange, echo: echoMode, zeroTerminated: zeroSep } = parsed
  const repeat = parsed.withReplacement
  const output =
    parsed.output === null
      ? null
      : new PathSpec({
          virtual: parsed.output,
          directory: parsed.output,
          vfsPath: mountKey(parsed.output, opts.mountPrefix ?? ''),
          resolved: true,
        })
  const sep = zeroSep ? '\x00' : '\n'

  let items: string[] = []
  // `-i` never fills `items`: it samples straight into the output, because the
  // range it names can hold 2**64 values (SH5).
  let out: string[] | null = null
  if (inputRange !== null) {
    const extra = paths[0]
    if (extra !== undefined) {
      // GNU: -i names the input, so a file operand is one too many.
      const word = extra.rawPath !== '' ? extra.rawPath : extra.virtual
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode(`shuf: extra operand '${quoteText(word)}'${TRY_HELP}\n`),
        }),
      ]
    }
    // `-i` takes two unsigned bounds with the low one no greater than the
    // high one. Every other shape is one message, so a negative low bound
    // (`-2-1`) and a decreasing range (`3-1`) are refused here rather than
    // read as a range; shuf has no decreasing-range diagnostic of its own.
    // The one shape that reads differently is a bound past UINTMAX_MAX, which
    // earns gnulib's overflow clause (SH1).
    const bounds = parseInputRange(inputRange)
    if (typeof bounds === 'string') {
      return [
        null,
        new IOResult({ exitCode: 1, stderr: ENC.encode(rangeError(inputRange, bounds)) }),
      ]
    }
    const [low, high] = bounds
    const need = emitCount(high - low + 1n, nFlag, repeat)
    if (need > MAX_OUTPUT_LINES) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${MEMORY_EXHAUSTED}\n`) })]
    }
    out = rangeLines(low, high, Number(need), repeat)
  } else if (echoMode) {
    const base = paths.length > 0 ? paths.map((p) => p.mountPath) : [...texts]
    items = base
  } else if (paths.length > 0) {
    items = []
    for (const p of paths) {
      const data = DEC.decode(await materialize(stream(p)))
      if (zeroSep) for (const l of data.split('\x00')) items.push(l)
      else for (const l of splitLinesNoTrailing(data)) items.push(l)
    }
  } else {
    const stdinData = await readStdinAsync(opts.stdin)
    if (stdinData === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('shuf: missing operand\n') })]
    }
    const text = DEC.decode(stdinData)
    items = zeroSep ? text.split('\x00') : splitLinesNoTrailing(text)
  }
  if (out === null) {
    const need = emitCount(BigInt(items.length), nFlag, repeat)
    if (need > MAX_OUTPUT_LINES) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${MEMORY_EXHAUSTED}\n`) })]
    }
    out = processItems(items, repeat, Number(need))
  }
  // `shuf -n 0` is valid and prints zero bytes, so the separator
  // terminates each line rather than being appended to the join.
  const result: ByteSource = ENC.encode(out.length === 0 ? '' : out.join(sep) + sep)
  if (output !== null) {
    await write(output, result)
    return [null, new IOResult({ writes: { [output.mountPath]: result } })]
  }
  return [result, new IOResult()]
}
