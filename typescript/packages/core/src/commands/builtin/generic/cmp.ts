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
import { OutputStream } from '../../../io/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused, scan } from '../../../rs/scan.ts'
import { closeStream, mergeOutput, openStream } from '../../../rs/stream.ts'
import { byteView } from '../../../shell/bytes.ts'
import type { JsonValue } from '../../../types.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'
import { formatFsError } from '../../../errors/render.ts'
import { isEisdir, isFsError } from '../../../errors/fs.ts'
import { STDIN_OPERAND } from '../utils/constants.ts'
import { isStdin, stdinStream } from '../utils/stream.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'

const ENC = new TextEncoder()

export interface CmpFlags {
  readonly silent: boolean
  readonly verbose: boolean
  readonly limit: number | null
  readonly printBytes: boolean
  readonly skip: readonly [number, number]
}

/**
 * cmp's counts read by mirage-rs before any operand is resolved: -n, -i, -l
 * and -s in the order typed, so the first refusal is the one diffutils makes
 * while it reads its options, then the SKIP1 and SKIP2 operands of `texts`.
 * The flags, or cmp's refusal, exit 2. A count past 2**53 is the nearest
 * double, which no file reaches. Mirrors Python's `parse_flags`.
 */
export function parseFlags(
  bag: Record<string, FlagValue>,
  texts: readonly string[] = [],
): CmpFlags | IOResult {
  const fl = new FlagView(bag, specOf('cmp'))
  const typed = fl.texts('bytes', 'ignore_initial', 'verbose', 'silent', 'quiet')
  for (const text of texts.slice(0, 2)) typed.push(['skip', text])
  let values
  try {
    values = scan('cmp', typed)
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  const { limit, skip } = values
  const [first, second] = Array.isArray(skip) ? skip : []
  return {
    silent: fl.asBool('quiet') || fl.asBool('silent'),
    verbose: fl.asBool('verbose'),
    limit: typeof limit === 'number' ? limit : null,
    printBytes: fl.asBool('print_bytes'),
    skip: [typeof first === 'number' ? first : 0, typeof second === 'number' ? second : 0],
  }
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
  const io = new IOResult()
  const output = async function* (): AsyncGenerator<Uint8Array> {
    try {
      yield* mergeOutput(stream, async (index) => (await operands[index]?.next()) ?? null, signal)
    } finally {
      io.exitCode = stream.status()
      const stderr = stream.takeStderr()
      io.stderr = stderr.byteLength > 0 ? stderr : null
    }
  }
  const produced = output()
  const result = new OutputStream(produced, async () => {
    try {
      await produced.return(undefined)
      await closeStream(stream)
    } finally {
      for (const operand of operands) await operand.close()
    }
  })
  if (config.verbose !== true) {
    const bytes = await materialize(result)
    return [bytes.byteLength > 0 ? bytes : null, io]
  }
  return [result, io]
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
  const stdout = out === null ? null : await materialize(out)
  const held = io.stderr === null ? new Uint8Array() : await materialize(io.stderr)
  const tail = ENC.encode('cmp: -: Bad file descriptor\n')
  const stderr = new Uint8Array(held.byteLength + tail.byteLength)
  stderr.set(held)
  stderr.set(tail, held.byteLength)
  io.stderr = stderr
  io.exitCode = 2
  return [stdout, io]
}

/**
 * Compare two files byte by byte, GNU cmp semantics. Each file is streamed
 * and the reads stop at the first difference, or at `-n`; only `-l`, which
 * lists every difference, reads both to the end. Under `-s` two regular files
 * whose sizes past their skips differ answer 1 unread, as diffutils does.
 * Mirrors Python's cmp_cmd.
 */
export async function cmpGeneric(
  parsed: CmpFlags,
  paths: PathSpec[],
  texts: readonly string[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  sizeOf?: (p: PathSpec) => Promise<number | null>,
  lengthOf = sizeOf,
): Promise<[ByteSource | null, IOResult]> {
  const p0 = paths[0]
  if (p0 === undefined) throw missingOperandError(CommandName.CMP, null, ctx.argv ?? [])
  const extra = texts[2]
  if (extra !== undefined) throw extraOperandError(CommandName.CMP, extra)
  const skip = parsed.skip
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
    const sizes: (number | null)[] = [null, null]
    if (parsed.verbose && lengthOf !== undefined) {
      for (const [index, path] of [p0, p1].entries()) {
        if (!isStdin(path)) {
          try {
            sizes[index] = await lengthOf(path)
          } catch (err) {
            if (!isFsError(err)) throw err
            console.debug(`cmp: no size for ${path.virtual}: ${String(err)}`)
          }
        }
      }
    }
    const [first, second] = operands
    if (first === undefined || second === undefined) throw new Error("cmp inputs were not opened")
    const result = await compare(
      [first, second],
      {
        ...options,
        names: [byteView(p0.rawPath), byteView(p1.rawPath)],
        piped: [isStdin(p0), isStdin(p1)],
        skip: [skip[0], skip[1]],
        sizes,
      },
      ctx.signal,
    )
    operands.length = 0
    return result
  } finally {
    for (const operand of operands) await operand.close()
  }
}
