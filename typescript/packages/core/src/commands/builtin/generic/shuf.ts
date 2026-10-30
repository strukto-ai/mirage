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

import { type util } from 'zod'
import { specOf } from '../../spec/builtins.ts'
import { C_SPACE, EOVERFLOW_TEXT, UINTMAX } from '../constants.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { usageHint } from '../../spec/usage.ts'
import { quoteText } from '../../quote.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { stripSlash } from '../../../utils/slash.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { stdinStream } from '../utils/stream.ts'
import { ByteSpool, MEMORY_LIMIT } from '../../../io/spool.ts'
import { CHUNK_SIZE, chunks } from '../../../io/cooperative.ts'
import { OutputStream, closeQuietly, rechunk } from '../../../io/stream.ts'
import {
  closeStream,
  openStream,
  runStream,
  serveRequests,
  type Served,
} from '../../../rs/stream.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { mountRoot } from '../utils/links.ts'
import { type IdSource, SystemIdSource, randomBelow, randomBelowBig } from '../../../utils/ids.ts'

const ENC = new TextEncoder()

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

// A `-o` reached a backend wired without a write op, which is a wiring fault
// rather than anything the command line did wrong, so it is thrown as a bare
// Error rather than returned like every user-facing refusal.
export const NO_WRITE_OP = 'shuf: backend provides no write op'

// GNU's own out-of-memory wording, exit 1. It is what real shuf answers with
// when a range is too large to materialize, so it is borrowed rather than
// invented. Measured, ground truth SH5.
export const MEMORY_EXHAUSTED = 'shuf: memory exhausted'

// `-i`'s bounds are `uintmax_t`, so a bound one past UINTMAX_MAX is refused
// with an overflow clause appended. The clause is EOVERFLOW's `strerror`, not
// ERANGE's: `nl -w` produces both and they read differently
// (`: Numerical result out of range` is the value outside an option's OWN
// range), while `shuf -i` has no range below the C type's and so only ever
// emits this one. Measured, ground truth SH1.
export const OVERFLOW_CLAUSE = `: ${EOVERFLOW_TEXT}`

export const MULTIPLE_RANGES = 'shuf: multiple -i options specified'

export const MULTIPLE_OUTPUTS = 'shuf: multiple output files specified'

const TRY_HELP = `\n${usageHint('shuf')}`

export const ECHO_WITH_RANGE = `shuf: cannot combine -e and -i options${TRY_HELP}`

export const SIZE_MAX = UINTMAX

// Preserve the existing one-million-record output limit. Output now streams;
// this limit bounds shuffle indexes and sampling state, not rendered bytes.
// GNU has no fixed ceiling and may enumerate larger populations.
export const MAX_OUTPUT_LINES = 1000000n

// Which of GNU's two `-i` refusals an argument earned. Not a pair of sentinels
// but two real answers with different bytes: `invalid` prints the bare
// `invalid input range: '<arg>'`, while `overflow`, a bound past UINTMAX_MAX,
// appends OVERFLOW_CLAUSE. The span limit (SH3) is `invalid`, not `overflow`,
// even though it is a magnitude that trips it. `RangeRefusal` in shuf.py is
// the twin.
export type RangeRefusal = 'invalid' | 'overflow'

// Render the one `-i` diagnostic, with the clause iff it is earned. The whole
// argument is quoted, as GNU quotes it, and routed through `quote()`.
export function rangeError(raw: string, refusal: RangeRefusal): string {
  const clause = refusal === 'overflow' ? OVERFLOW_CLAUSE : ''
  return `shuf: invalid input range: '${quoteText(raw)}'${clause}\n`
}

