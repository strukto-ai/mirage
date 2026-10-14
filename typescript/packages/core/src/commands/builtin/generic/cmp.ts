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
import { concat } from '../../../utils/bytes.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { formatFsError } from '../../../errors/render.ts'
import { isEisdir, isFsError } from '../../../errors/fs.ts'
import { CMP_SIZE_UNITS, INTMAX, XSTRTOUMAX_PATTERN } from '../constants.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { formatRecords } from '../utils/output.ts'
import { isStdin, stdinStream } from '../utils/stream.ts'
import { parseBase0 } from '../utils/size_suffix.ts'
import { extraOperandError, missingOperandError, usageHint } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'
import { UsageError } from '../../errors.ts'

const ENC = new TextEncoder()

const TRY_HELP = `\n${usageHint(CommandName.CMP)}`
const NEWLINE = 0x0a

function octal(n: number, width = 0): string {
  return n.toString(8).padStart(width)
}

/**
 * One GNU `cmp` byte count read the way xstrtoumax reads it.
 *
 * Base 0, so `010` is 8 and `0x400` is 1024; one leading `+` and
 * leading whitespace are allowed; the remainder is a size suffix from
 * cmp's own letter set. Every rejection -- unparsable digits, unknown
 * suffix, or a product past INTMAX -- is the same usage error naming
 * the long option, not a crash and not od's "too large".
 *
 * `shown` overrides the spelling named in the diagnostic: GNU prints
 * the operand from the position it was reading, so a bad `SKIP1` names
 * the whole `SKIP1:SKIP2` pair while a bad `SKIP2` names only itself.
 *
 * The accept/reject boundary is computed in BigInt and so is exact, but
 * the returned count is a double like od's: above 2**53 it is the
 * nearest representable value, not python's exact integer. The count is
 * only ever a slice bound, and no file reaches an exabyte, so the two
 * runtimes still compare the same bytes.
 */
export function parseCount(raw: string, option: string, shown?: string): number {
  const error = new UsageError(`cmp: invalid ${option} value '${shown ?? raw}'${TRY_HELP}`)
  const match = XSTRTOUMAX_PATTERN.exec(raw)
  const suffix = match?.[2] ?? ''
  const unit = suffix === '' ? 1 : CMP_SIZE_UNITS[suffix]
  if (match === null || unit === undefined) throw error
  const count = parseBase0(match[1] ?? '') * BigInt(unit)
  if (count > INTMAX) throw error
  return Number(count)
}

/**
 * The `-i` operand as one skip per file.
 *
 * GNU takes `SKIP` for both files or `SKIP1:SKIP2` for one each, so
 * `-i 0:3` compares all of the first file against the fourth byte
 * onward of the second. A colon is the only place the first count may
 * stop, which is why `1b:1` is rejected naming the whole pair while
 * `1:1b` is rejected naming just `1b`.
 */
export function parseSkip(raw: string): [number, number] {
  const cut = raw.indexOf(':')
  if (cut === -1) {
    const both = parseCount(raw, '--ignore-initial')
    return [both, both]
  }
  return [
    parseCount(raw.slice(0, cut), '--ignore-initial', raw),
    parseCount(raw.slice(cut + 1), '--ignore-initial'),
  ]
}

/**
 * One byte rendered the way GNU `cmp -b` renders it.
 *
 * The cat -v alphabet: a control byte becomes `^X` (so tab is `^I`,
 * unlike `cat -v` itself), DEL becomes `^?`, and a high byte becomes
 * `M-` followed by the same rules on its low seven bits.
 */
export function visible(byte: number): string {
  if (byte >= 128) return `M-${visible(byte - 128)}`
  if (byte === 127) return '^?'
  if (byte < 32) return `^${String.fromCharCode(byte + 64)}`
  return String.fromCharCode(byte)
}

interface CmpFlags {
  readonly silent: boolean
  readonly verbose: boolean
  readonly limit: number | null
  readonly printBytes: boolean
  readonly skip: readonly [number, number]
}

