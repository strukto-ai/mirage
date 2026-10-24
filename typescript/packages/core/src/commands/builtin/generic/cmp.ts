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
import { YieldBudget } from '../../../io/yield_budget.ts'
import { closeStream, openStream } from '../../../rs/stream.ts'
import { byteView } from '../../../shell/bytes.ts'
import type { JsonValue } from '../../../types.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'
import { formatFsError } from '../../../errors/render.ts'
import { isEisdir, isFsError } from '../../../errors/fs.ts'
import { CMP_SIZE_UNITS, INTMAX, SUFFIXED_COUNT_PATTERN } from '../constants.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { isStdin, stdinStream } from '../utils/stream.ts'
import { parseBase0 } from '../utils/size_suffix.ts'
import { extraOperandError, missingOperandError, usageHint } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'
import { UsageError } from '../../errors.ts'

const ENC = new TextEncoder()

const TRY_HELP = `\n${usageHint(CommandName.CMP)}`

/**
 * One GNU `cmp` byte count, read the way diffutils 3.10 reads it.
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
  const match = SUFFIXED_COUNT_PATTERN.exec(raw)
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
 * The skips cmp's SKIP1 and SKIP2 operands give, beside -i's.
 *
 * Each is read as -i reads its counts, and each file keeps the larger of the
 * two skips it was given: a smaller one, from -i or from an operand, never
 * lowers the other. Past the fourth operand is an extra one, which GNU cmp
 * refuses only after both skips have parsed. Mirrors Python's operand_skips.
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

/** One operand's bytes as cmp pulls them, its first chunk read on open,
 * which is where an unreadable operand fails. Mirrors Python's _Operand. */
class Operand {
  private held: Uint8Array | null = null
  private readonly source: AsyncIterator<Uint8Array>

  constructor(source: Uint8Array | AsyncIterable<Uint8Array>, signal?: AbortSignal) {
    this.source = chunks(source, signal)
  }

  async open(): Promise<void> {
    const next = await this.source.next()
    this.held = next.done === true ? new Uint8Array() : next.value
  }

  /** The next chunk, null at the end. */
  async next(): Promise<Uint8Array | null> {
    const held = this.held
    this.held = null
    if (held !== null) return held.byteLength > 0 ? held : null
    const next = await this.source.next()
    return next.done === true ? null : next.value
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

/**
 * cmp's answer for two opened operands: the mirage-rs stream skips, compares
 * and words it, and asks for the operand it needs next, so without -l the
 * reads stop at the first difference. Mirrors Python's _compare.
 */
async function compare(
  operands: readonly [Operand, Operand],
  config: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
): Promise<[ByteSource | null, IOResult]> {
  const stream = await openStream('cmp', config)
  const budget = new YieldBudget(signal)
  const out: Uint8Array[] = []
  const drain = async (): Promise<void> => {
    while (stream.busy()) {
      await budget.run()
      out.push(stream.drain())
    }
  }
  try {
    for (let index = stream.wants(); index !== null; index = stream.wants()) {
      const chunk = await operands[index]?.next()
      out.push(chunk == null ? stream.endInput(index) : stream.feedInput(index, chunk))
      await drain()
    }
    out.push(stream.finish())
    await drain()
    const stdout = concat(out)
    const stderr = stream.takeStderr()
    return [
      stdout.byteLength > 0 ? stdout : null,
      new IOResult({ exitCode: stream.status(), stderr: stderr.byteLength > 0 ? stderr : null }),
    ]
  } finally {
    await closeStream(stream)
  }
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
  parsed: CmpFlags,
  options: Readonly<Record<string, JsonValue>>,
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
  const [out, io] = await compare(
    [new Operand(data.slice(skip[0] + skip[1])), new Operand(new Uint8Array())],
    { ...options, names: ['-', '-'], piped: [true, true], skip: [0, 0] },
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
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  sizeOf?: (p: PathSpec) => Promise<number | null>,
): Promise<[ByteSource | null, IOResult]> {
  const parsed = parseFlags(new FlagView(ctx.flags, specOf('cmp')))
  const p0 = paths[0]
  if (p0 === undefined) throw missingOperandError(CommandName.CMP, null, ctx.argv ?? [])
  const skip = operandSkips(texts, parsed.skip)
  // A lone FILE1 is compared with stdin, which GNU names `-`.
  const p1 = paths[1] ?? STDIN_OPERAND
  const read = stdinStream(stream, ctx.stdin, true)
  const options: Readonly<Record<string, JsonValue>> = {
    silent: parsed.silent,
    verbose: parsed.verbose,
    limit: parsed.limit,
    print_bytes: parsed.printBytes,
  }
  if (isStdin(p0) && isStdin(p1)) return oneStdinTwice(read, p0, skip, parsed, options)
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
      const operand = new Operand(read(p), ctx.signal)
      operands.push(operand)
      try {
        await operand.open()
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
    return await compare(
      operands as [Operand, Operand],
      {
        ...options,
        names: [byteView(p0.rawPath), byteView(p1.rawPath)],
        piped: [isStdin(p0), isStdin(p1)],
        skip: [skip[0], skip[1]],
      },
      ctx.signal,
    )
  } finally {
    for (const operand of operands) await operand.close()
  }
}
