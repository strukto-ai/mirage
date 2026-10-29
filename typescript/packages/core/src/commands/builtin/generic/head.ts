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

import { isStdin, operandHeader, showsHeaders } from '../utils/stream.ts'
import { recordSeparator } from '../utils/lines.ts'
import { stdinStream, stdinStat } from '../utils/stream.ts'
import { IOResult } from '../../../io/types.ts'
import { isFsError } from '../../../errors/fs.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { FileType, Limit, type FileStat, type PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { numberFlagError, parseByteCount } from '../tail_counts.ts'
import { CHAR_DEVICE_MAX_BYTES } from '../utils/constants.ts'
import { asyncChain, closeQuietly } from '../../../io/stream.ts'
import { CHUNK_SIZE, chunks } from '../../../io/cooperative.ts'
import { SharedInput } from '../../../io/async_line_iterator.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { truncateStream } from '../utils/limit.ts'
import { reportFsError, splitOpened } from '../utils/operands.ts'
import { resolveSource } from '../utils/stream.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'
import { concat } from '../../../utils/bytes.ts'
import { encodeText } from '../../../shell/bytes.ts'

interface HeadFlags {
  lines: number
  bytesMode: number | null
  quiet: boolean
  verbose: boolean
  zeroTerminated: boolean
}

function parseFlags(bag: Record<string, FlagValue>): HeadFlags | string {
  const fl = new FlagView(bag, specOf('head'))
  const nRaw = fl.asStr('lines') ?? null
  const cRaw = fl.asStr('bytes') ?? null
  const numErr = numberFlagError('head', nRaw, cRaw)
  if (numErr !== null) return numErr
  // The last of -q and -v decides, as in GNU head.
  const headers = fl.typedOrder('quiet', 'silent', 'verbose').at(-1)
  return {
    lines: nRaw !== null ? Number.parseInt(nRaw, 10) : 10,
    bytesMode: cRaw !== null ? parseByteCount(cRaw) : null,
    quiet: headers === 'quiet' || headers === 'silent',
    verbose: headers === 'verbose',
    zeroTerminated: fl.asBool('zero_terminated'),
  }
}

/**
 * The lines of `chunk`, at most `wanted`, and where the last of them ends,
 * just past its delimiter (0 for none), counted a bounded slice at a time
 * with the budget run between slices, so a large chunk still lets its run
 * be stopped. Mirrors Python's `_count_lines`.
 */
async function countLines(
  chunk: Uint8Array,
  delimiter: number,
  wanted: number,
  budget: YieldBudget,
): Promise<[number, number]> {
  let found = 0
  let end = 0
  for (let start = 0; start < chunk.byteLength; start += CHUNK_SIZE) {
    const slice = chunk.subarray(start, start + CHUNK_SIZE)
    for (let at = slice.indexOf(delimiter); at >= 0; at = slice.indexOf(delimiter, at + 1)) {
      found += 1
      end = start + at + 1
      if (found === wanted) return [found, end]
    }
    const paused = budget.run()
    if (paused !== undefined) await paused
  }
  return [found, end]
}

/**
 * Emit the head of a stream like GNU `head`.
 *
 * Bytes (`bytesMode`): positive = first N bytes, negative = all but the last N
 * bytes, 0 = nothing. Lines (`lines`): positive = first N lines, negative = all
 * but the last N lines, 0 = nothing. A final line without a trailing newline is
 * preserved as-is (no newline is appended). head takes its input whole, writes
 * the producer's chunks on, as much of each as it keeps in one piece, and may
 * be called outside the factory's guard, so each pull races the abort, and a
 * line count checks it and yields to timers between bounded slices.
 */
async function* headStream(
  source: AsyncIterable<Uint8Array>,
  lines: number,
  bytesMode: number | null,
  zeroTerminated = false,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const pulls = chunks(source, signal, false)
  if (bytesMode !== null) {
    if (bytesMode === 0) return
    if (bytesMode > 0) {
      let remaining = bytesMode
      for await (const chunk of pulls) {
        if (chunk.byteLength >= remaining) {
          if (source instanceof SharedInput && source.seekable)
            source.lines.unread(chunk.subarray(remaining))
          if (remaining > 0) yield chunk.subarray(0, remaining)
          return
        }
        yield chunk
        remaining -= chunk.byteLength
      }
      return
    }
    const keep = -bytesMode
    let buf: Uint8Array = new Uint8Array(0)
    for await (const chunk of pulls) {
      buf = concat([buf, chunk])
      if (buf.byteLength > keep) {
        yield buf.subarray(0, buf.byteLength - keep)
        buf = buf.subarray(buf.byteLength - keep)
      }
    }
    return
  }

  const delimiter = recordSeparator(zeroTerminated)
  const budget = new YieldBudget(signal)
  if (lines >= 0) {
    if (lines === 0) return
    let emitted = 0
    for await (const chunk of pulls) {
      const [found, end] = await countLines(chunk, delimiter, lines - emitted, budget)
      emitted += found
      if (emitted < lines) {
        if (chunk.byteLength > 0) yield chunk
        continue
      }
      if (source instanceof SharedInput && source.seekable) source.lines.unread(chunk.subarray(end))
      yield chunk.subarray(0, end)
      return
    }
    return
  }

  // The chunks not yet written, each with its lines: what lies before the
  // last `keep` lines goes out as soon as it is known.
  const keep = -lines
  const kept: [Uint8Array, number][] = []
  let next = 0
  let held = 0
  for await (const chunk of pulls) {
    if (chunk.byteLength === 0) continue
    const [count] = await countLines(chunk, delimiter, chunk.byteLength + 1, budget)
    kept.push([chunk, count])
    held += count
    for (let entry = kept[next]; entry !== undefined && held > keep; entry = kept[next]) {
      const [first, firstCount] = entry
      const over = held - keep
      if (firstCount < over || (firstCount === over && first.at(-1) === delimiter)) {
        next += 1
        held -= firstCount
        yield first
        continue
      }
      const [, end] = await countLines(first, delimiter, over, budget)
      kept[next] = [first.subarray(end), firstCount - over]
      held = keep
      yield first.subarray(0, end)
    }
    if (next * 2 > kept.length) {
      kept.splice(0, next)
      next = 0
    }
  }
  const last = kept.at(-1)
  if (held === keep && last !== undefined && next < kept.length && last[0].at(-1) !== delimiter) {
    // The last line lacks its separator and still counts as one, so one
    // line more is not among the last.
    for (const [first, count] of kept.slice(next)) {
      if (count > 0) {
        yield first.subarray(0, first.indexOf(delimiter) + 1)
        break
      }
      yield first
    }
  }
}