function parseFlags(fl: FlagView): CmpFlags {
  const silent = fl.asBool('quiet') || fl.asBool('silent')
  const verbose = fl.asBool('verbose')
  // diffutils refuses the pair while it reads the options, so ahead of any
  // operand check.
  if (silent && verbose) throw new UsageError(`cmp: options -l and -s are incompatible${TRY_HELP}`)
  const nRaw = fl.asStr('bytes')
  const iRaw = fl.asStr('ignore_initial')
  return {
    silent,
    verbose,
    limit: nRaw === undefined ? null : parseCount(nRaw, '--bytes'),
    printBytes: fl.asBool('print_bytes'),
    skip: iRaw === undefined ? [0, 0] : parseSkip(iRaw),
  }
}

/**
 * GNU's `EOF on FILE` diagnostic for a common-prefix difference.
 *
 * It is a diagnostic, not output: GNU writes it to stderr and still
 * exits 1. A shorter file with no bytes to compare is `which is empty`.
 * Otherwise `-l` reports the byte only, and every other mode adds the
 * line: `line N` when the file ends on a newline, `in line N` when it
 * ends inside line N. `held` is how many bytes the shorter file had past
 * its skip, `lines` the newlines among them and `last` the last of them,
 * -1 for none. Mirrors Python's _eof_error.
 */
function eofError(
  shorter: string,
  held: number,
  lines: number,
  last: number,
  verbose: boolean,
): Uint8Array {
  if (held === 0) return ENC.encode(`cmp: EOF on ${shorter} which is empty\n`)
  let msg = `cmp: EOF on ${shorter} after byte ${String(held)}`
  if (!verbose) {
    msg += last === NEWLINE ? `, line ${String(lines)}` : `, in line ${String(lines + 1)}`
  }
  return ENC.encode(`${msg}\n`)
}

function newlines(data: Uint8Array): number {
  let count = 0
  for (const byte of data) if (byte === NEWLINE) count += 1
  return count
}

/**
 * The width GNU `cmp -l` pads its offset column to.
 *
 * GNU sizes the column for the largest offset it could print: the `-n`
 * limit, cut to the bytes left in each regular file after its skip. A
 * stream has no size to cut by, so a line comparing two of them pads to
 * the width of the largest file offset.
 */
function offsetWidth(sizes: readonly number[], limit: number | null): number {
  let most = limit !== null ? BigInt(limit) : INTMAX
  for (const size of sizes) if (BigInt(size) < most) most = BigInt(size)
  return String(most > 0n ? most : 0n).length
}

/**
 * The skips cmp's SKIP1 and SKIP2 operands give, beside -i's.
 *
 * Each is read as -i reads its counts, and each file keeps the larger of the
 * two skips it was given: diffutils' specify_ignore_initial only ever raises
 * one. Past the fourth operand is an extra one, which diffutils refuses only
 * after both skips have parsed. Mirrors Python's operand_skips.
 */
export function operandSkips(
  texts: readonly string[],
  skip: readonly [number, number],
): [number, number] {
  const skips: [number, number] = [skip[0], skip[1]]
  texts.slice(0, 2).forEach((raw, f) => {
    skips[f] = Math.max(skips[f] ?? 0, parseCount(raw, '--ignore-initial'))
  })
  const extra = texts[2]
  if (extra !== undefined) throw extraOperandError(CommandName.CMP, extra)
  return skips
}

interface Compared {
  readonly silent: boolean
  readonly verbose: boolean
  readonly limit: number | null
  readonly printBytes: boolean
}

/** One operand's bytes as cmp pulls them, a chunk at a time. Mirrors Python's
 * _Operand. */
class Operand {
  held: Uint8Array = new Uint8Array()
  private readonly source: AsyncIterator<Uint8Array>

  constructor(source: Uint8Array | AsyncIterable<Uint8Array>, signal?: AbortSignal) {
    this.source = chunks(source, signal)
  }

