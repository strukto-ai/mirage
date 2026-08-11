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

import { describe, expect, it } from 'vitest'
import type { JsonValue } from '../../types.ts'
import {
  clampedHhmm,
  dayBounds,
  daysCovered,
  eventSpan,
  isAllDay,
  localMidnight,
  slotInstant,
  validDay,
  windowBounds,
  zone,
} from './day.ts'

const HK = 'Asia/Hong_Kong'
const LA = 'America/Los_Angeles'

function timed(start: string, end: string): Record<string, JsonValue> {
  return { start: { dateTime: start }, end: { dateTime: end } }
}

function allDay(start: string, end: string): Record<string, JsonValue> {
  return { start: { date: start }, end: { date: end } }
}

describe('gcal day bucketing', () => {
  it('falls back to UTC for an unknown zone', () => {
    expect(zone('Not/AZone').resolvedOptions().timeZone).toBe('UTC')
    expect(zone(HK).resolvedOptions().timeZone).toBe(HK)
  })

  it('builds day bounds from consecutive local midnights', () => {
    expect(dayBounds('2026-08-11', HK)).toEqual([
      '2026-08-11T00:00:00+08:00',
      '2026-08-12T00:00:00+08:00',
    ])
  })

  it('spans 25 hours on a DST fall back', () => {
    // America/Los_Angeles leaves DST on 2026-11-01, making that local day
    // 25 hours. Adding a fixed 24h would drop the repeated hour's events.
    const [lo, hi] = dayBounds('2026-11-01', LA)
    expect(Date.parse(hi) - Date.parse(lo)).toBe(25 * 3600 * 1000)
  })

  it('spans 23 hours on a DST spring forward', () => {
    const [lo, hi] = dayBounds('2026-03-08', LA)
    expect(Date.parse(hi) - Date.parse(lo)).toBe(23 * 3600 * 1000)
  })

  it('brackets the day with the default window', () => {
    expect(windowBounds('2026-08-11', HK)).toEqual([
      '2026-07-12T00:00:00+08:00',
      '2026-11-10T00:00:00+08:00',
    ])
  })

  it('reads the slot shape for all-day', () => {
    expect(isAllDay({ date: '2026-08-11' })).toBe(true)
    expect(isAllDay({ dateTime: '2026-08-11T09:00:00+08:00' })).toBe(false)
  })

  it('parses offsets and Z', () => {
    const span = eventSpan(timed('2026-08-11T09:00:00+08:00', '2026-08-11T02:30:00Z'), HK)
    expect(span).not.toBeNull()
    expect(span?.[0]).toBe(Date.parse('2026-08-11T01:00:00Z'))
    expect(span?.[1]).toBe(Date.parse('2026-08-11T02:30:00Z'))
  })

  it('attaches the declared zone to a zone-less dateTime', () => {
    // Google requires an offset UNLESS the slot names its own zone, so a
    // bare wall clock is a zoned event, not an error. Reading it in the
    // host zone would silently move the event.
    const at = slotInstant({ dateTime: '2026-08-11T09:00:00', timeZone: HK }, 'UTC')
    expect(at).toBe(Date.parse('2026-08-11T01:00:00Z'))
  })

  it('reads all-day dates in the bucketing zone', () => {
    const span = eventSpan(allDay('2026-08-11', '2026-08-12'), HK)
    expect(span?.[0]).toBe(localMidnight('2026-08-11', HK))
    expect(span?.[1]).toBe(localMidnight('2026-08-12', HK))
  })

  it('returns null without usable slots', () => {
    expect(eventSpan({ start: {}, end: {} }, HK)).toBeNull()
    expect(eventSpan({ start: 'nope', end: {} }, HK)).toBeNull()
  })

  it('covers one day only for a single-day all-day event', () => {
    // end.date is EXCLUSIVE, so start=D end=D+1 is a one-day event and must
    // not leak into D+1's directory.
    const span = eventSpan(allDay('2026-08-11', '2026-08-12'), HK)
    expect(daysCovered(span as [number, number], HK)).toEqual(['2026-08-11'])
  })

  it('covers each day of a multi-day all-day event', () => {
    const span = eventSpan(allDay('2026-08-11', '2026-08-14'), HK)
    expect(daysCovered(span as [number, number], HK)).toEqual([
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
    ])
  })

  it('covers every day a timed event spans', () => {
    const span = eventSpan(timed('2026-08-10T09:00:00+08:00', '2026-08-13T17:00:00+08:00'), HK)
    expect(daysCovered(span as [number, number], HK)).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
    ])
  })

  it('stops at the starting day when it ends exactly at midnight', () => {
    const span = eventSpan(timed('2026-08-11T23:00:00+08:00', '2026-08-12T00:00:00+08:00'), HK)
    expect(daysCovered(span as [number, number], HK)).toEqual(['2026-08-11'])
  })

  it('still occupies a day for a zero-length event', () => {
    const span = eventSpan(timed('2026-08-11T09:00:00+08:00', '2026-08-11T09:00:00+08:00'), HK)
    expect(daysCovered(span as [number, number], HK)).toEqual(['2026-08-11'])
  })

  it('lets the bucketing zone decide the day', () => {
    // 20:00 in Los Angeles on Aug 11 is 03:00Z on Aug 12: bucketed in the
    // calendar's zone it is Aug 11, in UTC it would be Aug 12.
    const span = eventSpan(timed('2026-08-11T20:00:00-07:00', '2026-08-11T21:00:00-07:00'), LA)
    expect(daysCovered(span as [number, number], LA)).toEqual(['2026-08-11'])
    expect(daysCovered(span as [number, number], 'UTC')).toEqual(['2026-08-12'])
  })

  it('reports local times in the HHMM label', () => {
    const span = eventSpan(timed('2026-08-11T09:00:00+08:00', '2026-08-11T10:30:00+08:00'), HK)
    expect(clampedHhmm(span as [number, number], '2026-08-11', HK)).toBe('0900-1030')
  })

  it('clamps a spanning event to the whole day', () => {
    const span = eventSpan(timed('2026-08-10T09:00:00+08:00', '2026-08-13T17:00:00+08:00'), HK)
    expect(clampedHhmm(span as [number, number], '2026-08-10', HK)).toBe('0900-2400')
    expect(clampedHhmm(span as [number, number], '2026-08-11', HK)).toBe('0000-2400')
    expect(clampedHhmm(span as [number, number], '2026-08-13', HK)).toBe('0000-1700')
  })

  it('spells an all-day event as the full day', () => {
    const span = eventSpan(allDay('2026-08-11', '2026-08-12'), HK)
    expect(clampedHhmm(span as [number, number], '2026-08-11', HK)).toBe('0000-2400')
  })

  it('rejects a date-shaped non-date', () => {
    // Regex-shaped but impossible: letting it through made stat report a
    // directory that every later call then failed on.
    expect(validDay('2026-02-30')).toBe(false)
    expect(validDay('2026-13-01')).toBe(false)
    expect(validDay('not-a-date')).toBe(false)
    expect(validDay('2026-02-28')).toBe(true)
  })
})
