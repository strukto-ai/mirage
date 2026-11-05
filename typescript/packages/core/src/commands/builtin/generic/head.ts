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
import { stdinStream, stdinStat } from '../utils/stream.ts'
import { IOResult } from '../../../io/types.ts'
import { isFsError } from '../../../errors/fs.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { FileType, Limit, type PathSpec, type StatFn, type ReadStreamFn } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
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
import { encodeText } from '../../../shell/bytes.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused, scan } from '../../../rs/scan.ts'
import { closeStream, openStream } from '../../../rs/stream.ts'
import { progress } from '../../../rs/select.ts'

export interface HeadFlags {
  readonly lines: number
  readonly bytesMode: number | null
  readonly quiet: boolean
  readonly verbose: boolean
  readonly zeroTerminated: boolean
}

/**
 * head's options, -n and -c read by mirage-rs before any operand is resolved:
 * the flags, or head's refusal of a count. Mirrors Python's `parse_flags`.
 */
export function parseFlags(bag: Record<string, FlagValue>): HeadFlags | IOResult {
  const fl = new FlagView(bag, specOf('head'))
  let values
  try {
    values = scan('head', fl.texts('lines', 'bytes'))
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  const { lines, bytes } = values
  if (
    (lines !== null && typeof lines !== 'number') ||
    (bytes !== null && typeof bytes !== 'number')
  ) {
    throw new Error(`head: mirage-rs read -n/-c as ${JSON.stringify(values)}`)
  }
  // The last of -q and -v decides, as in GNU head.
  const headers = fl.typedOrder('quiet', 'silent', 'verbose').at(-1)
  return {
    lines: lines ?? 10,
    bytesMode: bytes,
    quiet: headers === 'quiet' || headers === 'silent',
    verbose: headers === 'verbose',
    zeroTerminated: fl.asBool('zero_terminated'),
  }
}

async function* headStream(
  source: AsyncIterable<Uint8Array>,
  lines: number,
  bytesMode: number | null,
  zeroTerminated = false,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const count = bytesMode ?? lines
  const engine = await openStream('select', {
    mode: count >= 0 ? 'first' : 'except_last',
    unit: bytesMode === null ? 'records' : 'bytes',
    count: String(Math.abs(count)),
    terminator: zeroTerminated ? 0 : 10,
  })
  const pulls = chunks(source, signal, false)
  const budget = new YieldBudget(signal)
  try {
    if (engine.done()) return
    for await (const chunk of pulls) {
      const paused = budget.run()
      if (paused !== undefined) await paused
      for (let offset = 0; offset < chunk.byteLength; offset += CHUNK_SIZE) {
        let output = engine.feed(chunk.subarray(offset, offset + CHUNK_SIZE))
        for (;;) {
          const done = engine.done()
          if (done && source instanceof SharedInput && source.seekable) {
            const { consumed } = progress(engine)
            source.lines.unread(chunk.subarray(offset + consumed))
          }
          if (output.byteLength > 0) yield output
          if (done) return
          if (!engine.busy()) break
          const paused = budget.run()
          if (paused !== undefined) await paused
          output = engine.drain()
        }
      }
    }
    const tail = engine.finish()
    if (tail.byteLength > 0) yield tail
    while (engine.busy()) {
      const paused = budget.run()
      if (paused !== undefined) await paused
      const output = engine.drain()
      if (output.byteLength > 0) yield output
    }
  } finally {
    await closeStream(engine)
    await pulls.return?.(undefined)
  }
}

async function* headMulti(
  stream: ReadStreamFn,
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
 * `head_generic`; `parsed` holds the options, read before the operands were.
 */
export async function headGeneric(
  parsed: HeadFlags,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stat: StatFn,
  stream: ReadStreamFn,
  firstLines?: (p: PathSpec, n: number) => Promise<Uint8Array | null>,
): Promise<CommandFnResult> {
  stat = stdinStat(stat)
  stream = stdinStream(stream, ctx.stdin)
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
