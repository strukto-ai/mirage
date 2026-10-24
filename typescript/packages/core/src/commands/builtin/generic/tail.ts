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
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { closeQuietly } from '../../../io/stream.ts'
import { abortable } from '../../../utils/abort.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, type PathSpec, type ReadStreamFn } from '../../../types.ts'
import { wordRefusalError } from '../../spec/usage.ts'
import { matchWord } from '../../spec/word_choice.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import {
  normalizeCounts,
  numberFlagError,
  parseCounts,
  parseSeconds,
  type TailCounts,
} from '../tail_counts.ts'
import { enoent, fsStrerror, isEisdir, isFsError } from '../../../errors/fs.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { shellQuote } from '../../../utils/quote.ts'
import { reportFsError, splitOpened } from '../utils/operands.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { chunks } from '../../../io/cooperative.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { quoteText } from '../../quote.ts'
import { concat } from '../../../utils/bytes.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { dispatchOf } from '../utils/links.ts'

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>
type Stat = (p: PathSpec) => Promise<FileStat>

const DEFAULT_SLEEP_INTERVAL = 1
// The --follow words, in the order GNU lists them back.
const FOLLOW_ARGS = ['descriptor', 'name'] as const

/** -f/--follow[=HOW], -F, --retry and -s as tail reads them. */
export interface FollowFlags {
  readonly follow: boolean
  readonly byName: boolean
  readonly retry: boolean
  readonly interval: number
}

// -f, --follow[=HOW] and -F. A bad HOW is GNU's word-choice refusal; -F is
// --follow=name --retry. The mode is whichever of -f/--follow and -F came
// last, GNU's own order (`-F --follow=descriptor` follows the descriptor),
// while -F's --retry half stays on either way.
export function followFlags(fl: FlagView): FollowFlags | string {
  const raw: unknown = fl.raw('follow')
  let how: string | null = null
  if (typeof raw === 'string') {
    const match = matchWord(raw, FOLLOW_ARGS)
    if (!match.matched) {
      return (
        wordRefusalError('tail', '--follow', raw, FOLLOW_ARGS, undefined, match.kind).message + '\n'
      )
    }
    how = match.word
  }
  const typed = fl
    .typedOrder('follow', 'F')
    .filter((k) =>
      k === 'F' ? fl.asBool('F') : raw !== undefined && raw !== null && raw !== false,
    )
  const follow = typed.length > 0
  const byName = follow && (typed[typed.length - 1] === 'F' || how === 'name')
  const retry = fl.asBool('retry') || typed.includes('F')
  const rawSeconds = fl.asStr('sleep_interval')
  let interval = DEFAULT_SLEEP_INTERVAL
  if (rawSeconds !== undefined) {
    const seconds = parseSeconds(rawSeconds)
    // GNU's two-part test: the whole word must read as a number, then the
    // number must be at least 0. NaN is not, so it is refused, while `inf`
    // passes both and is ACCEPTED (measured, coreutils 9.4).
    if (seconds === null || !(0 <= seconds)) {
      return `tail: invalid number of seconds: '${quoteText(rawSeconds)}'\n`
    }
    interval = seconds
  }
  return { follow, byName, retry, interval }
}

// Append a follow-time diagnostic to the result's stderr. A following
// tail's stdout is a stream the caller drains as the file grows, and its
// stderr is the bytes on the result, which the caller reads once the
// stream ends; a notice raised mid-follow lands there.
function note(io: IOResult, message: string): void {
  const prior = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array()
  io.stderr = concat([prior, encodeText(message)])
}

// Whether the caller's signal has fired; a call rather than a read so a
// loop re-asks after every await instead of trusting a narrowed value.
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

