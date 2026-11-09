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

import { isStdin, operandHeader, rangedStream, showsHeaders } from '../utils/stream.ts'
import { stdinStream, stdinStat } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { closeQuietly } from '../../../io/stream.ts'
import { abortable, hasAborted } from '../../../utils/abort.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import {
  FileType,
  type FileStat,
  type JsonValue,
  type PathSpec,
  type ReadStreamFn,
  type StatFn,
} from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import type { SessionProcesses } from '../../../execution/process/session.ts'
import { enoent, fsStrerror, isEisdir, isFsError } from '../../../errors/fs.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { shellQuote } from '../../../utils/quote.ts'
import { operandLines, reportFsError, say, splitOpened } from '../utils/operands.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { CHUNK_SIZE, chunks } from '../../../io/cooperative.ts'
import { checkMemory } from '../../../io/memory.ts'
import { concat } from '../../../utils/bytes.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { revisionFor } from '../../../observe/context.ts'
import { dispatchOf } from '../utils/links.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused, scan } from '../../../rs/scan.ts'
import { openStream, closeStream } from '../../../rs/stream.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { progress } from '../../../rs/select.ts'

/**
 * `-n`/`-c` split by the end they count from. A leading `+` counts forward
 * from the start, 1-indexed, so `+0` and `+1` both mean the whole input; any
 * other spelling counts back from the end. Mirrors Python's `TailCounts`.
 */
export interface TailCounts {
  readonly lines: number | null
  readonly fromLine: number | null
  readonly byteCount: number | null
  readonly fromByte: number | null
  /** The byte that ends a line, NUL under `-z`; 10 when left off. */
  readonly terminator?: number
}

/**
 * Fill in whatever a caller left off a `TailCounts`.
 *
 * The struct is a plain object, so a caller that omits a field — or a
 * JavaScript one that passes something else entirely — supplies undefined,
 * and a bare `!== null` test waves that straight into the first branch,
 * where `slice(NaN)` quietly returns the whole input. Python's twin is a
 * dataclass whose four fields all default to None and has no such hole;
 * reading every field through `?? null` gives this side the same floor.
 */
export function normalizeCounts(counts: TailCounts): TailCounts {
  return {
    lines: counts.lines ?? null,
    fromLine: counts.fromLine ?? null,
    byteCount: counts.byteCount ?? null,
    fromByte: counts.fromByte ?? null,
    terminator: counts.terminator ?? 10,
  }
}

/**
 * -f/--follow[=HOW], -F, --retry, -s and --pid as tail reads them: a follow
 * ends once `pid`'s process is gone, and 0 names none.
 */
export interface FollowFlags {
  readonly follow: boolean
  readonly byName: boolean
  readonly retry: boolean
  readonly interval: number
  readonly pid: number | null
}

// -f, --follow[=HOW] and -F as (follow, by name, retry), `how` the --follow
// word mirage-rs read, if typed. -F is --follow=name --retry. The mode is
// whichever of -f/--follow and -F came last, GNU's own order
// (`-F --follow=descriptor` follows the descriptor), while -F's --retry half
// stays on either way.
function followFlags(fl: FlagView, how: string | null): [boolean, boolean, boolean] {
  const raw: unknown = fl.raw('follow')
  const typed = fl
    .typedOrder('follow', 'F')
    .filter((k) =>
      k === 'F' ? fl.asBool('F') : raw !== undefined && raw !== null && raw !== false,
    )
  const follow = typed.length > 0
  const byName = follow && (typed[typed.length - 1] === 'F' || how === 'name')
  return [follow, byName, fl.asBool('retry') || typed.includes('F')]
}

// A count mirage-rs read, `{count, from_start}` or null, as (from the end,
// from the start).
function countsOf(value: JsonValue | undefined): [number | null, number | null] {
  if (value === null) return [null, null]
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.count !== 'number') {
    throw new Error(`tail: mirage-rs read a count as ${JSON.stringify(value)}`)
  }
  return value.from_start === true ? [null, value.count] : [value.count, null]
}

// Append a follow-time diagnostic to the result's stderr. A following
// tail's stdout is a stream the caller drains as the file grows, and its
// stderr is the bytes on the result, which the caller reads once the
// stream ends; a notice raised mid-follow lands there.
function note(io: IOResult, message: string): void {
  const prior = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array()
  io.stderr = concat([prior, encodeText(message)])
}

