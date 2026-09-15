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
import { strftime } from '../commands/builtin/utils/strftime.ts'
import {
  LOCAL_ZONE,
  UTC_ZONE,
  numericAbbreviation,
  posixZone,
  resolveTz,
  transitionAt,
  tzAbbreviation,
  zoneFromEnv,
} from './timezone.ts'
import { TZ_ABBREVS } from './tz_abbrevs.ts'

// Pinned against GNU date 9.7 (glibc 2.41) on debian:stable-slim with tzdata
// installed: `TZ=<spec> date -d @<epoch> '+%Y-%m-%d %H:%M:%S %z %Z'`. %Z is
// tzdata's abbreviation, read from the generated table.
const EPOCH = 0
const SUMMER = 1751328000
const WINTER = 1735689600
const JULY_2024 = 1720000000
const NOVEMBER_2023 = 1700000000

function render(spec: string, epoch: number, fmt = '%Y-%m-%d %H:%M:%S %z %Z'): string {
  return strftime(new Date(epoch * 1000), fmt, resolveTz(spec))
}

describe('resolveTz: tzdata names', () => {
  it.each([
    ['UTC', EPOCH, '1970-01-01 00:00:00 +0000 UTC'],
    ['Asia/Hong_Kong', EPOCH, '1970-01-01 08:00:00 +0800 HKT'],
    ['America/Los_Angeles', EPOCH, '1969-12-31 16:00:00 -0800 PST'],
    ['America/Los_Angeles', SUMMER, '2025-06-30 17:00:00 -0700 PDT'],
    [':Asia/Tokyo', EPOCH, '1970-01-01 09:00:00 +0900 JST'],
    ['Asia/Kolkata', EPOCH, '1970-01-01 05:30:00 +0530 IST'],
    ['Etc/GMT+5', EPOCH, '1969-12-31 19:00:00 -0500 -05'],
    ['EST5EDT', SUMMER, '2025-06-30 20:00:00 -0400 EDT'],
    ['EST5EDT', WINTER, '2024-12-31 19:00:00 -0500 EST'],
    ['Europe/London', EPOCH, '1970-01-01 01:00:00 +0100 BST'],
    ['Europe/London', WINTER, '2025-01-01 00:00:00 +0000 GMT'],
    ['Australia/Sydney', SUMMER, '2025-07-01 10:00:00 +1000 AEST'],
    ['Australia/Sydney', WINTER, '2025-01-01 11:00:00 +1100 AEDT'],
    ['Asia/Singapore', EPOCH, '1970-01-01 07:30:00 +0730 +0730'],
    ['Asia/Singapore', SUMMER, '2025-07-01 08:00:00 +0800 +08'],
    ['America/Sao_Paulo', EPOCH, '1969-12-31 21:00:00 -0300 -03'],
    // A zone's own history: one offset under two names over the years.
    ['Europe/Moscow', 1276848800, '2010-06-18 12:13:20 +0400 MSD'],
    ['Europe/Moscow', 1340000000, '2012-06-18 10:13:20 +0400 MSK'],
    ['Europe/Moscow', 1301180399, '2011-03-27 01:59:59 +0300 MSK'],
    ['Europe/Moscow', 1301180400, '2011-03-27 03:00:00 +0400 MSK'],
    ['Europe/Moscow', 677232000, '1991-06-18 11:00:00 +0300 EEST'],
    ['Europe/Moscow', 690451200, '1991-11-18 10:00:00 +0200 EET'],
    ['Europe/Istanbul', 1435752000, '2015-07-01 15:00:00 +0300 EEST'],
    ['Europe/Istanbul', 1498906800, '2017-07-01 14:00:00 +0300 +03'],
    ['Europe/Kaliningrad', 1275393600, '2010-06-01 15:00:00 +0300 EEST'],
    ['Europe/Kaliningrad', 1338552000, '2012-06-01 15:00:00 +0300 +03'],
    ['Europe/Kaliningrad', 1433160000, '2015-06-01 14:00:00 +0200 EET'],
  ])('%s at @%d', (spec, epoch, expected) => {
    expect(render(spec, epoch)).toBe(expected)
  })
})

