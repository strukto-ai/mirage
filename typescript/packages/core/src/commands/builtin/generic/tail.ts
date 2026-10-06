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

import { isStdin, operandLabel } from '../utils/stream.ts'
import { stdinStream, stdinStat } from '../utils/stream.ts'
import { STDIN_HEADER_NAME } from '../utils/constants.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { cacheAwareStreamEager } from '../../../cache/read_through.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, type PathSpec } from '../../../types.ts'
import { argmatchError } from '../../spec/usage.ts'
import { argmatch } from '../../spec/argmatch.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import {
  numberFlagError,
  parseCounts,
  parseSeconds,
  tailBytes,
  type TailCounts,
} from '../tail_counts.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { fsStrerror, isEisdir, isFsError } from '../../../errors/fs.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { shellQuote } from '../../../utils/quote.ts'
import { splitOpened } from '../utils/operands.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { quoteText } from '../../quote.ts'
import { concat } from '../../../io/cachable_iterator.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { posixPhrase } from '../../../errors/posix.ts'

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>
type Stat = (p: PathSpec) => Promise<FileStat>
type ReadRange = (p: PathSpec, offset: number, size: number) => Promise<Uint8Array>

const DEFAULT_SLEEP_INTERVAL = 1
// GNU's `follow_mode_string`, in declaration order.
const FOLLOW_ARGS = ['descriptor', 'name'] as const

/** -f/--follow[=HOW], -F, --retry and -s as tail reads them. */
export interface FollowFlags {
  readonly follow: boolean
  readonly byName: boolean
  readonly retry: boolean
  readonly interval: number
}

