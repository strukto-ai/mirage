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

import { isStdin } from '../utils/stream.ts'
import { stdinStream, stdinStat } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { cacheAwareStreamEager } from '../../../cache/read_through.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, type PathSpec } from '../../../types.ts'
import { argmatchError } from '../../spec/usage.ts'
import { argmatch } from '../../spec/argmatch.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import {
  countNewlines,
  normalizeCounts,
  numberFlagError,
  parseCounts,
  parseSeconds,
  tailBytes,
  type TailCounts,
} from '../tail_counts.ts'
import { fsErrorLine, fsStrerror, isEisdir, isFsError } from '../../../utils/errors.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { quoteText } from '../../quote.ts'

const ENC = new TextEncoder()

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
  io.stderr = concat([prior, ENC.encode(message)])
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
// f gains twice, under a header each time, as GNU does.
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
      yield ENC.encode(
        `${last === null ? '' : '\n'}==> ${isStdin(p) ? '(standard input)' : p.rawPath} <==\n`,
      )
    }
    last = slot
    yield tailBytes(raw, counts)
    positions.set(slot, raw.byteLength)
  }
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
          // the initial open alone, as in GNU.
          if (flags.byName) {
            note(
              io,
              `tail: '${p.rawPath}' has become inaccessible: ${fsStrerror(err) ?? 'No such file or directory'}\n`,
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
          yield ENC.encode(`\n==> ${isStdin(p) ? '(standard input)' : p.rawPath} <==\n`)
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

// Whether this operand's whole content is what tail emits, which is what
// makes it worth handing to the file cache. Counting from the start is
// never treated as a full read, matching what `-n +N` has always done.
function readsEverything(rawCounts: TailCounts, raw: Uint8Array): boolean {
  const counts = normalizeCounts(rawCounts)
  if (counts.fromByte !== null || counts.fromLine !== null) return false
  if (counts.byteCount !== null) return counts.byteCount >= raw.byteLength
  return (counts.lines ?? 10) >= countNewlines(raw)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

const RETRY_IGNORED = 'tail: warning: --retry ignored; --retry is useful only when following\n'
// What a waited-for name is announced as when it turns up: a missing file
// has appeared, an untailable one (a directory) has become accessible.
const APPEARED = 'has appeared;  following new file'
const ACCESSIBLE = 'has become accessible'

export async function tailGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
  stat: Stat,
  readRange: ReadRange | null = null,
): Promise<CommandFnResult> {
  stat = stdinStat(stat)
  const fl = new FlagView(opts.flags, specOf('tail'))
  // A follow reads the backend itself, never the read-through cache:
  // what it is polling for is exactly the change the cached body does
  // not have yet.
  const backend = stream
  stream = stdinStream(cacheAwareStreamEager(stream), opts.stdin)
  const nRaw = fl.asStr('n') ?? null
  const cRaw = fl.asStr('c') ?? null
  const numErr = numberFlagError('tail', nRaw, cRaw)
  if (numErr !== null) return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(numErr) })]
  const following = followFlags(fl)
  if (typeof following === 'string')
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(following) })]
  const qFlag = fl.asBool('q')
  const vFlag = fl.asBool('v')
  const counts = parseCounts(nRaw, cRaw)
  // GNU warns first, then tails as if --retry were not there.
  const retryWarning = following.retry && !following.follow ? RETRY_IGNORED : ''
  if (paths.length > 0 && following.follow) {
    const showHeaders = (vFlag || paths.length > 1) && !qFlag
    const readable: PathSpec[] = []
    let err = ''
    for (const p of paths) {
      try {
        const found = await stat(p)
        if (found.type === FileType.DIRECTORY) {
          err += `tail: ${p.rawPath}: Is a directory\n`
          continue
        }
        readable.push(p)
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('tail', p, e)
      }
    }
    const warn =
      following.retry && !following.byName
        ? 'tail: warning: --retry only effective for the initial open\n'
        : ''
    const io = new IOResult({
      exitCode: err === '' ? 0 : 1,
      stderr: warn + err === '' ? null : ENC.encode(warn + err),
    })
    const pending = await unfollowable(
      paths,
      new Set(readable.map((p) => p.virtual)),
      stat,
      following,
      io,
    )
    if (readable.length === 0 && pending.length === 0) {
      note(io, 'tail: no files remaining\n')
      io.exitCode = 1
      return [null, io]
    }
    return [
      follow(
        readable,
        pending,
        backend,
        stat,
        readRange,
        counts,
        showHeaders,
        following,
        io,
        opts.signal,
      ),
      io,
    ]
  }

  if (paths.length > 0) {
    const chunks: Uint8Array[] = []
    const cache: string[] = []
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
        continue
      }
      if (showHeaders) {
        // Separator keyed on printed blocks, not operand index: a good file
        // after a failed operand starts without a leading blank line (GNU).
        const header =
          printed > 0
            ? `\n==> ${isStdin(p) ? '(standard input)' : p.rawPath} <==\n`
            : `==> ${isStdin(p) ? '(standard input)' : p.rawPath} <==\n`
        chunks.push(ENC.encode(header))
      }
      printed += 1
      chunks.push(tailBytes(raw, counts))
      if (!isStdin(p) && readsEverything(counts, raw)) cache.push(p.virtual)
    }
    const io = new IOResult({
      cache,
      exitCode: err === '' ? 0 : 1,
      stderr: retryWarning + err === '' ? null : ENC.encode(retryWarning + err),
    })
    if (printed === 0 && err !== '') return [null, io]
    const out: ByteSource = concat(chunks)
    return [out, io]
  }
  const raw = await readStdinAsync(opts.stdin)
  if (raw === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tail: missing operand\n') })]
  }
  return [
    tailBytes(raw, counts),
    new IOResult({ stderr: retryWarning === '' ? null : ENC.encode(retryWarning) }),
  ]
}