// GNU's `-i LO-HI`, read the way GNU reads it.
//
// Split at the FIRST dash and read each side as a number on its own, as GNU
// does. Doing it as one regex over the whole argument gets three shapes wrong:
// `-i +1-3` and `-i 1-+3` carry a `+` on either bound independently,
// `-i '1- 3'` puts the blank on the HIGH bound's prefix and is accepted, and
// `-i '1 -3'` is refused because that same blank is trailing garbage on the LOW
// one.
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
  if (low > UINTMAX) return 'overflow'
  if (!UNSIGNED.test(highRaw)) return 'invalid'
  const high = BigInt(highRaw)
  if (high > UINTMAX) return 'overflow'
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
  // The last `-o`, a PathSpec as every PATH-typed flag arrives.
  readonly output: PathSpec | null
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
// what `-i` does with the same overflow: a number past `uintmax_t` is fatal
// for `-i` and is quietly read as SIZE_MAX for `-n`, so
// `shuf -n 99999999999999999999999999` exits 0. Measured, ground truth SH6.
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
  // -o is PATH-typed, so its values are the words as typed, read off the
  // PathSpecs, which is what GNU compares two -o by.
  const typed = fl.typedOrder('head_count', 'input_range', 'output').flatMap((dest) => {
    const words = dest === 'output' ? fl.asPaths(dest).map((p) => p.rawPath) : fl.asList(dest)
    return words.map((raw): [string, string] => [dest, raw])
  })
  for (const [dest, raw] of typed) {
    if (dest === 'head_count') {
      if (!UNSIGNED.test(raw)) return `shuf: invalid line count: '${quoteText(raw)}'\n`
    } else if (dest === 'input_range') {
      if (inputRangeRaw !== null) return `${MULTIPLE_RANGES}\n`
      const bounds = parseInputRange(raw)
      if (typeof bounds === 'string') return rangeError(raw, bounds)
      inputRangeRaw = raw
    } else if (outputRaw !== null && outputRaw !== raw) {
      return `${MULTIPLE_OUTPUTS}\n`
    } else {
      outputRaw = raw
    }
  }
  if (fl.asBool('echo') && inputRangeRaw !== null) return `${ECHO_WITH_RANGE}\n`
  const countValue = fl.asList('head_count').at(-1)
  const count = countValue === undefined ? null : BigInt(countValue)
  const output = fl.asPaths('output').at(-1) ?? null
  return {
    count: count === null || count <= SIZE_MAX ? count : SIZE_MAX,
    echo: fl.asBool('echo'),
    zeroTerminated: fl.asBool('zero_terminated'),
    withReplacement: fl.asBool('repeat'),
    inputRange: inputRangeRaw,
    output,
  }
}

// How input past the memory budget is shuffled: scattered into this many
// buckets, each scattered again while it is still too large, at most this
// deep (one record larger than the budget stops anywhere). Mirrors Python.
const SCATTER_FAN_OUT = 16
const SCATTER_DEPTH = 4

class ShufHost {
  readonly errors = new ByteSpool()
  constructor(
    readonly ids: IdSource,
    readonly data?: ByteSpool,
    readonly index?: ByteSpool,
    readonly buckets: ByteSpool[] = [],
  ) {}

  async serve(request: Readonly<Record<string, util.JSONType>>, data: Uint8Array): Promise<Served> {
    switch (request.op) {
      case 'random': {
        if (typeof request.limit !== 'string') throw new Error('shuf: invalid random bound')
        const bound = BigInt(request.limit)
        const count = Number(request.count)
        const values = new Uint8Array(count * 8)
        const view = new DataView(values.buffer)
        for (let at = 0; at < count; at++) {
          const limit = request.descending === true ? bound - BigInt(at) : bound
          const draw =
            limit <= 0xffffffffn
              ? BigInt(randomBelow(this.ids, Number(limit)))
              : randomBelowBig(this.ids, limit)
          view.setBigUint64(at * 8, draw, true)
        }
        return { reply: {}, data: values }
      }
      case 'read': {
        const source = request.index === true ? this.index : this.data
        if (source === undefined) throw new Error('shuf: missing spool')
        return { reply: {}, data: await source.read(Number(request.offset), Number(request.size)) }
      }
      case 'swap': {
        if (this.index === undefined) throw new Error('shuf: missing index')
        const left = Number(request.left) * 16
        const right = Number(request.right) * 16
        const first = await this.index.read(left, 16)
        const second = await this.index.read(right, 16)
        await this.index.write(left, second)
        await this.index.write(right, first)
        return { reply: {} }
      }
      case 'write': {
        const bucket = this.buckets[Number(request.bucket)]
        if (bucket === undefined) throw new Error('shuf: missing bucket')
        await bucket.append(data)
        return { reply: {} }
      }
      default:
        throw new Error(`shuf: unknown request ${JSON.stringify(request.op)}`)
    }
  }
}