  /** Hold the next chunk when none is held; false at the end. */
  async pull(): Promise<boolean> {
    if (this.held.byteLength === 0) {
      const next = await this.source.next()
      if (next.done !== true) this.held = next.value
    }
    return this.held.byteLength > 0
  }

  /** Drop the first `count` bytes. */
  async skip(count: number): Promise<void> {
    let left = count
    while (left > 0 && (await this.pull())) {
      const dropped = Math.min(left, this.held.byteLength)
      this.held = this.held.subarray(dropped)
      left -= dropped
    }
  }

  /** What is left, up to `limit` bytes. */
  async rest(limit: number | null): Promise<Uint8Array> {
    const parts: Uint8Array[] = []
    let left = limit
    while ((left === null || left > 0) && (await this.pull())) {
      const part = left === null ? this.held : this.held.subarray(0, left)
      this.held = this.held.subarray(part.byteLength)
      parts.push(part)
      if (left !== null) left -= part.byteLength
    }
    return concat(parts)
  }

  async close(): Promise<void> {
    await this.source.return?.()
  }
}

/**
 * Whether `-s` can answer 1 from two regular files' sizes, unread: diffutils
 * does when the bytes left past each skip differ and the shorter run ends
 * within `-n`. A stdin operand, or a size the stat does not give, leaves it to
 * the read, as does a stat that fails, which the read then reports. Mirrors
 * Python's _sizes_differ.
 */
async function sizesDiffer(
  sizeOf: (p: PathSpec) => Promise<number | null>,
  paths: readonly [PathSpec, PathSpec],
  skip: readonly [number, number],
  limit: number | null,
): Promise<boolean> {
  const left: number[] = []
  for (const [index, p] of paths.entries()) {
    if (isStdin(p)) return false
    let size: number | null
    try {
      size = await sizeOf(p)
    } catch (err) {
      if (!isFsError(err)) throw err
      console.debug(`cmp: no size for ${p.virtual}: ${String(err)}`)
      return false
    }
    if (size === null) return false
    left.push(Math.max(size - (skip[index] ?? 0), 0))
  }
  const [a = 0, b = 0] = left
  return a !== b && (limit === null || Math.min(a, b) < limit)
}

/** GNU's `differ:` line for the first byte the files disagree on, at offset
 * `at` from the skip (from 0) on line `line`. Mirrors Python's _differ. */
function differ(
  names: readonly [string, string],
  at: number,
  line: number,
  a: number,
  b: number,
  printBytes: boolean,
): [ByteSource | null, IOResult] {
  // GNU counts in `byte` under -b and in `char` otherwise, on the same
  // offset -- the word tracks the flag, not a unit.
  const unit = printBytes ? 'byte' : 'char'
  let msg = `${names[0]} ${names[1]} differ: ${unit} ${String(at + 1)}, line ${String(line)}`
  if (printBytes) msg += ` is ${octal(a, 3)} ${visible(a)} ${octal(b, 3)} ${visible(b)}`
  return [formatRecords([msg]), new IOResult({ exitCode: 1 })]
}

/** cmp's answer without -l, read only to the first difference. Mirrors
 * Python's _streamed. */
async function streamed(
  first: Operand,
  second: Operand,
  names: readonly [string, string],
  parsed: Compared,
): Promise<[ByteSource | null, IOResult]> {
  const { silent, limit } = parsed
  let compared = 0
  let lines = 0
  let last = -1
  while (limit === null || compared < limit) {
    const more1 = await first.pull()
    const more2 = await second.pull()
    if (!more1 && !more2) return [null, new IOResult()]
    if (!more1 || !more2) {
      if (silent) return [null, new IOResult({ exitCode: 1 })]
      const shorter = more1 ? names[1] : names[0]
      return [
        null,
        new IOResult({ exitCode: 1, stderr: eofError(shorter, compared, lines, last, false) }),
      ]
    }
    let count = Math.min(first.held.byteLength, second.held.byteLength)
    if (limit !== null) count = Math.min(count, limit - compared)
    const a = first.held.subarray(0, count)
    const b = second.held.subarray(0, count)
    for (let at = 0; at < count; at++) {
      if (a[at] === b[at]) continue
      if (silent) return [null, new IOResult({ exitCode: 1 })]
      const line = 1 + lines + newlines(a.subarray(0, at))
      return differ(names, compared + at, line, a[at] ?? 0, b[at] ?? 0, parsed.printBytes)
    }
    compared += count
    lines += newlines(a)
    last = a[count - 1] ?? -1
    first.held = first.held.subarray(count)
    second.held = second.held.subarray(count)
  }
  return [null, new IOResult()]
}

