import type { Accessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { FileStat, FileType, type PathSpec } from '../types.ts'
import { ancestorEntry, resolveEntry, type ReaddirFn } from './hierarchy/probe.ts'
import type { Guard } from './hierarchy/readdir.ts'
import type { ScopeMatch } from './hierarchy/scope.ts'
import type { StatHook } from './hierarchy/stat.ts'
import { enoent } from '../errors/fs.ts'

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