describe('resolveTz: POSIX strings', () => {
  it.each([
    ['UTC0', EPOCH, '1970-01-01 00:00:00 +0000 UTC'],
    ['EST5', EPOCH, '1969-12-31 19:00:00 -0500 EST'],
    ['JST-9', EPOCH, '1970-01-01 09:00:00 +0900 JST'],
    ['<+0530>-5:30', EPOCH, '1970-01-01 05:30:00 +0530 +0530'],
    ['<+0530>-5:30:30', EPOCH, '1970-01-01 05:30:30 +0530 +0530'],
    ['CET-1CEST,M3.5.0,M10.5.0/3', EPOCH, '1970-01-01 01:00:00 +0100 CET'],
    ['CET-1CEST,M3.5.0,M10.5.0/3', SUMMER, '2025-07-01 02:00:00 +0200 CEST'],
    ['CET-1CEST,M3.5.0,M10.5.0/3', WINTER, '2025-01-01 01:00:00 +0100 CET'],
    ['CET-1CEST,M03.05.00,M10.5.0', SUMMER, '2025-07-01 02:00:00 +0200 CEST'],
    ['CET-1CEST,J60,J300/1', SUMMER, '2025-07-01 02:00:00 +0200 CEST'],
    ['CET-1CEST,59,299', SUMMER, '2025-07-01 02:00:00 +0200 CEST'],
    ['EST5EDT,M3.2.0,M11.1.0', SUMMER, '2025-06-30 20:00:00 -0400 EDT'],
    ['AEST-10AEDT,M10.1.0,M4.1.0/3', EPOCH, '1970-01-01 11:00:00 +1100 AEDT'],
    ['AEST-10AEDT,M10.1.0,M4.1.0/3', SUMMER, '2025-07-01 10:00:00 +1000 AEST'],
    ['AEST-10AEDT,M10.1.0,M4.1.0/3', WINTER, '2025-01-01 11:00:00 +1100 AEDT'],
    ['XXX3YYY', EPOCH, '1969-12-31 21:00:00 -0300 XXX'],
    ['XXX3YYY', SUMMER, '2025-06-30 22:00:00 -0200 YYY'],
    // Coinciding offsets still name their halves by the rules.
    ['CET-1CEST-1,J1,J1', JULY_2024, '2024-07-03 10:46:40 +0100 CET'],
  ])('%s at @%d', (spec, epoch, expected) => {
    expect(render(spec, epoch)).toBe(expected)
  })
})

describe('resolveTz: glibc fallbacks', () => {
  // glibc reads an unknown name as a POSIX string with no offset, so it
  // renders UTC under that name; a name under three letters is refused
  // and leaves %Z empty; an empty TZ is UTC (glibc spells that one
  // `Universal`, the one abbreviation here that differs).
  it.each([
    ['Bogus/Zone', '1970-01-01 00:00:00 +0000 Bogus'],
    ['XYZ', '1970-01-01 00:00:00 +0000 XYZ'],
    ['Z', '1970-01-01 00:00:00 +0000 '],
    ['', '1970-01-01 00:00:00 +0000 UTC'],
  ])('%s', (spec, expected) => {
    expect(render(spec, EPOCH)).toBe(expected)
  })
})

describe('zoneFromEnv', () => {
  it('reads only the command environment', () => {
    expect(zoneFromEnv(null)).toBeNull()
    expect(zoneFromEnv(undefined)).toBeNull()
    expect(zoneFromEnv({})).toBeNull()
    expect(zoneFromEnv({ TZ: 'UTC' })?.parts(new Date(0)).abbrev).toBe('UTC')
    expect(zoneFromEnv({ TZ: 'Asia/Hong_Kong' })?.parts(new Date(0)).hour).toBe(8)
  })
})

