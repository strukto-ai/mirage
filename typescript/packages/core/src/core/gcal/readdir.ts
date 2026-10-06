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

import type { TimeRange } from '../time_range.ts'
import { parseTime } from '../time_range.ts'
import type { GCalAccessor } from '../../accessor/gcal.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import {
  CALENDAR_FILE,
  PRIMARY_DIR,
  eventTitle,
  makeCalendarDirname,
  makeEventFilename,
} from '../../vfs/gcal/event_entry.ts'
import type { JsonValue, PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { globPrefix, literalSpan } from '../../utils/glob_walk.ts'
import {
  SPAN_SEP,
  bucketName,
  bucketStart,
  clampedHhmm,
  dayBounds,
  localDate,
  daysCovered,
  eventSpan,
  parseBucket,
  shiftDay,
  windowBounds,
} from './day.ts'
import { ROOT } from '../hierarchy/scope.ts'
import { detectScope } from './scope.ts'
import { listCalendars, listEvents } from './client.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { compactJsonBytes } from '../render/json.ts'

const CALENDAR_DIR = 'gcal/calendar_dir'
export const CALENDAR_JSON = 'gcal/calendar_json'
const BUCKET_DIR = 'gcal/bucket_dir'
export const EVENT = 'gcal/event'
const FREE_BUSY_ROLE = 'freeBusyReader'

export type CalendarEntryRow = Record<string, JsonValue>

/** Render the per-calendar metadata file. */
export function calendarPayload(entry: CalendarEntryRow, tz: string): Uint8Array {
  return compactJsonBytes({
    id: entry.id ?? null,
    summary: entry.summary ?? null,
    accessRole: entry.accessRole ?? null,
    primary: entry.primary === true,
    calendarTimeZone: entry.timeZone ?? null,
    // The zone the day directories are bucketed in, which is mount-wide
    // and therefore not always this calendar's own.
    bucketTimeZone: tz,
  })
}

/** Split a path into `[mount prefix, mount-relative key, virtual key]`. */
export function normalize(path: PathSpec): [string, string, string] {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const key = (path.pattern !== null ? path.dir : path).vfsPath
  const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'
  return [prefix, key, virtualKey]
}

/** Map each calendar's directory name to its calendarList entry. */
export async function calendarIndex(
  accessor: GCalAccessor,
): Promise<Map<string, CalendarEntryRow>> {
  const rows = await listCalendars(accessor.tokenManager, accessor.config.minAccessRole)
  const out = new Map<string, CalendarEntryRow>()
  for (const row of rows) {
    const calId = row.id
    if (typeof calId !== 'string' || calId === '') continue
    const summary = row.summary
    const name = makeCalendarDirname(
      typeof summary === 'string' ? summary : calId,
      calId,
      row.primary === true,
    )
    out.set(name, row)
  }
  return out
}

/**
 * The one zone every day directory on this mount is bucketed in.
 *
 * Defaults to the primary calendar's zone, matching how the Calendar UI
 * draws its grid: bucketing each calendar in its own zone would make the
 * same directory name mean different 24-hour windows on different
 * calendars, so a cross-calendar free/busy comparison would be wrong.
 */
export function bucketZone(
  accessor: GCalAccessor,
  calendars: Map<string, CalendarEntryRow>,
): string {
  const pinned = accessor.config.timeZone
  if (pinned !== undefined && pinned !== '') return pinned
  const primary = calendars.get(PRIMARY_DIR)
  if (primary !== undefined) {
    const tz = primary.timeZone
    if (typeof tz === 'string' && tz !== '') return tz
  }
  for (const entry of calendars.values()) {
    const tz = entry.timeZone
    if (typeof tz === 'string' && tz !== '') return tz
  }
  return 'UTC'
}

/**
 * The listing window, honouring a date glob when one was typed.
 *
 * A bare readdir reports a rolling window around today because a calendar
 * is unbounded in both directions and the API offers no descending
 * startTime order. A glob escapes it by pushing its own bounds down, widened
 * to whole buckets so a bucket the glob reaches into is decided on all of
 * its days, not only on the ones it named. A glob is read up to its first
 * span separator: a bucket name is keyed on its first day, so
 * `2027-03-01--2027-03-07*` bounds the listing as `2027-03-01*` does.
 */
function daySpan(
  pattern: string | null,
  today: string,
  tz: string,
  scope: TimeRange,
  size: number,
): [string | null, string, string, string] {
  const span = literalSpan(globPrefix(pattern).split(SPAN_SEP, 1)[0] ?? '')
  let lo = scope.start
  let hi = scope.end
  if (span !== null) {
    const first = parseTime(dayBounds(bucketStart(span[0], size), tz)[0])
    const last = parseTime(dayBounds(bucketStart(shiftDay(span[1], -1), size), tz, size)[1])
    lo = Math.max(first, lo ?? first)
    hi = Math.min(last, hi ?? last)
  } else hi ??= parseTime(windowBounds(today, tz, size)[1])
  return [
    lo === null ? null : new Date(lo * 1000).toISOString(),
    new Date(hi * 1000).toISOString(),
    lo === null ? '0001-01-01' : localDate(lo * 1000, tz),
    localDate(hi * 1000 - 1, tz),
  ]
}

/**
 * The days of a bucket directory inside the configured mount scope.
 *
 * A name off this mount's grid is absent, as is a bucket wholly outside the
 * scope: direct paths are bounded exactly as listings are. The days come
 * back ascending and consecutive.
 */
export function scopedBucket(
  accessor: GCalAccessor,
  name: string,
  tz: string,
  virtual: string,
): string[] {
  const size = accessor.config.bucketDays
  const start = parseBucket(name, size)
  if (start === null) throw enoent(virtual)
  const days: string[] = []
  for (let offset = 0; offset < size; offset++) {
    const day = shiftDay(start, offset)
    const [lo, hi] = dayBounds(day, tz)
    const [from, to] = accessor.timeRange.clip(parseTime(lo), parseTime(hi))
    if (from < to) days.push(day)
  }
  if (days.length === 0) throw enoent(virtual)
  return days
}

/**
 * Build the index entries for one bucket directory.
 *
 * An event gets one entry for each of the bucket's days it covers, so a
 * multi-day bucket lists what its day directories would, flattened, each
 * name carrying its day when `dated`.
 */
function eventEntries(
  events: CalendarEntryRow[],
  days: readonly string[],
  tz: string,
  freeBusy: boolean,
  dated: boolean,
): [string, IndexEntry][] {
  const rows: [string, IndexEntry][] = []
  for (const event of events) {
    const eventId = event.id
    if (typeof eventId !== 'string' || eventId === '') continue
    const span = eventSpan(event, tz)
    if (span === null) continue
    const summary = event.summary
    const title = eventTitle(typeof summary === 'string' ? summary : null, freeBusy)
    const updated = event.updated
    const size = compactJsonBytes(event).length
    for (const day of daysCovered(span, tz)) {
      if (!days.includes(day)) continue
      const name = makeEventFilename(eventId, clampedHhmm(span, day, tz), title, dated ? day : null)
      rows.push([
        name,
        new IndexEntry({
          id: eventId,
          name: title,
          resourceType: EVENT,
          remoteTime: typeof updated === 'string' ? updated : '',
          vfsName: name,
          size,
        }),
      ])
    }
  }
  return rows
}

/** List one level of the calendar tree. */
export async function readdir(
  accessor: GCalAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const [prefix, key, virtualKey] = normalize(path)
  // Bespoke below the classifier: the date-glob push-down filters the
  // events query itself, and a globbed listing must not be cached as the
  // directory, which the kit readdir has no notion of.
  const match = detectScope(key)
  if (match.kind !== ROOT && match.kind !== 'calendar' && match.kind !== 'bucket') {
    throw enoent(path.virtual)
  }
  const calendars = await calendarIndex(accessor)
  const tz = bucketZone(accessor, calendars)

  if (match.kind === ROOT) {
    const entries: [string, IndexEntry][] = [...calendars.entries()]
      .sort((a, b) => compareCodePoints(a[0], b[0]))
      .map(([name, entry]) => [
        name,
        new IndexEntry({
          id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : name,
          name,
          resourceType: CALENDAR_DIR,
          vfsName: name,
        }),
      ])
    if (index !== undefined) await index.setDir(virtualKey, entries)
    return entries.map(([name]) => `${prefix}/${name}`)
  }

  const entry = calendars.get(match.slots.calendar ?? '')
  if (entry === undefined) throw enoent(path.virtual)
  const calId = entry.id
  if (typeof calId !== 'string') throw enoent(path.virtual)
  const freeBusy = entry.accessRole === FREE_BUSY_ROLE
  const size = accessor.config.bucketDays

  if (match.kind === 'calendar') {
    const [timeMin, timeMax, first, last] = daySpan(
      path.pattern,
      accessor.today(tz),
      tz,
      accessor.timeRange,
      size,
    )
    const events = await listEvents(
      accessor.tokenManager,
      calId,
      timeMin,
      timeMax,
      tz,
      accessor.timeRange,
    )
    const seen = new Set<string>()
    for (const event of events) {
      const span = eventSpan(event, tz)
      if (span === null) continue
      for (const day of daysCovered(span, tz)) {
        if (day >= first && day <= last) seen.add(bucketName(bucketStart(day, size), size))
      }
    }
    const rows: [string, IndexEntry][] = [
      [
        CALENDAR_FILE,
        new IndexEntry({
          id: `${calId}:calendar`,
          name: CALENDAR_FILE,
          resourceType: CALENDAR_JSON,
          vfsName: CALENDAR_FILE,
          size: calendarPayload(entry, tz).length,
        }),
      ],
    ]
    for (const name of [...seen].sort(compareCodePoints)) {
      rows.push([
        name,
        new IndexEntry({
          id: `${calId}:${name}`,
          name,
          resourceType: BUCKET_DIR,
          vfsName: name,
        }),
      ])
    }
    if (index !== undefined) {
      if (path.pattern !== null) {
        // A globbed listing is a filtered view, not the directory: caching
        // it as the directory would pin a short listing until it expires.
        for (const [name, row] of rows) await index.put(`${virtualKey}/${name}`, row)
      } else {
        await index.setDir(virtualKey, rows)
      }
    }
    return rows.map(([name]) => `${prefix}/${key}/${name}`)
  }

  const days = scopedBucket(accessor, match.slots.bucket ?? '', tz, path.virtual)
  const [timeMin, timeMax] = dayBounds(days[0] ?? '', tz, days.length)
  const events = await listEvents(
    accessor.tokenManager,
    calId,
    timeMin,
    timeMax,
    tz,
    accessor.timeRange,
  )
  const rows = eventEntries(events, days, tz, freeBusy, size > 1)
  if (index !== undefined) await index.setDir(virtualKey, rows)
  return rows.map(([name]) => `${prefix}/${key}/${name}`)
}