// Sleep for the poll interval, or until the caller's signal fires.
async function pause(seconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (aborted(signal)) return
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

// What a followed file gained past `pos`, and where the next poll
// starts: a size-unknown file is read whole and measured, and a file
// shorter than `pos` was truncated, which is noted and read from the
// start.
async function catchUp(
  stream: Stream,
  readRange: ReadStreamFn<[PathSpec, number, number]> | null,
  io: IOResult,
  p: PathSpec,
  size: number | null,
  pos: number,
): Promise<[Uint8Array, number]> {
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

// `stream`, answered by the mount's `lastLines(p, n)` where it can: the last
// `n` lines without the rest of the file. Mirrors Python's `_read_last`.
function readLast(
  stream: Stream,
  lastLines: (p: PathSpec, n: number) => Promise<Uint8Array | null>,
  n: number,
): Stream {
  return (p) => {
    const source = stream(p)
    return (async function* (): AsyncIterable<Uint8Array> {
      try {
        const answer = isStdin(p) ? null : await lastLines(p, n)
        yield* chunks(answer ?? source)
      } finally {
        await closeQuietly(source)
      }
    })()
  }
}

// The tail of one source, read as it streams. Mirrors Python's `tail`.
async function* tail(source: ByteSource, rawCounts: TailCounts): AsyncIterable<Uint8Array> {
  const counts = normalizeCounts(rawCounts)
  if (counts.fromByte !== null || counts.fromLine !== null) {
    let skipBytes = counts.fromByte === null ? 0 : Math.max(0, counts.fromByte - 1)
    let skipLines = counts.fromLine === null ? 0 : Math.max(0, counts.fromLine - 1)
    for await (const part of chunks(source)) {
      let start = Math.min(skipBytes, part.length)
      skipBytes -= start
      while (skipLines > 0 && start < part.length) {
        const next = part.indexOf(10, start)
        if (next === -1) {
          start = part.length
          break
        }
        start = next + 1
        skipLines--
      }
      if (start < part.length && skipLines === 0) yield part.subarray(start)
    }
    return
  }
  if (counts.byteCount !== null) {
    const count = Math.abs(counts.byteCount)
    if (count === 0) return
    const kept: Uint8Array[] = []
    let held = 0
    for await (const part of chunks(source)) {
      kept.push(part.slice(-count))
      held += Math.min(part.length, count)
      while (kept[0] !== undefined && held - kept[0].length >= count) {
        held -= kept[0].length
        kept.shift()
      }
    }
    if (held > 0) yield concat(kept).slice(-count)
    return
  }
  const count = Math.abs(counts.lines ?? 10)
  if (count === 0) return
  const reader = new AsyncLineIterator(source)
  const kept: Uint8Array[] = []
  let cursor = 0
  try {
    for (;;) {
      const [line, ended] = await reader.readUntil(10)
      if (line.length === 0 && !ended) break
      const data = ended ? concat([line, Uint8Array.of(10)]) : line
      if (kept.length < count) kept.push(data)
      else {
        kept[cursor] = data
        cursor = (cursor + 1) % count
      }
    }
    yield* kept.slice(cursor)
    yield* kept.slice(0, cursor)
  } finally {
    await reader.discard()
  }
}

// Each opened operand's tail under its header. An unread operand (a
// directory) prints only its header; a read that fails once the stat passed
// is reported and the next operand still prints. Mirrors Python's
// `tail_multi`.
async function* tailMulti(
  paths: readonly PathSpec[],
  read: Stream,
  counts: TailCounts,
  showHeaders: boolean,
  unread: ReadonlySet<string>,
  io: IOResult,
): AsyncIterable<Uint8Array> {
  let printed = 0
  for (const p of paths) {
    let pending = showHeaders ? operandHeader(p, printed > 0) : null
    if (unread.has(p.virtual)) {
      if (pending !== null) {
        yield pending
        printed++
      }
      continue
    }
    const source = read(p)
    try {
      for await (const part of tail(source, counts)) {
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
}

async function window(
  stream: Stream,
  readRange: ReadStreamFn<[PathSpec, number, number]> | null,
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
// (`no files remaining`, exit 1) or the caller's signal fires, which is
// how `timeout` and a killed job end it. A file whose stat carries no
// size (a backend that cannot know one without reading reports null,
// never a guess) is polled by reading it whole every interval and
// measuring that: one read per poll, rather than a follow that never
// prints. State is per operand, not per path: `tail -f f f` prints what
// f gains twice, under a header each time, as GNU does. Standard input is
// printed once and never followed: POSIX has tail ignore -f on a pipe, and
// GNU extends that to every `-` operand; a line that named nothing else has
// nothing left to wait for, so it ends there, without `no files remaining`.
// An unread operand (a directory) prints its header and is not followed.
// One file followed by descriptor, under a count of lines from the end, is
// asked of the mount's `follow` first: a mount that is told about new lines
// (a change stream), or can be asked for only the new ones every -s seconds,
// hands over the last lines and then each new one as it lands, so the file is
// not read again on each poll and the two meet at one point.
async function* follow(
  paths: readonly PathSpec[],
  pending: readonly [PathSpec, string][],
  stream: Stream,
  pollStream: Stream,
  stat: Stat,
  readRange: ReadStreamFn<[PathSpec, number, number]> | null,
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
): AsyncGenerator<Uint8Array> {
  const positions = new Map<number, number>()
  let added: AsyncIterable<Uint8Array> | null = null
  const active: [number, PathSpec][] = paths.map((p, i) => [i, p])
  const waiting: [number, PathSpec, string][] = pending.map(([p, how], i) => [
    paths.length + i,
    p,
    how,
  ])
  let last: number | null = null
  try {
    for (const entry of [...active]) {
      const [slot, p] = entry
      if (unread.has(p.virtual)) {
        if (showHeaders) yield operandHeader(p, last !== null)
        last = slot
        active.splice(active.indexOf(entry), 1)
        continue
      }
      let raw: Uint8Array | null = null
      try {
        if (
          followOp !== undefined &&
          followLines !== null &&
          paths.length === 1 &&
          pending.length === 0 &&
          !flags.byName &&
          !isStdin(p)
        ) {
          added = await followOp(p, followLines, flags.interval)
        }
        // A follow's stream holds the first print too.
        if (added === null) raw = await materialize(stream(p))
      } catch (err) {
        await closeQuietly(added)
        added = null
        if (!isFsError(err)) throw err
        // There is no handle to hold, so this first read is the open: one
        // that fails after the operand's stat passed is GNU's failed open,
        // reported the way the stat's failure would have been, and under
        // --retry waited for like a file that was never there (this is the
        // initial open that a descriptor follow's --retry covers).
        await reportFsError(io, 'tail', p, err)
        active.splice(active.indexOf(entry), 1)
        if (flags.retry) waiting.push([slot, p, APPEARED])
        continue
      }
      if (showHeaders) yield operandHeader(p, last !== null)
      last = slot
      if (raw !== null) {
        yield* tail(raw, counts)
        positions.set(slot, raw.byteLength)
      }
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
        if (aborted(signal)) return
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
  while ((active.length > 0 || waiting.length > 0) && !aborted(signal)) {
    await pause(flags.interval, signal)
    if (aborted(signal)) return
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
        yield data
      }
      positions.set(slot, pos)
    }
  }
  if (aborted(signal)) return
  note(io, 'tail: no files remaining\n')
  io.exitCode = 1
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
  stat: Stat,
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
// A name is what -F follows, and standard input has none.
const STDIN_BY_NAME = "tail: cannot follow '-' by name\n"
// What a waited-for name is announced as when it turns up: a missing file
// has appeared, an untailable one (a directory) has become accessible.
const APPEARED = 'has appeared;  following new file'
const ACCESSIBLE = 'has become accessible'

// The tail flag bag, parsed once; a refused value is its message.
interface TailFlags {
  readonly counts: TailCounts
  readonly quiet: boolean
  readonly verbose: boolean
  readonly following: FollowFlags
}

function parseFlags(bag: Record<string, FlagValue>): TailFlags | string {
  const fl = new FlagView(bag, specOf('tail'))
  const nRaw = fl.asStr('n') ?? null
  const cRaw = fl.asStr('c') ?? null
  const numErr = numberFlagError('tail', nRaw, cRaw)
  if (numErr !== null) return numErr
  const following = followFlags(fl)
  if (typeof following === 'string') return following
  // The last of -q and -v decides, as in GNU tail.
  const headers = fl.typedOrder('q', 'v').at(-1)
  return {
    counts: parseCounts(nRaw, cRaw),
    quiet: headers === 'q',
    verbose: headers === 'v',
    following,
  }
}

/**
 * Run tail over resolved operands, GNU semantics. A line count from the end
 * (`-n N`, or the default 10) is asked of `lastLines` first, so a mount that
 * can fetch the end of a file on its own does not send the rest; `-f` on one
 * file asks `followOp(p, n, interval)` (see `follow`). Null, or no such op, reads
 * or polls the file. Mirrors Python's `tail_generic`.
 */
export async function tailGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stream: Stream,
  stat: Stat,
  readRange: ReadStreamFn<[PathSpec, number, number]> | null = null,
  lastLines?: (p: PathSpec, n: number) => Promise<Uint8Array | null>,
  followOp?: (
    p: PathSpec,
    n: number,
    interval: number,
  ) => Promise<AsyncIterable<Uint8Array> | null>,
): Promise<CommandFnResult> {
  stat = stdinStat(stat)
  const parsed = parseFlags(ctx.flags)
  const backend = stream
  stream = stdinStream(stream, ctx.stdin)
  if (typeof parsed === 'string')
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(parsed) })]
  const { counts, quiet: qFlag, verbose: vFlag, following } = parsed
  const n = counts.lines ?? 10
  const fromEnd = counts.byteCount === null && counts.fromLine === null && counts.fromByte === null
  const lastOf = (s: Stream): Stream | null =>
    lastLines !== undefined && fromEnd && n > 0 ? readLast(s, lastLines, n) : null
  if (
    following.follow &&
    following.byName &&
    (paths.length === 0 || paths.some((p) => isStdin(p)))
  ) {
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(STDIN_BY_NAME) })]
  }
  // GNU warns first, then tails as if --retry were not there; a descriptor
  // it follows only after the initial open says so too.
  const retryWarning =
    following.retry && !following.follow
      ? RETRY_IGNORED
      : following.retry && !following.byName
        ? RETRY_INITIAL
        : ''
  // GNU opens nothing when a tail from the end keeps no line or byte.
  if (
    !following.follow &&
    counts.fromLine === null &&
    counts.fromByte === null &&
    (counts.byteCount ?? n) === 0
  ) {
    return [null, new IOResult({ stderr: retryWarning === '' ? null : encodeText(retryWarning) })]
  }
  if (paths.length > 0) {
    const showHeaders = showsHeaders(vFlag, qFlag, paths.length)
    const [opened, unread, err] = await splitOpened(paths, stat, 'tail')
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: retryWarning + err === '' ? null : encodeText(retryWarning + err),
    })
    if (!following.follow) {
      if (opened.length === 0) return [null, io]
      return [tailMulti(opened, lastOf(stream) ?? stream, counts, showHeaders, unread, io), io]
    }
    const readable = opened.filter((p) => !unread.has(p.virtual))
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
            readRange: (p: PathSpec, offset: number, size: number) =>
              polledWindow(dispatch, p, offset, size),
          }
    return [
      follow(
        opened,
        pending,
        first,
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
      ),
      io,
    ]
  }

  async function* output(): AsyncIterable<Uint8Array> {
    if (vFlag && !qFlag) yield operandHeader(null)
    yield* tail(ctx.stdin ?? new Uint8Array(), counts)
  }
  return [output(), new IOResult({ stderr: retryWarning === '' ? null : encodeText(retryWarning) })]
}