async function* engine(
  ids: IdSource,
  config: Readonly<Record<string, util.JSONType>>,
  data?: ByteSpool,
  index?: ByteSpool,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const stream = await openStream('shuf', config)
  const host = new ShufHost(ids, data, index)
  try {
    yield* serveRequests(stream, host, signal)
  } finally {
    await closeStream(stream)
    await host.errors.close()
  }
}

function rangeLines(
  ids: IdSource,
  low: bigint,
  high: bigint,
  need: number,
  repeat: boolean,
  separator: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  return engine(
    ids,
    { mode: 'range', separator, low: String(low), high: String(high), need, repeat },
    undefined,
    undefined,
    signal,
  )
}

async function countRecords(
  data: ByteSpool,
  terminator: number,
  signal?: AbortSignal,
): Promise<number> {
  let count = ''
  for await (const chunk of runStream(
    'shuf',
    { mode: 'count', separator: terminator },
    data.stream(),
    signal,
  ))
    count += new TextDecoder().decode(chunk)
  return Number(count)
}

async function* indexed(
  ids: IdSource,
  data: ByteSpool,
  terminator: number,
  available: number,
  need: number,
  repeat: boolean,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const index = new ByteSpool()
  try {
    await index.fill(
      runStream('shuf', { mode: 'index', separator: terminator }, data.stream(), signal),
    )
    yield* engine(
      ids,
      { mode: 'indexed', separator: terminator, size: data.size, available, need, repeat },
      data,
      index,
      signal,
    )
  } finally {
    await index.close()
  }
}

async function* shuffled(
  ids: IdSource,
  data: ByteSpool,
  terminator: number,
  available: number,
  need: number,
  depth = 0,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (need === 0) return
  if (data.size <= MEMORY_LIMIT) {
    yield* engine(
      ids,
      { mode: 'shuffle', separator: terminator, size: data.size, available, need },
      data,
      undefined,
      signal,
    )
    return
  }
  if (available === 1) {
    yield* data.stream()
    return
  }
  if (depth === SCATTER_DEPTH) {
    yield* indexed(ids, data, terminator, available, need, false, signal)
    return
  }
  const buckets = Array.from({ length: SCATTER_FAN_OUT }, () => new ByteSpool(0))
  const host = new ShufHost(ids, data, undefined, buckets)
  const stream = await openStream('shuf', {
    mode: 'scatter',
    separator: terminator,
    size: data.size,
  })
  try {
    for await (const chunk of serveRequests(stream, host, signal))
      if (chunk.length > 0) throw new Error('scatter writes buckets, not stdout')
    const counts = JSON.parse(new TextDecoder().decode(stream.metadata())) as number[]
    for (const [at, bucket] of buckets.entries()) {
      const count = counts[at] ?? 0
      const take = Math.min(need, count)
      yield* shuffled(ids, bucket, terminator, count, take, depth + 1, signal)
      await bucket.close()
      need -= take
      if (need === 0) break
    }
  } finally {
    await closeStream(stream)
    await host.errors.close()
    for (const bucket of buckets) await bucket.close()
  }
}

async function* drawn(
  ids: IdSource,
  data: ByteSpool,
  terminator: number,
  available: number,
  need: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (data.size > MEMORY_LIMIT) yield* indexed(ids, data, terminator, available, need, true, signal)
  else
    yield* engine(
      ids,
      { mode: 'draw', separator: terminator, size: data.size, available, need, repeat: true },
      data,
      undefined,
      signal,
    )
}

async function sampleRecords(
  ids: IdSource,
  sources: ByteSource[],
  sep: string,
  count: bigint | null,
  repeat: boolean,
  signal?: AbortSignal,
): Promise<ByteSource> {
  const terminator = sep.charCodeAt(0)
  const data = new ByteSpool()
  let available: number
  let need: number
  try {
    for (const source of sources) {
      await data.fill(chunks(source, signal))
      if (data.size > 0 && (await data.read(data.size - 1, 1))[0] !== terminator)
        await data.append(Uint8Array.of(terminator))
    }
    available = await countRecords(data, terminator, signal)
    const required = emitCount(BigInt(available), count, repeat)
    if (required > MAX_OUTPUT_LINES) throw new Error(MEMORY_EXHAUSTED)
    need = Number(required)
  } catch (error) {
    await data.close()
    throw error
  }
  const picks = repeat
    ? drawn(ids, data, terminator, available, need, signal)
    : shuffled(ids, data, terminator, available, need, 0, signal)
  return rechunk(new OutputStream(picks, () => data.close()), CHUNK_SIZE)
}

