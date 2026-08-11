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

import type { GCalAccessor } from '../../accessor/gcal.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import {
  CALENDAR_FILE,
  PRIMARY_DIR,
  eventTitle,
  makeCalendarDirname,
  makeEventFilename,
} from '../../resource/gcal/event_entry.ts'
import type { JsonValue, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { globToDateRange } from '../google/date_glob.ts'
import {
  WINDOW_AHEAD_DAYS,
  WINDOW_BACK_DAYS,
  clampedHhmm,
  dayBounds,
  daysCovered,
  eventSpan,
  shiftDay,
  validDay,
  windowBounds,
} from './day.ts'
import { listCalendars, listEvents } from './client.ts'

const CALENDAR_DIR = 'gcal/calendar_dir'
export const CALENDAR_JSON = 'gcal/calendar_json'
const DAY_DIR = 'gcal/day_dir'
export const EVENT = 'gcal/event'
const FREE_BUSY_ROLE = 'freeBusyReader'

const ENC = new TextEncoder()

export type CalendarEntryRow = Record<string, JsonValue>

/** Render the per-calendar metadata file. */
export function calendarPayload(entry: CalendarEntryRow, tz: string): Uint8Array {
  return ENC.encode(
    JSON.stringify({
      id: entry.id ?? null,
      summary: entry.summary ?? null,
      accessRole: entry.accessRole ?? null,
      primary: entry.primary === true,
      calendarTimeZone: entry.timeZone ?? null,
      // The zone the day directories are bucketed in, which is mount-wide
      // and therefore not always this calendar's own.
      bucketTimeZone: tz,
    }),
  )
}

/** Split a path into `[mount prefix, mount-relative key, virtual key]`. */
export function normalize(path: PathSpec): [string, string, string] {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = (path.pattern !== null ? path.dir : path).resourcePath
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
 * startTime order. A glob escapes it by pushing its own bounds down.
 */
function daySpan(
  pattern: string | null,
  today: string,
  tz: string,
): [string, string, string, string] {
  const span = globToDateRange(pattern)
  if (span !== null) {
    const last = shiftDay(span[1], -1)
    return [dayBounds(span[0], tz)[0], dayBounds(last, tz)[1], span[0], last]
  }
  const [lo, hi] = windowBounds(today, tz)
  return [lo, hi, shiftDay(today, -WINDOW_BACK_DAYS), shiftDay(today, WINDOW_AHEAD_DAYS)]
}

/** Build the index entries for one day directory. */
function eventEntries(
  events: CalendarEntryRow[],
  day: string,
  tz: string,
  freeBusy: boolean,
): [string, IndexEntry][] {
  const rows: [string, IndexEntry][] = []
  for (const event of events) {
    const eventId = event.id
    if (typeof eventId !== 'string' || eventId === '') continue
    const span = eventSpan(event, tz)
    if (span === null || !daysCovered(span, tz).includes(day)) continue
    const summary = event.summary
    const title = eventTitle(typeof summary === 'string' ? summary : null, freeBusy)
    const name = makeEventFilename(eventId, clampedHhmm(span, day, tz), title)
    const updated = event.updated
    rows.push([
      name,
      new IndexEntry({
        id: eventId,
        name: title,
        resourceType: EVENT,
        remoteTime: typeof updated === 'string' ? updated : '',
        vfsName: name,
        size: ENC.encode(JSON.stringify(event)).length,
      }),
    ])
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
  const calendars = await calendarIndex(accessor)
  const tz = bucketZone(accessor, calendars)

  if (key === '') {
    const entries: [string, IndexEntry][] = [...calendars.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
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

  const parts = key.split('/')
  const [calName = '', day = ''] = parts
  const entry = calendars.get(calName)
  if (entry === undefined || parts.length > 2) throw enoent(path.virtual)
  const calId = entry.id
  if (typeof calId !== 'string') throw enoent(path.virtual)
  const freeBusy = entry.accessRole === FREE_BUSY_ROLE

  if (parts.length === 1) {
    const [timeMin, timeMax, first, last] = daySpan(path.pattern, accessor.today(tz), tz)
    const events = await listEvents(accessor.tokenManager, calId, timeMin, timeMax, tz)
    const seen = new Set<string>()
    for (const event of events) {
      const span = eventSpan(event, tz)
      if (span === null) continue
      for (const day of daysCovered(span, tz)) {
        if (day >= first && day <= last) seen.add(day)
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
    for (const day of [...seen].sort()) {
      rows.push([
        day,
        new IndexEntry({
          id: `${calId}:${day}`,
          name: day,
          resourceType: DAY_DIR,
          vfsName: day,
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

  if (!validDay(day)) throw enoent(path.virtual)
  const [timeMin, timeMax] = dayBounds(day, tz)
  const events = await listEvents(accessor.tokenManager, calId, timeMin, timeMax, tz)
  const rows = eventEntries(events, day, tz, freeBusy)
  if (index !== undefined) await index.setDir(virtualKey, rows)
  return rows.map(([name]) => `${prefix}/${key}/${name}`)
}
