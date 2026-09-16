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

import type { CalendarEvent, EventTime } from '../store/types.ts'

// The two spellings the Event resource allows. `date` is yyyy-mm-dd and
// `dateTime` an RFC3339 date-time whose offset, when present, is `Z` or
// ±hh:mm. A match is then checked as a calendar date, since a regex cannot
// know how long February is.
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function daysIn(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0)
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month)
}

// A `date` value as the UTC midnight of that wall-clock day, or null when it
// is not spelled yyyy-mm-dd or is not a day the calendar has.
export function parseDate(value: string): number | null {
  const m = DATE.exec(value)
  if (m === null) return null
  if (!isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return null
  return Date.parse(`${value}T00:00:00Z`)
}

export interface ParsedDateTime {
  // The wall-clock reading as if it were UTC. It becomes an instant once
  // the offset, or the zone the slot names, is applied.
  wall: number
  // Minutes east of UTC, or null when the value carried no offset.
  offset: number | null
}

// A `dateTime` value, or null when it is not an RFC3339 date-time.
export function parseDateTime(value: string): ParsedDateTime | null {
  const m = DATE_TIME.exec(value)
  if (m === null) return null
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number)
  if (!isCalendarDate(year ?? 0, month ?? 0, day ?? 0)) return null
  if ((hour ?? 0) > 23 || (minute ?? 0) > 59 || (second ?? 0) > 59) return null
  const frac = m[7]
  const millis = frac === undefined ? '' : `.${frac.slice(1, 4).padEnd(3, '0')}`
  const wall = Date.parse(`${value.slice(0, 19)}${millis}Z`)
  const tail = m[8]
  if (tail === undefined) return { wall, offset: null }
  if (tail === 'Z') return { wall, offset: 0 }
  const hours = Number(tail.slice(1, 3))
  const minutes = Number(tail.slice(4, 6))
  if (hours > 23 || minutes > 59) return null
  return { wall, offset: (tail.startsWith('-') ? -1 : 1) * (hours * 60 + minutes) }
}

// Whether `name` is a zone the runtime's IANA table resolves. The
// constructor is the check: it raises RangeError for anything else.
export function isIanaZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch (err) {
    if (err instanceof RangeError) return false
    throw err
  }
}

export function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0')
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asUtc - Math.floor(instant / 1000) * 1000
}

// A wall-clock reading (as UTC millis) resolved in `timeZone`, as an
// absolute instant. Two passes because the offset itself depends on the
// instant: on a DST boundary the first guess lands in the wrong offset and
// corrects on retry.
export function wallClockMs(wall: number, timeZone: string): number {
  const once = wall - zoneOffsetMs(wall, timeZone)
  return wall - zoneOffsetMs(once, timeZone)
}

export function zonedMidnight(date: string, timeZone: string): number {
  const wall = parseDate(date)
  if (wall === null) throw new Error(`a stored all-day event is not a calendar date: ${date}`)
  return wallClockMs(wall, timeZone)
}

// The instant a `dateTime` slot names, or null when it names none: the
// value is not a date-time, or it carries no offset and the slot declares
// no zone to read the wall clock in. Both readers of a stored slot need
// this and they need it to agree, since one sorts and bounds events by it
// and the other renders it back.
function dateTimeMs(slot: EventTime): number | null {
  if (slot.dateTime === undefined) return null
  const parsed = parseDateTime(slot.dateTime)
  if (parsed === null) return null
  if (parsed.offset !== null) return parsed.wall - parsed.offset * 60_000
  if (slot.timeZone === undefined) return null
  return wallClockMs(parsed.wall, slot.timeZone)
}

// An offset is mandatory on dateTime UNLESS the slot names its own zone, so
// a bare wall clock there is a zoned event. `readEventTimes` refuses every
// other spelling before it is stored, which makes a slot this cannot read a
// fake bug: it is reported as one rather than as a NaN that a bounded list
// silently drops and a sort silently misplaces.
export function slotMs(slot: EventTime, fallbackTz: string): number | null {
  if (slot.dateTime !== undefined) {
    const instant = dateTimeMs(slot)
    if (instant === null) {
      throw new Error(`a stored event time has no offset and no zone: ${slot.dateTime}`)
    }
    return instant
  }
  if (slot.date !== undefined) return zonedMidnight(slot.date, fallbackTz)
  return null
}

export function eventStartMs(ev: CalendarEvent, tz: string): number {
  return slotMs(ev.start, tz) ?? 0
}

// An all-day event's end.date is EXCLUSIVE, so a single-day event spans
// start=D, end=D+1 and its instant end is midnight opening the next day.
export function eventEndMs(ev: CalendarEvent, tz: string): number {
  return slotMs(ev.end, tz) ?? eventStartMs(ev, tz)
}

// One slot as the Event resource renders it back.
//
// Probed against the live API on 2026-09-15, because every clause here is a
// choice the docs do not make for you. Google answers a `dateTime` with an
// OFFSET ALWAYS, and that offset is the CALENDAR's zone, never the event's:
// a slot written `20:59:00` in `Etc/GMT+12` comes back `01:59:00-07:00` on a
// Los_Angeles calendar, and one written `Asia/Tokyo` comes back at -07:00
// too. The `timeZone` field rides along as the event's declared zone, filled
// in from the calendar when the request named none. An already-offset-bearing
// value is re-rendered rather than echoed, fractional seconds are dropped,
// and an all-day `date` slot is left exactly as it came.
//
// Args:
//   slot: the stored event time.
//   calendarTz: the calendar's own zone, which every rendering is in.
export function formatEventTime(slot: EventTime, calendarTz: string): EventTime {
  if (slot.dateTime === undefined) return { ...slot }
  const instant = dateTimeMs(slot)
  // Unreachable for a stored slot (`slotRefusal` runs before anything is
  // stored), but rendering a NaN would be worse than rendering the input.
  if (instant === null) return { ...slot }
  return {
    ...slot,
    dateTime: renderIn(instant, calendarTz),
    timeZone: slot.timeZone ?? calendarTz,
  }
}

// An instant as RFC3339 in `timeZone`: seconds precision with a ±hh:mm
// offset, which is the only dateTime shape the live API emits.
function renderIn(instant: number, timeZone: string): string {
  // Whole minutes, and the SAME rounded number on both halves below. A
  // zone's historical offset can carry seconds -- Europe/Paris ran at
  // +00:09:21 until 1911, which Intl reports as 9.35 minutes -- and
  // RFC3339 has nowhere to put them: the raw value rendered `+00:9.35`,
  // which is not a timestamp at all, and the formatter rewrites even an
  // input that arrived with its own offset. Rounding the wall clock by
  // the same number keeps the rendered value pointing at the instant it
  // came from, which is what a caller reads back; only the local
  // reading drifts, by under a minute, and only for dates old enough to
  // predate minute-aligned zones.
  const offset = Math.round(zoneOffsetMs(instant, timeZone) / 60_000)
  const minutes = Math.abs(offset)
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  const suffix = `${offset < 0 ? '-' : '+'}${hh}:${mm}`
  const wall = new Date(instant + offset * 60_000).toISOString().slice(0, 19)
  return `${wall}${suffix}`
}
