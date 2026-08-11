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

import type { JsonValue } from '../../types.ts'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_TZ = 'UTC'
// The rolling window a bare readdir of a calendar reports. A calendar is
// unbounded in both directions and the API offers no descending startTime
// order, so a full listing means paging to the end; the window is stated in
// the mount prompt rather than applied silently, and any date glob escapes it.
export const WINDOW_BACK_DAYS = 30
export const WINDOW_AHEAD_DAYS = 90

const DAY_MS = 86_400_000

// An offset is mandatory on dateTime UNLESS the slot names its own zone, so
// a bare wall clock is a zoned event rather than an error.
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/

const formatters = new Map<string, Intl.DateTimeFormat>()

/**
 * Resolve an IANA zone name, falling back to UTC when unknown.
 *
 * A calendar can name a zone this platform's ICU data does not carry.
 * Failing the whole listing over it would let one bad calendar hide every
 * other one, so fall back and keep going.
 */
export function zone(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz)
  if (cached !== undefined) return cached
  let made: Intl.DateTimeFormat
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    made = zone(DEFAULT_TZ)
  }
  formatters.set(tz, made)
  return made
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The wall-clock reading an instant has in a zone. */
function wallParts(instant: number, tz: string): WallClock {
  const parts = zone(tz).formatToParts(new Date(instant))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0')
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Intl renders midnight as hour 24 under hour12:false in some ICU
    // versions, which would push the date a day forward.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  }
}

/** A zone's UTC offset in milliseconds at one instant. */
function zoneOffsetMs(instant: number, tz: string): number {
  const w = wallParts(instant, tz)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - instant
}

/**
 * A wall-clock reading resolved in a zone, as an absolute instant.
 *
 * Two passes because the offset itself depends on the instant: on a DST
 * boundary the first guess lands on the wrong side of the transition.
 */
function wallClockMs(naive: string, tz: string): number {
  const guess = Date.parse(`${naive}Z`)
  const once = guess - zoneOffsetMs(guess, tz)
  return guess - zoneOffsetMs(once, tz)
}

/** The instant at which a local calendar day begins. */
export function localMidnight(day: string, tz: string): number {
  return wallClockMs(`${day}T00:00:00`, tz)
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** The `YYYY-MM-DD` a day-count offset lands on, in floating date space. */
export function shiftDay(day: string, days: number): string {
  const at = Date.parse(`${day}T00:00:00Z`) + days * DAY_MS
  return new Date(at).toISOString().slice(0, 10)
}

/** The local date an instant falls on, `YYYY-MM-DD`. */
export function localDate(instant: number, tz: string): string {
  const w = wallParts(instant, tz)
  return `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}`
}

/** An instant as RFC3339 in one zone, offset included. */
function rfc3339(instant: number, tz: string): string {
  const w = wallParts(instant, tz)
  const offset = zoneOffsetMs(instant, tz) / 60_000
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  const head =
    `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}` +
    `T${pad(w.hour, 2)}:${pad(w.minute, 2)}:${pad(w.second, 2)}`
  return `${head}${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`
}

/**
 * The RFC3339 timeMin/timeMax pair covering one local day.
 *
 * Computed as consecutive local midnights rather than start + 24h: a local
 * day is 23 or 25 hours on the two DST transitions each year, and adding a
 * fixed day would drop or double an hour of events.
 */
export function dayBounds(day: string, tz: string): [string, string] {
  const start = localMidnight(day, tz)
  const next = localMidnight(shiftDay(day, 1), tz)
  return [rfc3339(start, tz), rfc3339(next, tz)]
}

/** The RFC3339 pair for the default listing window around a day. */
export function windowBounds(today: string, tz: string): [string, string] {
  const lo = shiftDay(today, -WINDOW_BACK_DAYS)
  const hi = shiftDay(today, WINDOW_AHEAD_DAYS)
  return [dayBounds(lo, tz)[0], dayBounds(hi, tz)[1]]
}

/**
 * Whether a string is a real calendar date, not merely date-shaped.
 *
 * `2026-02-30` matches the shape and is not a day; letting it through made
 * stat report a directory that every later call then failed on.
 */
export function validDay(day: string): boolean {
  if (!DATE_RE.test(day)) return false
  const at = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(at)) return false
  return new Date(at).toISOString().slice(0, 10) === day
}

/** Whether an event time slot is a floating all-day date. */
export function isAllDay(slot: Record<string, JsonValue>): boolean {
  return slot.date !== undefined && slot.dateTime === undefined
}

/**
 * Resolve one event time slot to an absolute instant.
 *
 * A dateTime with no offset is a zoned event, not an error: Google requires
 * an offset unless the slot names its own zone. Reading it in the host zone
 * would silently move the event.
 */
export function slotInstant(slot: Record<string, JsonValue>, tz: string): number | null {
  const raw = slot.dateTime
  if (typeof raw === 'string' && raw !== '') {
    if (HAS_OFFSET.test(raw)) return Date.parse(raw)
    const declared = slot.timeZone
    return wallClockMs(raw, typeof declared === 'string' && declared !== '' ? declared : tz)
  }
  const day = slot.date
  if (typeof day === 'string' && DATE_RE.test(day)) return localMidnight(day, tz)
  return null
}

/**
 * The absolute [start, end) span of an event.
 *
 * An all-day event's `end.date` is exclusive, so a one-day event is
 * `start=D, end=D+1` and its span closes at the midnight opening the next
 * day. That is the same convention the instant carries, so no adjustment is
 * applied here.
 */
export function eventSpan(
  event: Record<string, JsonValue>,
  tz: string,
): [number, number] | null {
  const startSlot = event.start
  const endSlot = event.end
  if (typeof startSlot !== 'object' || startSlot === null || Array.isArray(startSlot)) return null
  if (typeof endSlot !== 'object' || endSlot === null || Array.isArray(endSlot)) return null
  const start = slotInstant(startSlot as Record<string, JsonValue>, tz)
  if (start === null) return null
  let end = slotInstant(endSlot as Record<string, JsonValue>, tz)
  if (end === null || end < start) end = start
  return [start, end]
}

/**
 * Every local day an event's span touches.
 *
 * The end is exclusive, so an event closing exactly at local midnight does
 * not reach into the following day; a zero-length event still occupies the
 * day it starts on.
 */
export function daysCovered(span: [number, number], tz: string): string[] {
  const first = localDate(span[0], tz)
  let last = localDate(span[1], tz)
  if (span[1] > span[0] && localMidnight(last, tz) === span[1]) last = shiftDay(last, -1)
  if (last < first) last = first
  const out: string[] = []
  let cur = first
  while (cur <= last) {
    out.push(cur)
    cur = shiftDay(cur, 1)
  }
  return out
}

/**
 * The `HHMM-HHMM` label for an event as seen on one local day.
 *
 * Times are clamped to the day, so an event running through it reads
 * `0000-2400` rather than repeating times that belong to another day.
 * `2400` is how an end at the next local midnight is spelled, since `0000`
 * there would sort before the start.
 */
export function clampedHhmm(span: [number, number], day: string, tz: string): string {
  const lo = localMidnight(day, tz)
  const hi = localMidnight(shiftDay(day, 1), tz)
  const start = wallParts(Math.max(span[0], lo), tz)
  const head = `${pad(start.hour, 2)}${pad(start.minute, 2)}`
  const endAt = Math.min(span[1], hi)
  if (endAt >= hi) return `${head}-2400`
  const end = wallParts(endAt, tz)
  return `${head}-${pad(end.hour, 2)}${pad(end.minute, 2)}`
}