// -f, --follow[=HOW] and -F. A bad HOW is GNU's ARGMATCH refusal; -F is
// --follow=name --retry. The mode is whichever of -f/--follow and -F came
// last, GNU's own order (`-F --follow=descriptor` follows the descriptor),
// while -F's --retry half stays on either way.
export function followFlags(fl: FlagView): FollowFlags | string {
  const raw: unknown = fl.raw('follow')
  let how: string | null = null
  if (typeof raw === 'string') {
    const match = argmatch(raw, FOLLOW_ARGS)
    if (!match.matched) {
      return (
        argmatchError('tail', '--follow', raw, FOLLOW_ARGS, undefined, match.kind).message + '\n'
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
    // GNU's own two-part test, `xstrtod(...) && 0 <= s`: the grammar
    // first, then the range. `0 <= nan` is false, so NaN is refused, while
    // `inf` passes both and is ACCEPTED (measured, coreutils 9.4).
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
  readRange: ReadRange | null,
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

async function window(
  stream: Stream,
  readRange: ReadRange | null,
  p: PathSpec,
  offset: number,
  size: number,
): Promise<Uint8Array> {
  if (readRange !== null) return await readRange(p, offset, size)
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
async function* follow(
  paths: readonly PathSpec[],
  pending: readonly [PathSpec, string][],
  stream: Stream,
  stat: Stat,
  readRange: ReadRange | null,
  counts: TailCounts,
  showHeaders: boolean,
  flags: FollowFlags,
  io: IOResult,
  signal: AbortSignal | undefined,
  unread: ReadonlySet<string>,
  onlyStdin: boolean,
): AsyncGenerator<Uint8Array> {
  const positions = new Map<number, number>()
  const active: [number, PathSpec][] = paths.map((p, i) => [i, p])
  const waiting: [number, PathSpec, string][] = pending.map(([p, how], i) => [
    paths.length + i,
    p,
    how,
  ])
  let last: number | null = null
  for (const entry of [...active]) {
    const [slot, p] = entry
    if (unread.has(p.virtual)) {
      if (showHeaders) {
        yield encodeText(
          `${last === null ? '' : '\n'}==> ${operandLabel(p, STDIN_HEADER_NAME)} <==\n`,
        )
      }
      last = slot
      active.splice(active.indexOf(entry), 1)
      continue
    }
    let raw: Uint8Array
    try {
      raw = await materialize(stream(p))
    } catch (err) {
      if (!isFsError(err)) throw err
      // There is no handle to hold, so this first read is the open: one
      // that fails after the operand's stat passed is GNU's failed open,
      // reported the way the stat's failure would have been, and under
      // --retry waited for like a file that was never there (this is the
      // initial open that a descriptor follow's --retry covers).
      note(io, fsErrorLine('tail', p, err))
      io.exitCode = 1
      active.splice(active.indexOf(entry), 1)
      if (flags.retry) waiting.push([slot, p, APPEARED])
      continue
    }
    if (showHeaders) {
      yield encodeText(
        `${last === null ? '' : '\n'}==> ${operandLabel(p, STDIN_HEADER_NAME)} <==\n`,
      )
    }
    last = slot
    yield tailBytes(raw, counts)
    positions.set(slot, raw.byteLength)
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
            : await catchUp(stream, readRange, io, p, current.size, positions.get(slot) ?? 0)
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
        if (showHeaders && last !== slot)
          yield encodeText(`\n==> ${operandLabel(p, STDIN_HEADER_NAME)} <==\n`)
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

export async function tailGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
  stat: Stat,
  readRange: ReadRange | null = null,
): Promise<CommandFnResult> {
  stat = stdinStat(stat)
  const parsed = parseFlags(opts.flags)
  // A follow reads the backend itself, never the read-through cache:
  // what it is polling for is exactly the change the cached body does
  // not have yet.
  const backend = stream
  stream = stdinStream(cacheAwareStreamEager(stream), opts.stdin)
  if (typeof parsed === 'string')
    return [null, new IOResult({ exitCode: 1, stderr: encodeText(parsed) })]
  const { counts, quiet: qFlag, verbose: vFlag, following } = parsed
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
  if (paths.length > 0 && following.follow) {
    const showHeaders = (vFlag || paths.length > 1) && !qFlag
    const [opened, unread, err] = await splitOpened(paths, stat, 'tail')
    const readable = opened.filter((p) => !unread.has(p.virtual))
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: retryWarning + err === '' ? null : encodeText(retryWarning + err),
    })
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
    return [
      follow(
        opened,
        pending,
        stdinStream(backend, opts.stdin),
        stat,
        readRange,
        counts,
        showHeaders,
        following,
        io,
        opts.signal,
        unread,
        paths.every((p) => isStdin(p)),
      ),
      io,
    ]
  }

  if (paths.length > 0) {
    const chunks: Uint8Array[] = []
    const showHeaders = (vFlag || paths.length > 1) && !qFlag
    let err = ''
    let printed = 0
    for (const p of paths) {
      let raw: Uint8Array
      try {
        raw = await materialize(stream(p))
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('tail', p, e)
        // A directory opens before its read fails, so GNU still heads it.
        const code = (e as { code?: string }).code
        if (showHeaders && code !== undefined && READ_FAILURES.has(code)) {
          const label = operandLabel(p, STDIN_HEADER_NAME)
          chunks.push(encodeText(`${printed > 0 ? '\n' : ''}==> ${label} <==\n`))
          printed += 1
        }
        continue
      }
      if (showHeaders) {
        // Separator keyed on printed blocks, not operand index: a good file
        // after a failed operand starts without a leading blank line (GNU).
        const header =
          printed > 0
            ? `\n==> ${operandLabel(p, STDIN_HEADER_NAME)} <==\n`
            : `==> ${operandLabel(p, STDIN_HEADER_NAME)} <==\n`
        chunks.push(encodeText(header))
      }
      printed += 1
      chunks.push(tailBytes(raw, counts))
    }
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: retryWarning + err === '' ? null : encodeText(retryWarning + err),
    })
    if (printed === 0 && err !== '') return [null, io]
    const out: ByteSource = concat(chunks)
    return [out, io]
  }
  const raw = (await readStdinAsync(opts.stdin)) ?? new Uint8Array(0)
  const body = tailBytes(raw, counts)
  // -v heads a stdin nobody named with the name it gives `-`.
  const header = encodeText(`==> ${STDIN_HEADER_NAME} <==\n`)
  return [
    vFlag && !qFlag ? concat([header, body]) : body,
    new IOResult({ stderr: retryWarning === '' ? null : encodeText(retryWarning) }),
  ]
}