describe('Zone.fromWall', () => {
  const cet = resolveTz('CET-1CEST,M3.5.0,M10.5.0/3')
  const berlin = resolveTz('Europe/Berlin')
  const newYork = resolveTz('America/New_York')
  const wall = { year: 2025, month: 9, day: 26, hour: 2, minute: 30, second: 0, ms: 0 }
  const gap = { year: 2025, month: 2, day: 30, hour: 2, minute: 30, second: 0, ms: 0 }
  const newYorkGap = { year: 2025, month: 2, day: 9, hour: 2, minute: 30, second: 0, ms: 0 }

  it('resolves a repeated hour to standard time, as glibc mktime does', () => {
    // 02:30 on the night CEST ends is the later instant, 02:30 CET.
    expect(cet.fromWall(wall).getTime() / 1000).toBe(1761442200)
    expect(berlin.fromWall(wall).getTime() / 1000).toBe(1761442200)
  })

  it('resolves a repeated hour to the reading under the preferred offset', () => {
    // gnulib hands mktime the base's tm_isdst: a summer base keeps 02:30
    // CEST, a winter one 02:30 CET, and an offset neither reading has
    // falls back to the later one.
    for (const zone of [cet, berlin]) {
      expect(zone.fromWall(wall, 7200).getTime() / 1000).toBe(1761438600)
      expect(zone.fromWall(wall, 3600).getTime() / 1000).toBe(1761442200)
      expect(zone.fromWall(wall, 10800).getTime() / 1000).toBe(1761442200)
    }
  })

  it('reads a skipped hour under the offset in force before the change', () => {
    // No instant shows 02:30 the night CEST or EDT starts; the reading
    // lands an hour on, which is how a caller tells it was skipped, on
    // either side of UTC and whichever offset the caller prefers.
    expect(cet.parts(cet.fromWall(gap)).hour).toBe(3)
    expect(berlin.parts(berlin.fromWall(gap)).hour).toBe(3)
    expect(berlin.fromWall(gap, 7200).getTime() / 1000).toBe(1743298200)
    expect(newYork.parts(newYork.fromWall(newYorkGap)).hour).toBe(3)
    expect(newYork.fromWall(newYorkGap).getTime() / 1000).toBe(1741505400)
  })

  it('round-trips an ordinary wall clock in every zone shape', () => {
    const p = { year: 2026, month: 8, day: 3, hour: 5, minute: 7, second: 9, ms: 0 }
    for (const zone of [
      UTC_ZONE,
      LOCAL_ZONE,
      cet,
      berlin,
      resolveTz('JST-9'),
      resolveTz('Bogus'),
    ]) {
      const shown = zone.parts(zone.fromWall(p))
      expect([shown.year, shown.month, shown.day, shown.hour, shown.minute, shown.second]).toEqual([
        2026, 8, 3, 5, 7, 9,
      ])
    }
  })

  it('carries an overflowing day into the next month', () => {
    const p = { year: 2026, month: 0, day: 32, hour: 0, minute: 0, second: 0, ms: 0 }
    expect(UTC_ZONE.parts(UTC_ZONE.fromWall(p)).month).toBe(1)
    expect(berlin.parts(berlin.fromWall(p)).month).toBe(1)
  })
})

describe('transitionAt', () => {
  const at = (rule: Parameters<typeof transitionAt>[0], year: number): string =>
    new Date(transitionAt(rule, year)).toISOString()
  const base = { month: 0, week: 0, weekday: 0, day: 0, seconds: 7200 }

  it('places M, J and bare-day rules', () => {
    expect(at({ ...base, kind: 'M', month: 3, week: 5, weekday: 0 }, 2025)).toBe(
      '2025-03-30T02:00:00.000Z',
    )
    expect(at({ ...base, kind: 'M', month: 11, week: 1, weekday: 0 }, 2025)).toBe(
      '2025-11-02T02:00:00.000Z',
    )
    // J60 is March 1 whatever the year: February 29 is never counted.
    expect(at({ ...base, kind: 'J', day: 60 }, 2024)).toBe('2024-03-01T02:00:00.000Z')
    expect(at({ ...base, kind: 'J', day: 60 }, 2025)).toBe('2025-03-01T02:00:00.000Z')
    // A bare day is zero-based and counts February 29.
    expect(at({ ...base, kind: 'D', day: 59 }, 2024)).toBe('2024-02-29T02:00:00.000Z')
    expect(at({ ...base, kind: 'D', day: 59 }, 2025)).toBe('2025-03-01T02:00:00.000Z')
    expect(at({ ...base, kind: 'M', month: 10, week: 5, weekday: 0, seconds: 10800 }, 2025)).toBe(
      '2025-10-26T03:00:00.000Z',
    )
  })

  it('counts refused fields as glibc does', () => {
    // Week 0 is the first such weekday; a weekday past 6 counts on from the
    // month's first day, so 7 is the second Sunday of a month that starts
    // on one (September 2024) and the first of any other; Julian day 0 is
    // the day before January 1. All are states glibc leaves behind.
    expect(at({ ...base, kind: 'M', month: 3, week: 0, weekday: 0, seconds: 0 }, 2024)).toBe(
      '2024-03-03T00:00:00.000Z',
    )
    expect(at({ ...base, kind: 'M', month: 3, week: 5, weekday: 7, seconds: 0 }, 2024)).toBe(
      '2024-03-31T00:00:00.000Z',
    )
    expect(at({ ...base, kind: 'M', month: 9, week: 1, weekday: 7, seconds: 0 }, 2024)).toBe(
      '2024-09-08T00:00:00.000Z',
    )
    expect(at({ ...base, kind: 'M', month: 3, week: 1, weekday: 7, seconds: 0 }, 2024)).toBe(
      '2024-03-03T00:00:00.000Z',
    )
    expect(at({ ...base, kind: 'J', day: 0, seconds: 0 }, 2024)).toBe('2023-12-31T00:00:00.000Z')
  })
})

