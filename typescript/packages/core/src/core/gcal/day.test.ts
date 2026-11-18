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
  bucketName,
  bucketStart,
  clampedHhmm,
  dayBounds,
  daysCovered,
  eventSpan,
  localMidnight,
  parseBucket,
  slotInstant,
  validBucket,
  validDay,
  windowBounds,
  zone,
} from './day.ts'

const HK = 'Asia/Hong_Kong'
const LA = 'America/Los_Angeles'

/** An event's two slots: a `YYYY-MM-DD` pair is an all-day event. */
function event(start: string, end: string): Record<string, JsonValue> {
  const key = start.length === 10 ? 'date' : 'dateTime'
  return { start: { [key]: start }, end: { [key]: end } }
}

const CONFERENCE = event('2026-08-10T09:00:00+08:00', '2026-08-13T17:00:00+08:00')
const HOLIDAY = event('2026-08-11', '2026-08-12')
const LA_EVENING = event('2026-08-11T20:00:00-07:00', '2026-08-11T21:00:00-07:00')

function spanOf(item: Record<string, JsonValue>, tz: string): [number, number] {
  const span = eventSpan(item, tz)
  if (span === null) throw new Error('expected a parseable span')
  return span
}

describe('gcal day bucketing', () => {
  it('falls back to UTC for an unknown zone', () => {
    expect(zone('Not/AZone').resolvedOptions().timeZone).toBe('UTC')
    expect(zone(HK).resolvedOptions().timeZone).toBe(HK)
  })

  // Los Angeles leaves DST on 2026-11-01 and enters it on 2026-03-08: a
  // fixed 24h would drop or double the hour the clocks move.
  it.each([
    ['2026-08-11', HK, 1, 24],
    ['2026-11-01', LA, 1, 25],
    ['2026-03-08', LA, 1, 23],
    ['2026-10-26', LA, 7, 7 * 24 + 1],
  ])('bounds %s in %s over %i days by local midnights', (day, tz, days, hours) => {
    const [lo, hi] = dayBounds(day, tz, days)
    expect(Date.parse(lo)).toBe(localMidnight(day, tz))
    expect(Date.parse(hi) - Date.parse(lo)).toBe(hours * 3600 * 1000)
  })

  it('carries the zone offset in the day bounds', () => {
    expect(dayBounds('2026-08-11', HK)).toEqual([
      '2026-08-11T00:00:00+08:00',
      '2026-08-12T00:00:00+08:00',
    ])
  })

  it.each([
    [1, '2026-11-10T00:00:00+08:00'],
    [7, '2026-11-16T00:00:00+08:00'],
    [30, '2026-12-07T00:00:00+08:00'],
  ])('ends a %i-day window with the bucket holding the horizon', (size, hi) => {
    expect(windowBounds('2026-08-11', HK, size)).toEqual([null, hi])
  })

  it.each([
    ['2026-08-13', 1, '2026-08-13'],
    ['2026-08-10', 7, '2026-08-10'],
    ['2026-08-16', 7, '2026-08-10'],
    ['2026-08-17', 7, '2026-08-17'],
    ['2026-08-13', 30, '2026-08-09'],
    ['2026-09-07', 30, '2026-08-09'],
    ['2026-09-08', 30, '2026-09-08'],
    // Before the epoch the grid keeps its phase: still Monday to Sunday.
    ['1969-12-31', 7, '1969-12-29'],
    // The era's first bucket is cut short rather than starting before it.
    ['0001-01-02', 30, '0001-01-01'],
  ])('tiles %s into the %i-day bucket opening %s', (day, size, start) => {
    expect(bucketStart(day, size)).toBe(start)
  })

  it.each([
    ['2026-08-11', 1, '2026-08-11'],
    ['2026-08-10', 7, '2026-08-10--2026-08-16'],
    ['2026-08-09', 30, '2026-08-09--2026-09-07'],
  ])('names the bucket opening %s on a %i-day grid %s', (start, size, name) => {
    expect(bucketName(start, size)).toBe(name)
    expect(parseBucket(name, size)).toBe(start)
  })

  // One spelling per bucket and mount: a bare day on a multi-day mount, a
  // span on a one-day mount, a span off the grid or of the wrong length all
  // spell none.
  it.each([
    ['2026-08-10', 7],
    ['2026-08-10--2026-08-16', 1],
    ['2026-08-11--2026-08-17', 7],
    ['2026-08-10--2026-08-15', 7],
    ['2026-02-30', 1],
  ])('refuses %s on a %i-day grid', (name, size) => {
    expect(parseBucket(name, size)).toBeNull()
  })

  // Date-shaped is not enough: letting 2026-02-30 through made stat report a
  // directory that every later call raised on.
  it.each([
    ['2026-02-11', true],
    ['2026-08-10--2026-08-16', true],
    ['2026-02-30', false],
    ['2026-13-01', false],
    ['0000-01-01', false],
    ['2026-08-10--2026-02-30', false],
    ['2026-08-10--', false],
    ['not-a-date', false],
  ])('judges %s a bucket: %s', (name, ok) => {
    expect(validBucket(name)).toBe(ok)
    expect(validDay(name)).toBe(ok && !name.includes('--'))
  })

  it.each(['2026-08-11T01:02:03.123', '0042-08-11T01:02:03.123'])(
    'preserves the year and fractional seconds of %s in UTC',
    (dateTime) => {
      expect(slotInstant({ dateTime }, 'UTC')).toBe(Date.parse(`${dateTime}Z`))
    },
  )

  it('uses the first occurrence of an ambiguous event time', () => {
    expect(slotInstant({ dateTime: '2026-11-01T01:30:00' }, 'America/New_York')).toBe(
      Date.parse('2026-11-01T05:30:00Z'),
    )
  })

  it('retains a skipped midnight and second-resolution historical offsets', () => {
    expect(dayBounds('2018-11-04', 'America/Sao_Paulo')[0]).toBe('2018-11-04T00:00:00-03:00')
    expect(dayBounds('1900-01-01', 'Europe/Paris')[0]).toBe('1900-01-01T00:00:00+00:09:21')
  })

  it('parses offsets and Z', () => {
    expect(eventSpan(event('2026-08-11T09:00:00+08:00', '2026-08-11T02:30:00Z'), HK)).toEqual([
      Date.parse('2026-08-11T01:00:00Z'),
      Date.parse('2026-08-11T02:30:00Z'),
    ])
  })

  it('reads all-day dates in the bucketing zone', () => {
    expect(spanOf(HOLIDAY, HK)).toEqual([
      localMidnight('2026-08-11', HK),
      localMidnight('2026-08-12', HK),
    ])
  })

  it('returns null without usable slots', () => {
    expect(eventSpan({ start: {}, end: {} }, HK)).toBeNull()
    expect(eventSpan({ start: 'nope', end: {} }, HK)).toBeNull()
  })

  it.each([
    // end.date is EXCLUSIVE: start=D end=D+1 is one day, not two.
    ['a one-day all-day event', HOLIDAY, HK, ['2026-08-11']],
    [
      'a multi-day all-day event',
      event('2026-08-11', '2026-08-14'),
      HK,
      ['2026-08-11', '2026-08-12', '2026-08-13'],
    ],
    ['a timed span', CONFERENCE, HK, ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']],
    [
      'an event ending at midnight',
      event('2026-08-11T23:00:00+08:00', '2026-08-12T00:00:00+08:00'),
      HK,
      ['2026-08-11'],
    ],
    [
      'a zero-length event',
      event('2026-08-11T09:00:00+08:00', '2026-08-11T09:00:00+08:00'),
      HK,
      ['2026-08-11'],
    ],
    // 20:00 in Los Angeles on Aug 11 is 03:00Z on Aug 12: the bucketing zone
    // decides the day.
    ['an LA evening in LA', LA_EVENING, LA, ['2026-08-11']],
    ['an LA evening in UTC', LA_EVENING, 'UTC', ['2026-08-12']],
  ])('covers the days of %s', (_label, item, tz, days) => {
    expect(daysCovered(spanOf(item, tz), tz)).toEqual(days)
  })

  it.each([
    [event('2026-08-11T09:00:00+08:00', '2026-08-11T10:30:00+08:00'), '2026-08-11', '0900-1030'],
    [CONFERENCE, '2026-08-10', '0900-2400'],
    [CONFERENCE, '2026-08-11', '0000-2400'],
    [CONFERENCE, '2026-08-13', '0000-1700'],
    [HOLIDAY, '2026-08-11', '0000-2400'],
  ])('clamps local times to %s on %s as %s', (item, day, hhmm) => {
    expect(clampedHhmm(spanOf(item, HK), day, HK)).toBe(hhmm)
  })

  // Google requires an offset on dateTime UNLESS the slot names its own
  // zone; without one either, the bucket zone is the answer.
  it.each([
    [{ dateTime: '2026-08-11T09:00:00', timeZone: HK }, 'UTC'],
    [{ dateTime: '2026-08-11T09:00:00' }, HK],
  ])('reads a zone-less dateTime %j in a zone', (slot, tz) => {
    expect(slotInstant(slot, tz)).toBe(Date.parse('2026-08-11T01:00:00Z'))
  })
})

it.each([
  { date: '2026-02-30' },
  { dateTime: 'unreadable' },
  { dateTime: '2026-02-30T03:02:01Z' },
  { dateTime: '2026-04-01T24:00:00' },
])('skips an invalid event slot %o', (slot) => {
  expect(slotInstant(slot, 'UTC')).toBeNull()
})
