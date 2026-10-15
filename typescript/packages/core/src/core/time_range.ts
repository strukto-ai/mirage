import type { Accessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { FileStat, FileType, type PathSpec } from '../types.ts'
import { ancestorEntry, resolveEntry, type ReaddirFn } from './hierarchy/probe.ts'
import type { Guard } from './hierarchy/readdir.ts'
import type { ScopeMatch } from './hierarchy/scope.ts'
import type { StatHook } from './hierarchy/stat.ts'
import { enoent } from '../errors/fs.ts'
import { abortable, sleep } from '../utils/abort.ts'
import { jsonlBytes } from './render/json.ts'
import { compareCodePoints } from '../utils/sort.ts'

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

export function parseTime(value: string): number {
  const date = value.slice(0, 10)
  const stamp = Date.parse(value)
  if (
    Number(value.slice(0, 4)) === 0 ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(stamp) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
    Number(value.slice(11, 13)) > 23
  ) {
    throw new Error('expected RFC3339 timestamp with timezone and at most millisecond precision')
  }
  return stamp / 1000
}

export class TimeRange {
  readonly start: number | null
  readonly end: number | null

  constructor(start?: string | null, end?: string | null) {
    this.start = start == null ? null : parseTime(start)
    this.end = end == null ? null : parseTime(end)
    if (this.start !== null && this.end !== null && this.start >= this.end)
      throw new Error('start_time must be earlier than end_time')
  }

  get bounded(): boolean {
    return this.start !== null || this.end !== null
  }

  clip(start: number, end: number): [number, number] {
    return [Math.max(start, this.start ?? start), Math.min(end, this.end ?? end)]
  }

  dayBounds(day: string): [number, number] {
    const start = Date.parse(`${day}T00:00:00Z`) / 1000
    return this.clip(start, start + 86400)
  }

  requireDay(day: string, path: string): void {
    const [start, end] = this.dayBounds(day)
    if (start >= end) throw enoent(path)
  }

  listingDays(
    first: string,
    last: string,
    span: readonly [string, string] | null = null,
  ): string[] {
    let lo = Date.parse(`${first}T00:00:00Z`) / 1000
    let hi = Date.parse(`${last}T00:00:00Z`) / 1000
    if (this.start !== null) lo = Math.max(lo, Math.floor(this.start / 86400) * 86400)
    if (this.end !== null) hi = Math.min(hi, Math.floor(this.end / 86400) * 86400)
    if (span !== null) {
      lo = Math.max(lo, Date.parse(`${span[0]}T00:00:00Z`) / 1000)
      hi = Math.min(hi, Date.parse(`${span[1]}T00:00:00Z`) / 1000 - 86400)
    }
    const days: string[] = []
    for (let day = lo; day <= hi; day += 86400) {
      const [start, end] = this.clip(day, day + 86400)
      if (start < end) days.push(new Date(day * 1000).toISOString().slice(0, 10))
    }
    return days
  }

  prompt(): string {
    const start = this.start === null ? 'unbounded' : new Date(this.start * 1000).toISOString()
    const end = this.end === null ? 'unbounded' : new Date(this.end * 1000).toISOString()
    return `\n  Time scope: start_time=${start} (inclusive), end_time=${end} (exclusive). Explicit paths and globs cannot escape this scope.`
  }
}

export function guardDay(
  accessor: { readonly timeRange: TimeRange },
  match: ScopeMatch,
  virtual: string,
): Promise<void> {
  accessor.timeRange.requireDay(match.slots.day ?? '', virtual)
  return Promise.resolve()
}

/**
 * The channel a day's chat.jsonl reads, proven by the listing.
 *
 * The typed `name__id` dirname is only trusted once the listing proves it,
 * so a fabricated channel id is ENOENT rather than a raw API error. A sealed
 * day lists nothing but the file still reads through the channel,
 * reproducing the API's own answer for the fetch. Mirrors Python's
 * `day_channel_id`.
 */
export async function dayChannelId<A extends Accessor>(
  readdir: ReaddirFn<A>,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry !== null) return entry.id.split(':', 1)[0] ?? ''
  const channel = await ancestorEntry(readdir, accessor, path, index, 2)
  if (channel === null) throw enoent(path)
  return channel.id
}

/**
 * Stat a day directory, which resolves beyond the listed window.
 *
 * The parent listing synthesizes a bounded window of recent days, but the API
 * answers a range query for any date, so a well-formed day under a parent that
 * exists is a directory whether or not the window lists it. A bogus parent
 * chain is ENOENT. `guard` refuses a day outside the mount's scope before any
 * lookup, `guardDay` on a scoped mount. Mirrors Python's `day_stat`.
 */
export function dayStat<A extends Accessor>(readdir: ReaddirFn<A>, guard?: Guard<A>): StatHook<A> {
  return async (accessor, match, path, index) => {
    if (guard !== undefined) await guard(accessor, match, path.virtual)
    const entry = await resolveEntry(readdir, accessor, path, index)
    if (entry !== null) return new FileStat({ name: entry.vfsName, type: FileType.DIRECTORY })
    if ((await ancestorEntry(readdir, accessor, path, index, 1)) === null) throw enoent(path)
    return new FileStat({ name: match.slots.day ?? '', type: FileType.DIRECTORY })
  }
}

