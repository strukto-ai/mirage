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

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * GNU's `EOF on FILE` diagnostic for a common-prefix difference.
 *
 * It is a diagnostic, not output: GNU writes it to stderr and still
 * exits 1. A shorter file with no bytes to compare is `which is empty`.
 * Otherwise `-l` reports the byte only, and every other mode adds the
 * line: `line N` when the file ends on a newline, `in line N` when it
 * ends inside line N.
 */
function eofError(
  names: readonly [string, string],
  data1: Uint8Array,
  data2: Uint8Array,
  verbose: boolean,
): Uint8Array {
  const firstShorter = data1.byteLength < data2.byteLength
  const shorter = firstShorter ? names[0] : names[1]
  const held = firstShorter ? data1 : data2
  if (held.byteLength === 0) return ENC.encode(`cmp: EOF on ${shorter} which is empty\n`)
  let msg = `cmp: EOF on ${shorter} after byte ${String(held.byteLength)}`
  if (!verbose) {
    let lines = 0
    for (const byte of held) if (byte === NEWLINE) lines += 1
    msg +=
      held[held.byteLength - 1] === NEWLINE
        ? `, line ${String(lines)}`
        : `, in line ${String(lines + 1)}`
  }
  return ENC.encode(`${msg}\n`)
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

/** cmp's answer for two inputs already past their skips. Mirrors Python's
 * _compared. */
function compared(
  first: Uint8Array,
  second: Uint8Array,
  names: readonly [string, string],
  sizes: readonly number[],
  parsed: Compared,
): [ByteSource | null, IOResult] {
  let data1 = first
  let data2 = second
  if (parsed.limit !== null) {
    data1 = data1.slice(0, parsed.limit)
    data2 = data2.slice(0, parsed.limit)
  }
  if (arraysEqual(data1, data2)) return [null, new IOResult()]
  if (parsed.silent) return [null, new IOResult({ exitCode: 1 })]
  const common = Math.min(data1.byteLength, data2.byteLength)
  if (parsed.verbose) {
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
    const io =
      data1.byteLength === data2.byteLength
        ? new IOResult({ exitCode: 1 })
        : new IOResult({ exitCode: 1, stderr: eofError(names, data1, data2, true) })
    return [formatRecords(outLines), io]
  }
  for (let idx = 0; idx < common; idx++) {
    const a = data1[idx] ?? 0
    const b = data2[idx] ?? 0
    if (a === b) continue
    let line = 1
    for (let k = 0; k < idx; k++) if (data1[k] === NEWLINE) line += 1
    // GNU counts in `byte` under -b and in `char` otherwise, on the
    // same offset -- the word tracks the flag, not a unit.
    const unit = parsed.printBytes ? 'byte' : 'char'
    let msg = `${names[0]} ${names[1]} differ: ${unit} ${String(idx + 1)}, line ${String(line)}`
    if (parsed.printBytes) {
      msg += ` is ${octal(a, 3)} ${visible(a)} ${octal(b, 3)} ${visible(b)}`
    }
    return [formatRecords([msg]), new IOResult({ exitCode: 1 })]
  }
  return [
    null,
    new IOResult({ exitCode: 1, stderr: eofError(names, data1, data2, parsed.verbose) }),
  ]
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
  const [out, io] = compared(
    data.slice(skip[0] + skip[1]),
    new Uint8Array(),
    ['-', '-'],
    [],
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

export async function cmpGeneric(
  paths: PathSpec[],
  texts: readonly string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<[ByteSource | null, IOResult]> {
  const parsed = parseFlags(new FlagView(opts.flags, specOf('cmp')))
  const p0 = paths[0]
  if (p0 === undefined) throw missingOperandError(CommandName.CMP, null, opts.argv ?? [])
  const skip = operandSkips(texts, parsed.skip)
  // A lone FILE1 is compared with stdin, which GNU names `-`.
  const p1 = paths[1] ?? STDIN_OPERAND
  const read = stdinStream(stream, opts.stdin)
  if (isStdin(p0) && isStdin(p1)) return oneStdinTwice(read, p0, skip, parsed)
  const names = [p0.rawPath, p1.rawPath] as const
  // GNU cmp reserves exit 1 for "files differ"; trouble is exit 2.
  // diffutils 3.10 opens both operands before it reads either, and -s drops
  // the message only for an operand it cannot open: a directory opens, fails
  // at its first read, and is reported whatever -s says, unless both operands
  // name it, which is the same file at the same offset and so equal unread.
  const data: Uint8Array[] = []
  let unread: unknown = null
  for (const p of [p0, p1]) {
    try {
      data.push(await materialize(read(p)))
    } catch (err) {
      if (isEisdir(err)) {
        unread ??= err
        data.push(new Uint8Array())
        continue
      }
      if (!isFsError(err)) throw err
      const stderr = parsed.silent ? null : formatFsError('cmp', err, paths)
      return [null, new IOResult({ exitCode: 2, stderr })]
    }
  }
  if (p0.virtual === p1.virtual && skip[0] === skip[1]) return [null, new IOResult()]
  if (unread !== null)
    return [null, new IOResult({ exitCode: 2, stderr: formatFsError('cmp', unread, paths) })]
  const data1 = data[0] ?? new Uint8Array()
  const data2 = data[1] ?? new Uint8Array()
  const sizes: number[] = []
  if (!isStdin(p0)) sizes.push(data1.byteLength - skip[0])
  if (!isStdin(p1)) sizes.push(data2.byteLength - skip[1])
  return compared(data1.slice(skip[0]), data2.slice(skip[1]), names, sizes, parsed)
}