/** cmp's answer for two inputs past their skips: read to the first
 * difference, or with -l, which lists every one, to the end. `piped` says
 * whether each is stdin, which has no size to width -l's offset column.
 * Mirrors Python's _answered. */
async function answered(
  first: Operand,
  second: Operand,
  names: readonly [string, string],
  piped: readonly [boolean, boolean],
  parsed: Compared,
): Promise<[ByteSource | null, IOResult]> {
  if (!parsed.verbose) return await streamed(first, second, names, parsed)
  const data1 = await first.rest(parsed.limit)
  const data2 = await second.rest(parsed.limit)
  const sizes = [data1, data2].filter((_, i) => !piped[i]).map((data) => data.byteLength)
  return listed(data1, data2, names, sizes, parsed)
}

/** cmp -l's answer for two inputs read past their skips and within `-n`: a
 * row for every byte they differ on. Mirrors Python's _listed. */
function listed(
  data1: Uint8Array,
  data2: Uint8Array,
  names: readonly [string, string],
  sizes: readonly number[],
  parsed: Compared,
): [ByteSource | null, IOResult] {
  const common = Math.min(data1.byteLength, data2.byteLength)
  let same = data1.byteLength === data2.byteLength
  for (let idx = 0; same && idx < common; idx++) if (data1[idx] !== data2[idx]) same = false
  if (same) return [null, new IOResult()]
  if (parsed.silent) return [null, new IOResult({ exitCode: 1 })]
  const width = offsetWidth(sizes, parsed.limit)
  const outLines: string[] = []
  for (let idx = 0; idx < common; idx++) {
    const a = data1[idx] ?? 0
    const b = data2[idx] ?? 0
    if (a === b) continue
    let row = `${String(idx + 1).padStart(width)} ${octal(a, 3)}`
    if (parsed.printBytes) row += ` ${visible(a).padEnd(4)}`
    row += ` ${octal(b, 3)}`
    if (parsed.printBytes) row += ` ${visible(b)}`
    outLines.push(row)
  }
  if (data1.byteLength === data2.byteLength) {
    return [formatRecords(outLines), new IOResult({ exitCode: 1 })]
  }
  const firstShorter = data1.byteLength < data2.byteLength
  const held = firstShorter ? data1 : data2
  const stderr = eofError(
    firstShorter ? names[0] : names[1],
    held.byteLength,
    0,
    held[held.byteLength - 1] ?? -1,
    true,
  )
  return [formatRecords(outLines), new IOResult({ exitCode: 1, stderr })]
}

/**
 * Both operands naming the one stdin, as diffutils 3.10 answers it for stdin
 * redirected from a regular file.
 *
 * One name at one skip is equal unread. Otherwise cmp skips on the one
 * descriptor twice, so the files sit at the first skip and at the sum of
 * both, and are equal unread when those match. -s then answers 1 unread when
 * the bytes left past each position differ within -n. Otherwise the first
 * file reads what is left past both skips and the second reads nothing, and
 * closing the descriptor a second time fails: that line and exit 2 follow
 * whatever the comparison said. A pipe fails both seeks, which GNU takes for
 * one position, so it answers 0 where this answers as the file. Mirrors
 * Python's _one_stdin_twice.
 */