type Stat = (p: PathSpec) => Promise<FileStat>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

async function* headMulti(
  stream: Stream,
  paths: readonly PathSpec[],
  lines: number,
  bytesMode: number | null,
  showHeaders: boolean,
  zeroTerminated: boolean,
  unread: ReadonlySet<string>,
  refused: ReadonlySet<string>,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  let printed = false
  for (const p of paths) {
    // A directory opened: its header prints and its read fails.
    const body = unread.has(p.virtual)
      ? null
      : headStream(stream(p), lines, bytesMode, zeroTerminated, signal)
    try {
      // The first pull opens the file, and `stream` names in `refused` one
      // whose open it refused, which prints no header, as GNU opens a file
      // before it heads it.
      const first = await body?.next()
      if (showHeaders && !refused.has(p.virtual)) {
        yield operandHeader(p, printed)
        printed = true
      }
      if (body === null || first === undefined || first.done === true) continue
      yield first.value
      for (let next = await body.next(); next.done !== true; next = await body.next()) {
        yield next.value
      }
    } finally {
      await closeQuietly(body)
    }
  }
}

/**
 * Run head over resolved operands, GNU semantics. A line count (`-n N`, or
 * the default 10) is asked of `firstLines` first, so a mount that can fetch
 * the start of a file on its own (a `LIMIT` on a table) does not send the
 * rest; null, or no `firstLines`, reads the file. Mirrors Python's
 * `head_generic`.
 */
export async function headGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stat: Stat,
  stream: Stream,
  firstLines?: (p: PathSpec, n: number) => Promise<Uint8Array | null>,
): Promise<CommandFnResult> {
  stat = stdinStat(stat)
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(parsed) })]
  }
  if (paths.length > 0) {
    const showHeaders = showsHeaders(parsed.verbose, parsed.quiet, paths.length)
    const [opened, unread, err] = await splitOpened(paths, stat, 'head')
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: err === '' ? null : encodeText(err),
    })
    if (opened.length === 0) return [null, io]
    const refused = new Set<string>()
    const pushed = parsed.bytesMode === null && !parsed.zeroTerminated && parsed.lines > 0
    const sourceFor = async function* (p: PathSpec): AsyncIterable<Uint8Array> {
      try {
        const source = stream(p)
        if ((await stat(p)).type === FileType.CHAR_DEVICE && parsed.bytesMode === null) {
          yield* truncateStream(source, io, new Limit({ maxBytes: CHAR_DEVICE_MAX_BYTES }))
          return
        }
        if (pushed && firstLines !== undefined && !isStdin(p)) {
          const lines = await firstLines(p, parsed.lines)
          if (lines !== null) {
            yield lines
            return
          }
        }
        yield* source
      } catch (err) {
        if (!isFsError(err)) throw err
        // Reported as it happens, so a reader that stops at the header still
        // leaves the status; the next operand still prints. One whose open was
        // refused prints no header; a read that fails once the stat passed (a
        // table past its read cap) keeps it.
        const code = (err as { code?: string }).code
        if (code === undefined || !READ_FAILURES.has(code)) refused.add(p.virtual)
        await reportFsError(io, 'head', p, err)
      }
    }
    return [
      headMulti(
        (path) => (isStdin(path) && ctx.stdin instanceof SharedInput ? ctx.stdin : sourceFor(path)),
        opened,
        parsed.lines,
        parsed.bytesMode,
        showHeaders,
        parsed.zeroTerminated,
        unread,
        refused,
        ctx.signal,
      ),
      io,
    ]
  }
  const source = resolveSource(ctx.stdin)
  const body = headStream(source, parsed.lines, parsed.bytesMode, parsed.zeroTerminated, ctx.signal)
  // -v heads a stdin nobody named with the name it gives `-`.
  return [
    parsed.verbose && !parsed.quiet ? asyncChain([operandHeader(null), body]) : body,
    new IOResult(),
  ]
}