describe('posixZone', () => {
  it('applies the US rule when a DST name comes without one', () => {
    for (const spec of ['XXX3YYY', 'XXX3YYY,', 'XXX3YYY,M3.2.0']) {
      const zone = posixZone(spec)
      expect(zone.parts(new Date(SUMMER * 1000)).abbrev).toBe('YYY')
      expect(zone.parts(new Date(WINTER * 1000)).abbrev).toBe('XXX')
    }
  })

  // glibc keeps what it had read of a rule it refuses, never reads the rule
  // after it, and keeps a daylight half whose name it cannot read as
  // nameless UTC; nothing falls back to plain UTC. Every line is GNU's.
  it.each([
    ['CET-1CEST,bogus', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,bogus', WINTER, '+0200 CEST'],
    ['CET-1CEST,M3.5.0,M13.1.0', NOVEMBER_2023, '+0200 CEST'],
    ['CET-1CEST,M3.5.0,M13.1.0', WINTER, '+0100 CET'],
    ['CET-1CEST,M3.6.0,M10.5.0', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,M3.6.0,M10.5.0', WINTER, '+0100 CET'],
    ['CET-1CEST,M3.0.0,M10.5.0', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,M3.5.7,M10.5.0', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,J0,J300', JULY_2024, '+0100 CET'],
    ['CET-1CEST,J0,J300', WINTER, '+0100 CET'],
    ['CET-1CEST,J366,J300', JULY_2024, '+0100 CET'],
    ['CET-1CEST,J1,J366', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,0,366', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,366,100', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,366,100', WINTER, '+0200 CEST'],
    ['CET-1CEST,M3.5.0', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,M3.5.0', NOVEMBER_2023, '+0100 CET'],
    ['CET-1CEST,', JULY_2024, '+0200 CEST'],
    ['CET-1CEST', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,M3.5.0,M10.5.0/3x', NOVEMBER_2023, '+0100 CET'],
    ['CET-1CEST,M3.5.0/x,M10.5.0', NOVEMBER_2023, '+0200 CEST'],
    ['CET-1CEST,M3.5.0,M10.5.0/25', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,M3.5.0/-1,M10.5.0', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,M3.5.0x,M10.5.0', JULY_2024, '+0200 CEST'],
    ['CET-1CEST,M3.5.0/,M10.5.0', JULY_2024, '+0200 CEST'],
    ['CET-1CEST-1,M3.5.0,M10.5.0', JULY_2024, '+0100 CEST'],
    ['CET-1CEST-1,M3.5.0,M10.5.0', NOVEMBER_2023, '+0100 CET'],
    ['CET-1CESTM3.5.0,M10.5.0', JULY_2024, '+0100 CET'],
    ['EST5x', NOVEMBER_2023, '+0000 '],
    ['EST5x', JULY_2024, '+0000 '],
    ['EST5,M3.2.0,M11.1.0', JULY_2024, '+0000 '],
    ['EST5,M3.2.0,M11.1.0', WINTER, '-0500 EST'],
  ])('keeps what glibc read of %s at @%d: %s', (spec, epoch, expected) => {
    expect(render(spec, epoch, '%z %Z')).toBe(expected)
  })

  // glibc reads past its month table for a month outside 1 to 12; mirage
  // reads the refused rule as Julian day 0 instead, which is what Debian's
  // glibc happens to print for these too.
  it.each([
    ['CET-1CEST,M13.1.0,M1.1.0', NOVEMBER_2023, '+0100 CET'],
    ['CET-1CEST,M13.1.0,M1.1.0', JULY_2024, '+0100 CET'],
    ['CET-1CEST,M0.5.0,M10.5.0', JULY_2024, '+0100 CET'],
  ])('reads a month outside the table as the refused Julian rule: %s', (spec, epoch, expected) => {
    expect(render(spec, epoch, '%z %Z')).toBe(expected)
  })

  it.each([
    ['UTC5:99', '1969-12-31 18:01:00 -0559 UTC'],
    ['UTC5:30:99', '1969-12-31 18:29:01 -0530 UTC'],
    ['UTC5:9', '1969-12-31 18:51:00 -0509 UTC'],
    ['UTC23:59:59', '1969-12-31 00:00:01 -2359 UTC'],
  ])('clamps the fields of %s as glibc does', (spec, expected) => {
    expect(render(spec, EPOCH)).toBe(expected)
  })

  // glibc clamps the hours at 24 and prints `-2400` for all of these; a
  // Python tzinfo cannot carry a full day, so both hosts stop a second
  // short of it, the one documented divergence.
  it.each([
    ['UTC24', '1969-12-31 00:00:01 -2359 UTC'],
    ['UTC25', '1969-12-31 00:00:01 -2359 UTC'],
    ['UTC1234', '1969-12-31 00:00:01 -2359 UTC'],
    ['UTC-24', '1970-01-01 23:59:59 +2359 UTC'],
  ])('stops a full-day offset one second short: %s', (spec, expected) => {
    expect(render(spec, EPOCH)).toBe(expected)
  })
})

describe('tzAbbreviation: the table the generator wrote from zoneinfo', () => {
  it.each([
    [0, '+00'],
    [28800, '+08'],
    [-10800, '-03'],
    [19800, '+0530'],
    [31500, '+0845'],
    [-34200, '-0930'],
  ])('spells %d as %s', (offset, expected) => {
    expect(numericAbbreviation(offset)).toBe(expected)
  })

  it('reads a lettered name by offset and instant and spells out the rest', () => {
    expect(tzAbbreviation('Asia/Hong_Kong', 28800, EPOCH)).toBe('HKT')
    expect(tzAbbreviation('Asia/Hong_Kong', 32400, 9315000)).toBe('HKST')
    expect(tzAbbreviation('Europe/London', 0, WINTER)).toBe('GMT')
    expect(tzAbbreviation('Europe/London', 3600, SUMMER)).toBe('BST')
    expect(tzAbbreviation('Asia/Singapore', 28800, SUMMER)).toBe('+08')
    expect(tzAbbreviation('Nowhere/Zone', -10800, EPOCH)).toBe('-03')
  })

  it('has no row for a zone tzdata names by its offset', () => {
    expect(TZ_ABBREVS['Asia/Singapore']).toBeUndefined()
    expect(TZ_ABBREVS['America/Sao_Paulo']).toBeUndefined()
    expect(TZ_ABBREVS['Etc/GMT+5']).toBeUndefined()
  })

  it('dates every name an offset carried', () => {
    // Moscow's +04 was MSD in the summers before 2011 and MSK from
    // 2011-03-27 02:00 (epoch 1301180400); Istanbul's +03 was EEST in the
    // summers before 2016 and +03 since; before the table's 1970 start the
    // earliest name stands in.
    expect(TZ_ABBREVS['Europe/Moscow']).toEqual([
      [10800, 'MSK', 0],
      [14400, 'MSD', 354920400],
      [10800, 'EEST', 670374000],
      [7200, 'EET', 686102400],
      [10800, 'MSK', 695779200],
      [14400, 'MSK', 1301180400],
    ])
    expect(tzAbbreviation('Europe/Moscow', 14400, 1276848800)).toBe('MSD')
    expect(tzAbbreviation('Europe/Moscow', 14400, 1301180400)).toBe('MSK')
    expect(tzAbbreviation('Europe/Moscow', 14400, -1)).toBe('MSD')
    expect(tzAbbreviation('Europe/Istanbul', 10800, 1435752000)).toBe('EEST')
    expect(tzAbbreviation('Europe/Istanbul', 10800, 1498906800)).toBe('+03')
  })
})