async function oneStdinTwice(
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
  p: PathSpec,
  skip: readonly [number, number],
  parsed: Compared,
): Promise<[ByteSource | null, IOResult]> {
  if (skip[0] === skip[1] || skip[1] === 0) return [null, new IOResult()]
  const data = await materialize(read(p))
  const left = [
    Math.max(data.byteLength - skip[0], 0),
    Math.max(data.byteLength - skip[0] - skip[1], 0),
  ]
  if (parsed.silent && left[0] !== left[1]) {
    if (parsed.limit === null || Math.min(...left) < parsed.limit) {
      return [null, new IOResult({ exitCode: 1 })]
    }
  }
  const [out, io] = await answered(
    new Operand(data.slice(skip[0] + skip[1])),
    new Operand(new Uint8Array()),
    ['-', '-'],
    [true, true],
    parsed,
  )
  const held = io.stderr === null ? new Uint8Array() : await materialize(io.stderr)
  const tail = ENC.encode('cmp: -: Bad file descriptor\n')
  const stderr = new Uint8Array(held.byteLength + tail.byteLength)
  stderr.set(held)
  stderr.set(tail, held.byteLength)
  io.stderr = stderr
  io.exitCode = 2
  return [out, io]
}

/**
 * Compare two files byte by byte, GNU cmp semantics. Each file is streamed
 * and the reads stop at the first difference, or at `-n`; only `-l`, which
 * lists every difference, reads both to the end. Under `-s` two regular files
 * whose sizes past their skips differ answer 1 unread, as diffutils does.
 * Mirrors Python's cmp_cmd.
 */
export async function cmpGeneric(
  paths: PathSpec[],
  texts: readonly string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  sizeOf?: (p: PathSpec) => Promise<number | null>,
): Promise<[ByteSource | null, IOResult]> {
  const parsed = parseFlags(new FlagView(opts.flags, specOf('cmp')))
  const p0 = paths[0]
  if (p0 === undefined) throw missingOperandError(CommandName.CMP, null, opts.argv ?? [])
  const skip = operandSkips(texts, parsed.skip)
  // A lone FILE1 is compared with stdin, which GNU names `-`.
  const p1 = paths[1] ?? STDIN_OPERAND
  const read = stdinStream(stream, opts.stdin, true)
  if (isStdin(p0) && isStdin(p1)) return oneStdinTwice(read, p0, skip, parsed)
  const names = [p0.rawPath, p1.rawPath] as const
  const same = p0.virtual === p1.virtual && skip[0] === skip[1]
  if (
    parsed.silent &&
    sizeOf !== undefined &&
    !same &&
    (await sizesDiffer(sizeOf, [p0, p1], skip, parsed.limit))
  ) {
    return [null, new IOResult({ exitCode: 1 })]
  }
  // GNU cmp reserves exit 1 for "files differ"; trouble is exit 2.
  // diffutils 3.10 opens both operands before it reads either, and -s drops
  // the message only for an operand it cannot open: a directory opens, fails
  // at its first read, and is reported whatever -s says, unless both operands
  // name it, which is the same file at the same offset and so equal unread.
  // Opening is the first chunk's pull.
  const operands: Operand[] = []
  try {
    let unread: unknown = null
    for (const p of [p0, p1]) {
      const operand = new Operand(read(p), opts.signal)
      operands.push(operand)
      try {
        await operand.pull()
      } catch (err) {
        if (isEisdir(err)) {
          unread ??= err
          continue
        }
        if (!isFsError(err)) throw err
        const stderr = parsed.silent ? null : formatFsError('cmp', err, paths)
        return [null, new IOResult({ exitCode: 2, stderr })]
      }
    }
    if (same) return [null, new IOResult()]
    if (unread !== null)
      return [null, new IOResult({ exitCode: 2, stderr: formatFsError('cmp', unread, paths) })]
    const [first, second] = operands as [Operand, Operand]
    await first.skip(skip[0])
    await second.skip(skip[1])
    return await answered(first, second, names, [isStdin(p0), isStdin(p1)], parsed)
  } finally {
    for (const operand of operands) await operand.close()
  }
}