async function sampleItems(
  ids: IdSource,
  items: string[],
  count: bigint | null,
  repeat: boolean,
  separator: number,
  signal?: AbortSignal,
): Promise<ByteSource> {
  const need = emitCount(BigInt(items.length), count, repeat)
  if (need > MAX_OUTPUT_LINES) throw new Error(MEMORY_EXHAUSTED)
  const data = new ByteSpool()
  const index = new ByteSpool()
  const close = async (): Promise<void> => {
    try {
      await data.close()
    } finally {
      await index.close()
    }
  }
  try {
    const budget = new YieldBudget(signal)
    for (const item of items) {
      await budget.run()
      const raw = ENC.encode(item)
      const entry = new Uint8Array(16)
      const view = new DataView(entry.buffer)
      view.setBigUint64(0, BigInt(data.size), true)
      view.setBigUint64(8, BigInt(raw.length), true)
      await index.append(entry)
      await data.append(raw)
    }
    return rechunk(
      new OutputStream(
        engine(
          ids,
          {
            mode: 'indexed',
            separator,
            size: data.size,
            available: items.length,
            need: Number(need),
            repeat,
          },
          data,
          index,
          signal,
        ),
        close,
      ),
      CHUNK_SIZE,
    )
  } catch (error) {
    await close()
    throw error
  }
}

export async function shufGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: ByteSource) => Promise<void>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags)
  const ids = ctx.ids ?? new SystemIdSource()
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  const { count: nFlag, inputRange, echo: echoMode, zeroTerminated: zeroSep } = parsed
  const repeat = parsed.withReplacement
  const output =
    parsed.output === null
      ? null
      : new PathSpec({
          virtual: parsed.output.virtual,
          directory: parsed.output.virtual,
          vfsPath: stripSlash(parsed.output.virtual),
          resolved: true,
          rawPath: parsed.output.rawPath,
        })
  const sep = zeroSep ? '\x00' : '\n'

  let items: string[] = []
  // `-i` never fills `items`: it samples straight into the output, because the
  // range it names can hold 2**64 values (SH5).
  let result: ByteSource | null = null
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
    // earns the overflow clause (SH1).
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
    result = rangeLines(ids, low, high, Number(need), repeat, sep.charCodeAt(0), ctx.signal)
  } else if (echoMode) {
    // An operand -e echoes is named below the mount the command runs on.
    const root = mountRoot(ctx)
    items = paths.length > 0 ? paths.map((p) => `/${mountKey(p.virtual, root)}`) : [...texts]
  } else {
    try {
      result = await sampleRecords(
        ids,
        paths.length > 0 ? paths.map((p) => stream(p)) : [ctx.stdin ?? new Uint8Array()],
        sep,
        nFlag,
        repeat,
        ctx.signal,
      )
    } catch (error) {
      if (!(error instanceof Error) || error.message !== MEMORY_EXHAUSTED) throw error
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${MEMORY_EXHAUSTED}\n`) })]
    }
  }
  if (result === null) {
    const need = emitCount(BigInt(items.length), nFlag, repeat)
    if (need > MAX_OUTPUT_LINES) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${MEMORY_EXHAUSTED}\n`) })]
    }
    result = await sampleItems(ids, items, nFlag, repeat, sep.charCodeAt(0), ctx.signal)
  }
  if (output !== null) {
    try {
      await write(output, result)
    } catch (err) {
      if (!isFsError(err)) throw err
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode(`shuf: ${output.rawPath}: ${String(fsStrerror(err))}\n`),
        }),
      ]
    } finally {
      await closeQuietly(result)
    }
    return [null, new IOResult()]
  }
  return [result, new IOResult()]
}
