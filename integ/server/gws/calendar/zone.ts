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

// An offset is mandatory on dateTime UNLESS the slot names its own zone, so
// a bare wall clock there is a zoned event. `readEventTimes` refuses every
// other spelling before it is stored, which makes a slot this cannot read a
// fake bug: it is reported as one rather than as a NaN that a bounded list
// silently drops and a sort silently misplaces.
export function slotMs(slot: EventTime, fallbackTz: string): number | null {
  if (slot.dateTime !== undefined) {
    const parsed = parseDateTime(slot.dateTime)
    if (parsed !== null && parsed.offset !== null) return parsed.wall - parsed.offset * 60_000
    if (parsed !== null && slot.timeZone !== undefined) {
      return wallClockMs(parsed.wall, slot.timeZone)
    }
    throw new Error(`a stored event time has no offset and no zone: ${slot.dateTime}`)
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

export function formatEventTime(slot: EventTime): EventTime {
  if (slot.dateTime === undefined) return { ...slot }
  const parsed = parseDateTime(slot.dateTime)
  if (parsed === null || parsed.offset !== null || slot.timeZone === undefined) return { ...slot }
  const instant = wallClockMs(parsed.wall, slot.timeZone)
  const offset = zoneOffsetMs(instant, slot.timeZone) / 60_000
  const minutes = Math.abs(offset)
  const suffix = `${offset < 0 ? '-' : '+'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  const wall = new Date(instant + offset * 60_000).toISOString().slice(0, 19)
  const fraction = DATE_TIME.exec(slot.dateTime)?.[7] ?? ''
  return { ...slot, dateTime: `${wall}${fraction}${suffix}` }
}