// Sleep for the poll interval, or until the caller's signal fires.
async function pause(seconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (hasAborted(signal)) return
  await new Promise<void>((resolve) => {
    // An infinite interval waits on the abort signal alone, never on a
    // timer. `setTimeout` holds a 32-bit signed delay, so Node warns
    // (`TimeoutOverflowWarning`) and clamps `Infinity` to 1ms, which
    // would poll the backend continuously where python's
    // `asyncio.sleep(inf)` waits. GNU accepts `-s inf` (measured,
    // coreutils 9.4), so the acceptance is right and only the wait was
    // wrong. With no signal there is nothing to wake on, which is the
    // indefinite wait python performs.
    if (!Number.isFinite(seconds)) {
      signal?.addEventListener(
        'abort',
        () => {
          resolve()
        },
        { once: true },
      )
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, seconds * 1000)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// What a size-unknown file gained past `pos`, read from there, and where
// the next poll starts. A read that finds nothing at a position the file no
// longer reaches, its byte before `pos` gone too, means it was truncated,
// which is noted and read from the start. Mirrors Python's `_gained`.
async function gained(
  readRange: ReadStreamFn<[PathSpec, number, number | null]>,
  io: IOResult,
  p: PathSpec,
  pos: number,
): Promise<[Uint8Array, number]> {
  let start = pos
  let data = await materialize(readRange(p, start, null))
  if (
    data.byteLength === 0 &&
    start > 0 &&
    (await materialize(readRange(p, start - 1, 1))).byteLength === 0
  ) {
    note(io, `tail: ${p.rawPath}: file truncated\n`)
    start = 0
    data = await materialize(readRange(p, 0, null))
  }
  return [data, start + data.byteLength]
}

// What a followed file gained past `pos`, and where the next poll
// starts: a size-unknown file is read from `pos` where the backend reads
// windows (`gained`) and otherwise read whole and measured, and a file
// shorter than `pos` was truncated, which is noted and read from the
// start.
async function catchUp(
  stream: ReadStreamFn,
  readRange: ReadStreamFn<[PathSpec, number, number | null]> | null,
  io: IOResult,
  p: PathSpec,
  size: number | null,
  pos: number,
): Promise<[Uint8Array, number]> {
  if (size === null && readRange !== null) return gained(readRange, io, p, pos)
  let whole: Uint8Array | null = null
  let length = size
  if (length === null) {
    whole = await materialize(stream(p))
    length = whole.byteLength
  }
  let start = pos
  if (length < start) {
    note(io, `tail: ${p.rawPath}: file truncated\n`)
    start = 0
  }
  if (length <= start) return [new Uint8Array(), start]
  const data =
    whole !== null ? whole.slice(start) : await window(stream, readRange, p, start, length - start)
  return [data, start + data.byteLength]
}

/**
 * A follow poll's stat: what the backend holds now, at the dispatcher, past the
 * mount's index and past the stat the command's freshness probe kept: the poll
 * looks for exactly the change neither has yet. Mirrors Python's `_polled_stat`.
 */
async function polledStat(dispatch: DispatchFn, p: PathSpec): Promise<FileStat> {
  const [found] = await dispatch('stat', p, [], { fresh: true })
  if (found === null || found === undefined) throw enoent(p)
  return found as FileStat
}

/**
 * A follow poll's read, whole or a window: what the backend holds now, at the
 * dispatcher. A direct read, never served from the file cache nor kept in it:
 * the poll looks for exactly the bytes a cached copy does not have yet. Mirrors
 * Python's `_polled_window`.
 */
async function* polledWindow(
  dispatch: DispatchFn,
  p: PathSpec,
  offset = 0,
  size: number | null = null,
): AsyncIterable<Uint8Array> {
  const [data] = await dispatch('read', p, [], { filetype: null, offset, size, direct: true })
  yield await materialize(data as ByteSource)
}

async function* tailFile(
  path: PathSpec,
  read: ReadStreamFn,
  stat: StatFn,
  readRange: ReadStreamFn<[PathSpec, number, number | null]> | null,
  lastLines: ((p: PathSpec, n: number) => Promise<Uint8Array | null>) | undefined,
  counts: TailCounts,
  box?: { end: number },
): AsyncGenerator<Uint8Array> {
  const n = counts.lines ?? 10
  const fromEnd = counts.fromLine === null && counts.fromByte === null
  if (!isStdin(path) && fromEnd) {
    if (counts.byteCount === null && (counts.terminator ?? 10) === 10 && lastLines !== undefined) {
      const answer = await lastLines(path, Math.abs(n))
      if (answer !== null) {
        yield* chunks(answer)
        return
      }
    }
    if (readRange !== null && revisionFor(path.virtual) === null) {
      const info = await stat(path)
      if (info.type === FileType.FILE && info.size !== null && info.size > 0) {
        const size = info.size
        if (box !== undefined) box.end = size
        if (counts.byteCount !== null) {
          const offset = Math.max(0, size - Math.abs(counts.byteCount))
          yield* rangedStream(readRange, path, offset, size)
          return
        }
        if (n === 0) return
        let end = size
        let window = CHUNK_SIZE
        const budget = new YieldBudget()
        const selector = await openStream('select', {
          mode: 'reverse',
          unit: 'records',
          count: String(Math.abs(n)),
          terminator: counts.terminator ?? 10,
        })
        try {
          while (end > 0) {
            await budget.run()
            const start = Math.max(0, end - window)
            const data = await materialize(readRange(path, start, end - start))
            if (data.byteLength !== end - start) break
            let selected: number | null = null
            for (let stop = data.byteLength; stop > 0; stop -= CHUNK_SIZE) {
              const offset = Math.max(0, stop - CHUNK_SIZE)
              selector.feed(data.subarray(offset, stop))
              while (selector.busy()) {
                const paused = budget.run()
                if (paused !== undefined) await paused
                selector.drain()
              }
              if (selector.done()) {
                selected = offset + progress(selector).consumed
                break
              }
              const paused = budget.run()
              if (paused !== undefined) await paused
            }
            if (selected !== null || start === 0) {
              const offset = selected ?? 0
              yield* chunks(data.subarray(offset))
              yield* rangedStream(readRange, path, end, size)
              return
            }
            end = start
            window = Math.min(window * 2, 1 << 20)
          }
        } finally {
          await closeStream(selector)
        }
      }
    }
  }
  if (box !== undefined && fromEnd && Math.abs(counts.byteCount ?? n) === 0) {
    // Nothing to print, but the follow starts at the file's end.
    for await (const chunk of counted(read(path), box)) void chunk
    return
  }
  yield* tail(box === undefined ? read(path) : counted(read(path), box), counts)
}

// A source passed through, with how many bytes it gave left in `box`.
async function* counted(
  source: AsyncIterable<Uint8Array>,
  box: { end: number },
): AsyncIterable<Uint8Array> {
  box.end = 0
  for await (const chunk of source) {
    box.end += chunk.byteLength
    yield chunk
  }
}

async function* tail(source: ByteSource, rawCounts: TailCounts): AsyncIterable<Uint8Array> {
  const counts = normalizeCounts(rawCounts)
  const forward = counts.fromByte !== null || counts.fromLine !== null
  const byteMode =
    counts.fromByte !== null || (counts.fromLine === null && counts.byteCount !== null)
  const count =
    counts.fromByte !== null
      ? Math.max(0, counts.fromByte - 1)
      : counts.fromLine !== null
        ? Math.max(0, counts.fromLine - 1)
        : Math.abs(counts.byteCount ?? counts.lines ?? 10)
  const engine = await openStream('select', {
    mode: forward ? 'skip' : 'last',
    unit: byteMode ? 'bytes' : 'records',
    count: String(count),
    terminator: counts.terminator ?? 10,
  })
  const budget = new YieldBudget()
  const input = chunks(source)
  try {
    if (engine.done()) return
    for await (const part of input) {
      const output = engine.feed(part)
      if (output.byteLength > 0) yield output
      while (engine.busy()) {
        const paused = budget.run()
        if (paused !== undefined) await paused
        const output = engine.drain()
        if (output.byteLength > 0) yield output
      }
      if (!forward && !byteMode) checkMemory(progress(engine).retained)
    }
    const output = engine.finish()
    if (output.byteLength > 0) yield output
    while (engine.busy()) {
      const paused = budget.run()
      if (paused !== undefined) await paused
      const output = engine.drain()
      if (output.byteLength > 0) yield output
    }
  } finally {
    await closeStream(engine)
    await input.return?.(undefined)
  }
}

// Each opened operand's tail under its header. An unread operand (a
// directory) prints only its header; a read that fails once the stat passed
// is reported and the next operand still prints. Mirrors Python's
// `tail_multi`.
async function* tailMulti(
  paths: readonly (PathSpec | string)[],
  read: ReadStreamFn,
  counts: TailCounts,
  showHeaders: boolean,
  unread: ReadonlyMap<string, string>,
  io: IOResult,
  selected = false,
): AsyncIterable<Uint8Array> {
  const said = operandLines(paths, unread)
  let printed = 0
  try {
    for (const [i, p] of paths.entries()) {
      if (typeof p === 'string') {
        await say(io, p)
        said.delete(i)
        continue
      }
      let pending = showHeaders ? operandHeader(p, printed > 0) : null
      if (unread.has(p.rawPath)) {
        if (pending !== null) {
          yield pending
          printed++
        }
        await say(io, unread.get(p.rawPath) ?? '')
        said.delete(i)
        continue
      }
      const source = read(p)
      try {
        for await (const part of selected ? chunks(source) : tail(source, counts)) {
          if (pending !== null) {
            yield pending
            pending = null
          }
          yield part
        }
        if (pending !== null) yield pending
        printed++
      } catch (err) {
        if (!isFsError(err)) throw err
        const code = (err as { code?: string }).code
        await reportFsError(io, 'tail', p, err)
        if (pending !== null && code !== undefined && READ_FAILURES.has(code)) {
          yield pending
          printed++
        }
      } finally {
        await closeQuietly(source)
      }
    }
  } finally {
    if (said.size > 0) await say(io, [...said.values()].join(''))
  }
}

async function window(
  stream: ReadStreamFn,
  readRange: ReadStreamFn<[PathSpec, number, number | null]> | null,
  p: PathSpec,
  offset: number,
  size: number,
): Promise<Uint8Array> {
  if (readRange !== null) return await materialize(readRange(p, offset, size))
  const whole = await materialize(stream(p))
  return whole.slice(offset, offset + size)
}

// Print each operand's tail, then keep printing what it gains. GNU tail
// -f is a poll: every -s seconds each followed file is stat'ed, bytes
// past the last position are printed under that file's header when the
// previous output was another file's, and a size that shrank is `file
// truncated` and a restart from the top. An operand whose first read
// fails after its stat passed is a failed open, reported as one and,
// under --retry, waited for like a file that was never there. A file that
// goes away later is dropped with `has become inaccessible` under
// --follow=name; --retry
// keeps polling for it (and for one that was never there) and announces
// `has appeared` when it turns up, reading it from the start as GNU does
// after a rotation. The loop ends only when nothing is left to follow
// (`no files remaining`, exit 1), when --pid's process is gone (a poll that
// finds nothing new looks, and once it is gone one more poll reads what it
// wrote last), or when the caller's signal fires, which is how `timeout` and
// a killed job end it. The first print is a plain tail's (`tailFile`),
// printed as it is read, so a count from the end reads only the end where
// the backend reads windows; the polls go on from where it ended. Its first
// bytes are the open: a read that fails before them is a failed open, and
// one that fails later is reported and the file dropped the same way. A file
// whose stat carries no size (a backend that cannot know one without reading
// reports null, never a guess) is polled by reading from where the last poll
// ended, where the backend reads windows, and otherwise by reading it whole
// every interval and measuring that, rather than a follow that never prints.
// State is per operand, not per path: `tail -f f f` prints what
// f gains twice, under a header each time, as GNU does. Standard input is
// printed once and never followed: POSIX has tail ignore -f on a pipe, and
// GNU extends that to every `-` operand; a line that named nothing else has
// nothing left to wait for, so it ends there, without `no files remaining`.
// An unread operand (a directory) prints its header and is not followed.
// One file followed by descriptor, under a count of lines from the end, is
// asked of the mount's `follow` first: a mount that is told about new lines
// (a change stream), or can be asked for only the new ones every -s seconds,
// hands over the last lines and then each new one as it lands, so the file is
// not read again on each poll and the two meet at one point; a line with a
// --pid polls, since only a poll can look for the process.
async function* follow(
  paths: readonly PathSpec[],
  pending: readonly [PathSpec, string][],
  firstPrint: (p: PathSpec, box: { end: number }) => AsyncGenerator<Uint8Array>,
  pollStream: ReadStreamFn,
  stat: StatFn,
  readRange: ReadStreamFn<[PathSpec, number, number | null]> | null,
  counts: TailCounts,
  showHeaders: boolean,
  flags: FollowFlags,
  io: IOResult,
  signal: AbortSignal | undefined,
  unread: ReadonlySet<string>,
  onlyStdin: boolean,
  followLines: number | null = null,
  followOp?: (
    p: PathSpec,
    n: number,
    interval: number,
  ) => Promise<AsyncIterable<Uint8Array> | null>,
  processes?: SessionProcesses,
): AsyncGenerator<Uint8Array> {
  const writer = flags.pid === 0 ? null : flags.pid
  const positions = new Map<number, number>()
  let added: AsyncIterable<Uint8Array> | null = null
  const active: [number, PathSpec][] = paths.map((p, i) => [i, p])
  const waiting: [number, PathSpec, string][] = pending.map(([p, how], i) => [
    paths.length + i,
    p,
    how,
  ])
  let last: number | null = null
  const lost = async (entry: [number, PathSpec], err: unknown): Promise<void> => {
    await reportFsError(io, 'tail', entry[1], err)
    active.splice(active.indexOf(entry), 1)
    if (flags.retry) waiting.push([entry[0], entry[1], APPEARED])
  }
  try {
    for (const entry of [...active]) {
      const [slot, p] = entry
      if (unread.has(p.rawPath)) {
        if (showHeaders) yield operandHeader(p, last !== null)
        last = slot
        active.splice(active.indexOf(entry), 1)
        continue
      }
      const box = { end: 0 }
      let printed: AsyncGenerator<Uint8Array> | null = null
      let head: IteratorResult<Uint8Array> | null = null
      try {
        if (
          followOp !== undefined &&
          followLines !== null &&
          paths.length === 1 &&
          pending.length === 0 &&
          !flags.byName &&
          writer === null &&
          !isStdin(p)
        ) {
          added = await followOp(p, followLines, flags.interval)
        }
        // A follow's stream holds the first print too.
        if (added === null) {
          printed = firstPrint(p, box)
          head = await printed.next()
        }
      } catch (err) {
        await closeQuietly(added)
        added = null
        await printed?.return(undefined)
        if (!isFsError(err)) throw err
        // There is no handle to hold, so this first read is the open: one
        // that fails after the operand's stat passed is GNU's failed open,
        // reported the way the stat's failure would have been, and under
        // --retry waited for like a file that was never there (this is the
        // initial open that a descriptor follow's --retry covers).
        await lost(entry, err)
        continue
      }
      const header = showHeaders ? operandHeader(p, last !== null) : null
      last = slot
      if (printed === null) {
        if (header !== null) yield header
        continue
      }
      // The header goes out inside the scope that closes the opened read, so
      // a reader that stops at the header closes it too.
      try {
        if (header !== null) yield header
        if (head !== null && head.done !== true) yield head.value
        for await (const chunk of printed) yield chunk
      } catch (err) {
        if (!isFsError(err)) throw err
        await lost(entry, err)
        continue
      } finally {
        await printed.return(undefined)
      }
      positions.set(slot, box.end)
    }
    if (added !== null) {
      // A stream waits for the next line, so an abort ends the wait rather
      // than the next line.
      const lines = added[Symbol.asyncIterator]()
      try {
        for (;;) {
          const next = await abortable(lines.next(), signal)
          if (next.done === true) break
          yield next.value
        }
      } catch (err) {
        if (hasAborted(signal)) return
        throw err
      }
      note(io, 'tail: no files remaining\n')
      io.exitCode = 1
      return
    }
  } finally {
    // The stream follow opened holds the mount busy, so it closes however
    // the print ends, a reader that stops early included; it may be
    // waiting for the next line, so the close is not waited on.
    if (added !== null) void closeQuietly(added as AsyncIterableIterator<Uint8Array>)
  }
  for (const entry of active.filter(([, p]) => isStdin(p))) active.splice(active.indexOf(entry), 1)
  if (onlyStdin) return
  let gone = false
  let idle = true
  while ((active.length > 0 || waiting.length > 0) && !hasAborted(signal)) {
    if (writer !== null && idle) {
      if (gone) return
      gone = !writerRuns(processes, writer)
    }
    if (!gone) await pause(flags.interval, signal)
    if (hasAborted(signal)) return
    idle = true
    for (const entry of [...waiting]) {
      const [slot, p, how] = entry
      let found: FileStat
      try {
        found = await stat(p)
      } catch (err) {
        if (!isFsError(err)) throw err
        // The name is gone now, so whatever stands there next has
        // appeared, whatever stood there before.
        if (how !== APPEARED) waiting.splice(waiting.indexOf(entry), 1, [slot, p, APPEARED])
        continue
      }
      if (found.type === FileType.DIRECTORY) continue
      note(io, `tail: '${p.rawPath}' ${how}\n`)
      waiting.splice(waiting.indexOf(entry), 1)
      active.push([slot, p])
      positions.set(slot, 0)
    }
    for (const entry of [...active]) {
      const [slot, p] = entry
      let grown: [Uint8Array, number] | null
      try {
        const current = await stat(p)
        grown =
          current.type === FileType.DIRECTORY
            ? null
            : await catchUp(pollStream, readRange, io, p, current.size, positions.get(slot) ?? 0)
      } catch (err) {
        if (!isFsError(err)) throw err
        if (!isEisdir(err)) {
          // A path that went away, whether its stat failed or the read
          // right after it did (a rotation between the two). Only
          // name-following notices; under a descriptor --retry covers
          // the initial open alone, as in GNU, which words the loss as an
          // inaccessible name only when it means to wait for it.
          if (flags.byName) {
            const strerror = fsStrerror(err) ?? posixPhrase('ENOENT')
            note(
              io,
              flags.retry
                ? `tail: '${p.rawPath}' has become inaccessible: ${strerror}\n`
                : `tail: ${shellQuote(p.rawPath)}: ${strerror}\n`,
            )
            active.splice(active.indexOf(entry), 1)
            if (flags.retry) waiting.push([slot, p, APPEARED])
          }
          continue
        }
        grown = null
      }
      if (grown === null) {
        // A directory replaced the file: name-following gives the name
        // up, or under --retry waits for a file to stand there again; a
        // descriptor follow prints nothing, as GNU's does while it holds
        // the old descriptor.
        if (!flags.byName) continue
        const line = `tail: '${p.rawPath}' has been replaced with an untailable file`
        note(io, line + (flags.retry ? '\n' : '; giving up on this name\n'))
        active.splice(active.indexOf(entry), 1)
        if (flags.retry) waiting.push([slot, p, ACCESSIBLE])
        continue
      }
      const [data, pos] = grown
      if (data.byteLength > 0) {
        if (showHeaders && last !== slot) yield operandHeader(p, true)
        last = slot
        idle = false
        yield data
      }
      positions.set(slot, pos)
    }
  }
  if (hasAborted(signal)) return
  note(io, 'tail: no files remaining\n')
  io.exitCode = 1
}

// Whether --pid's process still runs, as kill(pid, 0) answers: one the
// session cannot see is gone, and one it sees but may not signal still runs.
function writerRuns(processes: SessionProcesses | undefined, pid: number): boolean {
  if (processes === undefined) return false
  try {
    return processes.probe(pid)
  } catch (err) {
    if ((err as { code?: string }).code === 'EPERM') return true
    throw err
  }
}

// Sort the operands that did not open into the ones --retry waits for and
// the ones tail gives up on, wording the latter. A directory cannot be
// followed. Without --retry that is `giving up on this name`; with it
// GNU drops the suffix, and under --follow=name keeps polling the name
// until something tailable replaces it, announced as `has become
// accessible` rather than the `has appeared` a missing file gets.
async function unfollowable(
  paths: readonly PathSpec[],
  opened: ReadonlySet<string>,
  stat: StatFn,
  flags: FollowFlags,
  io: IOResult,
): Promise<[PathSpec, string][]> {
  const pending: [PathSpec, string][] = []
  for (const p of paths) {
    if (opened.has(p.virtual)) continue
    let isDir: boolean
    try {
      isDir = (await stat(p)).type === FileType.DIRECTORY
    } catch (err) {
      if (!isFsError(err)) throw err
      if (!isEisdir(err)) {
        if (flags.retry) pending.push([p, APPEARED])
        continue
      }
      isDir = true
    }
    if (!isDir) continue
    const line = `tail: ${p.rawPath}: cannot follow end of this type of file`
    if (!flags.retry) {
      note(io, `${line}; giving up on this name\n`)
      continue
    }
    note(io, `${line}\n`)
    if (flags.byName) pending.push([p, ACCESSIBLE])
  }
  return pending
}

const RETRY_IGNORED = 'tail: warning: --retry ignored; --retry is useful only when following\n'
const RETRY_INITIAL = 'tail: warning: --retry only effective for the initial open\n'
const PID_IGNORED = 'tail: warning: PID ignored; --pid=PID is useful only when following\n'
// A name is what -F follows, and standard input has none.
const STDIN_BY_NAME = "tail: cannot follow '-' by name\n"
// What a waited-for name is announced as when it turns up: a missing file
// has appeared, an untailable one (a directory) has become accessible.
const APPEARED = 'has appeared;  following new file'
const ACCESSIBLE = 'has become accessible'

export interface TailFlags {
  readonly counts: TailCounts
  readonly quiet: boolean
  readonly verbose: boolean
  readonly following: FollowFlags
}

/**
 * tail's options, the values read by mirage-rs before any operand is resolved:
 * the flags, or tail's refusal of a value. Mirrors Python's `parse_flags`.
 */
export function parseFlags(bag: Record<string, FlagValue>): TailFlags | IOResult {
  const fl = new FlagView(bag, specOf('tail'))
  const raw = fl.raw('follow')
  const typed = fl.texts('lines', 'bytes', 'sleep_interval', 'pid', 'max_unchanged_stats')
  if (typeof raw === 'string') typed.push(['follow', raw])
  let values
  try {
    values = scan('tail', typed)
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  const how = values.follow
  if (how !== null && typeof how !== 'string') {
    throw new Error(`tail: mirage-rs read --follow as ${JSON.stringify(how)}`)
  }
  const [follow, byName, retry] = followFlags(fl, how)
  // The last of -q and -v decides, as in GNU tail, and so does the last of
  // -n and -c.
  const headers = fl.typedOrder('quiet', 'silent', 'verbose').at(-1)
  const unit = fl.typedOrder('lines', 'bytes').at(-1)
  const [lines, fromLine] = countsOf(unit === 'bytes' ? null : values.lines)
  const [byteCount, fromByte] = countsOf(unit === 'lines' ? null : values.bytes)
  // mirage-rs answers -s, typed or GNU's default of 1, as null when it is
  // infinite.
  const interval = values.sleep_interval
  if (interval !== null && typeof interval !== 'number') {
    throw new Error(`tail: mirage-rs read -s as ${JSON.stringify(interval)}`)
  }
  const pid = values.pid
  if (pid !== null && typeof pid !== 'number') {
    throw new Error(`tail: mirage-rs read --pid as ${JSON.stringify(pid)}`)
  }
  return {
    counts: {
      lines,
      fromLine,
      byteCount,
      fromByte,
      terminator: fl.asBool('zero_terminated') ? 0 : 10,
    },
    quiet: headers === 'quiet' || headers === 'silent',
    verbose: headers === 'verbose',
    following: {
      follow,
      byName,
      retry,
      interval: interval ?? Number.POSITIVE_INFINITY,
      pid,
    },
  }
}

/**
 * Run tail over resolved operands, GNU semantics. A line count from the end
 * (`-n N`, or the default 10) is asked of `lastLines` first, so a mount that
 * can fetch the end of a file on its own does not send the rest; `-f` on one
 * file asks `followOp(p, n, interval)` (see `follow`). Null, or no such op, reads
 * or polls the file. Mirrors Python's `tail_generic`; `parsed` holds the
 * options, read before the operands were.
 */
export async function tailGeneric(
  parsed: TailFlags,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stream: ReadStreamFn,
  stat: StatFn,
  readRange: ReadStreamFn<[PathSpec, number, number | null]> | null = null,
  lastLines?: (p: PathSpec, n: number) => Promise<Uint8Array | null>,
  followOp?: (
    p: PathSpec,
    n: number,
    interval: number,
  ) => Promise<AsyncIterable<Uint8Array> | null>,
): Promise<CommandFnResult> {
  stat = stdinStat(stat)
  const backend = stream
  stream = stdinStream(stream, ctx.stdin)
  const { counts, quiet: qFlag, verbose: vFlag, following } = parsed
  const n = counts.lines ?? 10
  const fromEnd =
    counts.byteCount === null &&
    counts.fromLine === null &&
    counts.fromByte === null &&
    (counts.terminator ?? 10) === 10
  if (
    following.follow &&
    following.byName &&
    (paths.length === 0 || paths.some((p) => isStdin(p)))
  ) {
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(STDIN_BY_NAME) })]
  }
  // The warnings come first, then tail runs as if --retry and --pid were not
  // there; a descriptor it follows only after the initial open says so too.
  const warnings =
    (following.retry && !following.follow
      ? RETRY_IGNORED
      : following.retry && !following.byName
        ? RETRY_INITIAL
        : '') + (following.pid !== null && !following.follow ? PID_IGNORED : '')
  // GNU opens nothing when a tail from the end keeps no line or byte.
  if (
    !following.follow &&
    counts.fromLine === null &&
    counts.fromByte === null &&
    (counts.byteCount ?? n) === 0
  ) {
    return [null, new IOResult({ stderr: warnings === '' ? null : encodeText(warnings) })]
  }
  if (paths.length > 0) {
    const showHeaders = showsHeaders(vFlag, qFlag, paths.length)
    const [order, unreadLines] = await splitOpened(paths, stat, 'tail')
    const opened = order.filter((p): p is PathSpec => typeof p !== 'string')
    const unread = new Set(unreadLines.keys())
    const err =
      following.follow || opened.length === 0
        ? [...operandLines(order, unreadLines).values()].join('')
        : ''
    const io = new IOResult({
      exitCode: err === '' && opened.length === order.length && unread.size === 0 ? 0 : 1,
      stderr: warnings + err === '' ? null : encodeText(warnings + err),
    })
    if (!following.follow) {
      if (opened.length === 0) return [null, io]
      return [
        tailMulti(
          order,
          (p) => tailFile(p, stream, stat, readRange, lastLines, counts),
          counts,
          showHeaders,
          unreadLines,
          io,
          true,
        ),
        io,
      ]
    }
    const readable = opened.filter((p) => !unread.has(p.rawPath))
    const pending = await unfollowable(
      paths,
      new Set(readable.map((p) => p.virtual)),
      stat,
      following,
      io,
    )
    if (readable.length === 0 && pending.length === 0 && !(showHeaders && opened.length > 0)) {
      note(io, 'tail: no files remaining\n')
      io.exitCode = 1
      return [null, io]
    }
    // The first print reads like any other tail; the polls ask the dispatcher
    // for what the backend holds now, past the file cache and past the
    // stat the command's freshness probe kept: they look for exactly the
    // change neither has yet.
    const first = stdinStream(backend, ctx.stdin)
    const dispatch = dispatchOf(ctx)
    const polled =
      dispatch === undefined
        ? { stream: first, stat, readRange }
        : {
            stream: (p: PathSpec) => polledWindow(dispatch, p),
            stat: (p: PathSpec) => polledStat(dispatch, p),
            readRange: (p: PathSpec, offset: number, size: number | null) =>
              polledWindow(dispatch, p, offset, size),
          }
    return [
      follow(
        opened,
        pending,
        (p, box) => tailFile(p, first, stat, readRange, undefined, counts, box),
        polled.stream,
        polled.stat,
        polled.readRange,
        counts,
        showHeaders,
        following,
        io,
        ctx.signal,
        unread,
        paths.every((p) => isStdin(p)),
        fromEnd ? n : null,
        followOp,
        ctx.processes,
      ),
      io,
    ]
  }

  async function* output(): AsyncIterable<Uint8Array> {
    if (vFlag && !qFlag) yield operandHeader(null)
    yield* tail(ctx.stdin ?? new Uint8Array(), counts)
  }
  return [output(), new IOResult({ stderr: warnings === '' ? null : encodeText(warnings) })]
}