/**
 * A chat day's last `n` messages, then each one posted to it after them, as
 * its chat.jsonl lines.
 *
 * `messages` is the day as a read lists it, so its last `n` come first. Then
 * every `interval` seconds `after` is asked for the messages posted since the
 * last one seen (the whole day while none is), until a poll that starts once
 * the day is over: nothing can land in it after that, and the stream waits to
 * be closed, as `tail -f` waits on a file that stops growing. Each ask starts
 * where the last answer ended, so none is lost or printed twice. An iterator
 * rather than a generator: a generator queues `return` behind a pull waiting
 * out its interval, so an idle `tail -f` could never close it. Closing also
 * ends a pull waiting on a stalled ask, whose late answer is dropped, as
 * Python's task cancel ends it there. Mirrors Python's `followed_day`.
 */
export function followedDay<M>(
  messages: readonly M[],
  n: number,
  end: number,
  interval: number,
  after: (last: M | null) => Promise<M[]>,
): AsyncIterableIterator<Uint8Array> {
  let last: M | null = messages[messages.length - 1] ?? null
  let pending: Uint8Array | null =
    n > 0 && messages.length > 0 ? jsonlBytes(messages.slice(-n)) : null
  let over = false
  const stop = new AbortController()
  const done: IteratorResult<Uint8Array> = { value: undefined, done: true }
  return {
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (pending !== null) {
        const value = pending
        pending = null
        return { value, done: false }
      }
      try {
        while (!over) {
          await sleep(interval * 1000, stop.signal)
          over = Date.now() / 1000 >= end
          const added = await abortable(after(last), stop.signal)
          if (added.length > 0) {
            last = added[added.length - 1] ?? last
            return { value: jsonlBytes(added), done: false }
          }
        }
        await sleep(Number.POSITIVE_INFINITY, stop.signal)
      } catch (err) {
        if (stop.signal.aborted) return done
        throw err
      }
      return done
    },
    return(): Promise<IteratorResult<Uint8Array>> {
      stop.abort()
      pending = null
      return Promise.resolve(done)
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

/**
 * Several chat days' chat.jsonl files, one fetch per run of a channel's
 * consecutive days.
 *
 * Each file is proven as its own read proves it (a day in scope, a channel
 * the listing holds); one that is not, or is no chat file, is left out for its
 * own read to answer. Each day's lines are the run's messages posted within
 * it, oldest first, as its own read lists them. `fetch(channelId, first,
 * last)` answers a channel's messages from a run's first day through its
 * last, oldest first; `within(message, start, end)` whether a message was
 * posted in a day's bounds. Mirrors Python's `read_days`.
 */
export async function readDays<A extends Accessor, M>(
  readdir: ReaddirFn<A>,
  accessor: A,
  scope: TimeRange,
  paths: readonly PathSpec[],
  index: IndexCacheStore | undefined,
  detect: (path: PathSpec) => ScopeMatch,
  fetch: (channelId: string, first: string, last: string) => Promise<M[]>,
  within: (message: M, start: number, end: number) => boolean,
): Promise<Map<string, Uint8Array>> {
  const days = new Map<string, Map<string, string>>()
  for (const path of paths) {
    const match = detect(path)
    if (match.kind !== 'messages') continue
    const day = match.slots.day ?? ''
    let channelId: string
    try {
      scope.requireDay(day, path.virtual)
      channelId = await dayChannelId(readdir, accessor, path, index)
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err
      console.debug(`readDays leaves out ${path.virtual}: ${String(err)}`)
      continue
    }
    const named = days.get(channelId) ?? new Map<string, string>()
    named.set(day, path.virtual)
    days.set(channelId, named)
  }
  const answers = new Map<string, Uint8Array>()
  for (const [channelId, named] of days) {
    let run: string[] = []
    for (const day of [...named.keys()].sort(compareCodePoints)) {
      const last = run[run.length - 1]
      if (
        last !== undefined &&
        Date.parse(`${day}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`) !== 86_400_000
      ) {
        for (const [virtual, body] of await readRun(channelId, run, named, scope, fetch, within)) {
          answers.set(virtual, body)
        }
        run = []
      }
      run.push(day)
    }
    for (const [virtual, body] of await readRun(channelId, run, named, scope, fetch, within)) {
      answers.set(virtual, body)
    }
  }
  return answers
}

/** One run of a channel's consecutive days, fetched once. Mirrors Python's `_read_run`. */
async function readRun<M>(
  channelId: string,
  run: readonly string[],
  named: ReadonlyMap<string, string>,
  scope: TimeRange,
  fetch: (channelId: string, first: string, last: string) => Promise<M[]>,
  within: (message: M, start: number, end: number) => boolean,
): Promise<Map<string, Uint8Array>> {
  const answers = new Map<string, Uint8Array>()
  const [first] = run
  const last = run[run.length - 1]
  if (first === undefined || last === undefined) return answers
  const messages = await fetch(channelId, first, last)
  for (const day of run) {
    const [start, end] = scope.dayBounds(day)
    answers.set(named.get(day) ?? '', jsonlBytes(messages.filter((m) => within(m, start, end))))
  }
  return answers
}
