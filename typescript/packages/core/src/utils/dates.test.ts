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
import {
  epochToIso,
  inMtimeWindow,
  isoToEpoch,
  msToRfc3339,
  parseDateExpr,
  parseDateExprAsync,
  parsePosixTimeAsync,
  rfc3339Of,
  toIsoZ,
  utcDateFolder,
} from './dates.ts'
import { UTC_ZONE, resolveTz } from './timezone.ts'

describe('inMtimeWindow', () => {
  it('keeps everything under an unbounded window', () => {
    expect(inMtimeWindow(100, null, null)).toBe(true)
    expect(inMtimeWindow(null, undefined, undefined)).toBe(true)
  })
  it('applies inclusive bounds', () => {
    expect(inMtimeWindow(100, 100, null)).toBe(true)
    expect(inMtimeWindow(99, 100, null)).toBe(false)
    expect(inMtimeWindow(100, null, 100)).toBe(true)
    expect(inMtimeWindow(101, null, 100)).toBe(false)
  })
  it('fails an unknown timestamp against any bound', () => {
    expect(inMtimeWindow(null, 100, null)).toBe(false)
    expect(inMtimeWindow(undefined, null, 100)).toBe(false)
  })
})

describe('epochToIso', () => {
  it('formats whole seconds as second-precision ISO-Z', () => {
    expect(epochToIso(1609459200)).toBe('2021-01-01T00:00:00Z')
  })
  it('truncates sub-second input (parity with the Python converter)', () => {
    expect(epochToIso(1609459200.987)).toBe('2021-01-01T00:00:00Z')
  })
})

describe('isoToEpoch', () => {
  it('inverts epochToIso for a Z stamp', () => {
    expect(isoToEpoch('2021-01-01T00:00:00Z')).toBe(1609459200)
    expect(isoToEpoch('2026-01-02T15:30:45Z')).toBe(1767367845)
  })
  it('reads an offset-less (naive) stamp as UTC, not local', () => {
    expect(isoToEpoch('2026-01-02T15:30:45')).toBe(1767367845)
  })
  it('honors an explicit offset and truncates sub-seconds', () => {
    expect(isoToEpoch('2021-01-01T01:00:00+01:00')).toBe(1609459200)
    expect(isoToEpoch('2026-07-22T06:57:48.064802Z')).toBe(1784703468)
  })
  it('floors a negative fractional epoch (parity with Python)', () => {
    expect(isoToEpoch('1969-12-31T23:59:59.500Z')).toBe(-1)
    expect(epochToIso(-0.5)).toBe('1969-12-31T23:59:59Z')
  })
})

describe('utcDateFolder', () => {
  it('returns YYYY-MM-DD for a timestamp', () => {
    expect(utcDateFolder(1609459200000)).toBe('2021-01-01')
  })
})

describe('parseDateExpr', () => {
  const NOW = new Date(Date.UTC(2026, 7, 16, 13, 45, 30))

  it('parses relative displacements', () => {
    expect(parseDateExpr('24 hours ago', UTC_ZONE, NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 15, 13, 45, 30)),
    )
    expect(parseDateExpr('3 days', UTC_ZONE, NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 19, 13, 45, 30)),
    )
    expect(parseDateExpr('-2 weeks', UTC_ZONE, NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 2, 13, 45, 30)),
    )
    expect(parseDateExpr('2days', UTC_ZONE, NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 18, 13, 45, 30)),
    )
  })

  it('parses word displacements', () => {
    expect(parseDateExpr('yesterday', UTC_ZONE, NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 15, 13, 45, 30)),
    )
    expect(parseDateExpr('tomorrow', UTC_ZONE, NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 17, 13, 45, 30)),
    )
    expect(parseDateExpr('now', UTC_ZONE, NOW)).toEqual(NOW)
    expect(parseDateExpr('last year', UTC_ZONE, NOW)).toEqual(
      new Date(Date.UTC(2025, 7, 16, 13, 45, 30)),
    )
    expect(parseDateExpr('next month', UTC_ZONE, NOW)).toEqual(
      new Date(Date.UTC(2026, 8, 16, 13, 45, 30)),
    )
  })

  it('normalizes month overflow through the calendar like GNU', () => {
    expect(parseDateExpr('2026-01-31 1 month', UTC_ZONE, NOW)).toEqual(
      new Date(Date.UTC(2026, 2, 3)),
    )
  })

  it('parses an ISO base with a relative tail', () => {
    expect(parseDateExpr('2026-08-16 12:00:00 24 hours ago', UTC_ZONE, NOW)).toEqual(
      new Date(Date.UTC(2026, 7, 15, 12, 0, 0)),
    )
  })

  it('parses @epoch and zone offsets', () => {
    expect(parseDateExpr('@1755300000', UTC_ZONE)).toEqual(new Date(1755300000 * 1000))
    expect(parseDateExpr('2026-08-16T10:00:00+02:00', UTC_ZONE)).toEqual(
      new Date(Date.UTC(2026, 7, 16, 8, 0, 0)),
    )
  })

  // A zone correction reaches 24 hours either way, a minute field past 59
  // included; GNU refuses `+99:99` and `+24:01`.
  it.each<[string, number | null]>([
    ['+23:59', 1767139260],
    ['+24:00', 1767139200],
    ['+23:60', 1767139200],
    ['-24:00', 1767312000],
    ['+2400', 1767139200],
    ['+99:99', null],
    ['+24:01', null],
  ])('reads the zone %s as GNU does', (zone, epoch) => {
    const parsed = parseDateExpr(`2026-01-01T00:00${zone}`, UTC_ZONE)
    expect(parsed === null ? null : parsed.getTime() / 1000).toBe(epoch)
  })

  it('truncates fractional seconds instead of rounding into the next second', () => {
    expect(parseDateExpr('2026-01-01T00:00:00.9999Z', UTC_ZONE)).toEqual(
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 999)),
    )
    expect(parseDateExpr('2026-01-01T00:00:00.5Z', UTC_ZONE)).toEqual(
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 500)),
    )
  })

  it('returns null for anything it cannot parse', () => {
    expect(parseDateExpr('not a date', UTC_ZONE, NOW)).toBeNull()
    expect(parseDateExpr('24 hours agoo', UTC_ZONE, NOW)).toBeNull()
    expect(parseDateExpr('@abc', UTC_ZONE, NOW)).toBeNull()
  })

  it('reads an empty expression as midnight today', () => {
    const midnight = new Date(Date.UTC(2026, 7, 16))
    expect(parseDateExpr('', UTC_ZONE, NOW)).toEqual(midnight)
    expect(parseDateExpr('   ', UTC_ZONE, NOW)).toEqual(midnight)
  })
})

// The date grammar as coreutils 9.7 reads it, measured on
// debian:stable-slim with the clock at 2026-10-06 09:32:40 UTC (faketime) and
// the zone in TZ: null is GNU's `invalid date`. Mirrors test_gnu_grammar in
// test_dates.py.
describe('parseDateExpr grammar', () => {
  const GNU_NOW = new Date(1791279160 * 1000)
  it.each<[string, string, number | null]>([
    ['Europe/Berlin', '2026-10-06 GMT', 1791244800],
    ['UTC', '2026-10-06 09:32:40,5 +0100', 1791275560.5],
    ['UTC', '2026-10-06 09:32 HKT', null],
    ['UTC', '2026-10-06 09:32 EST DST', 1791293520],
    ['UTC', '2026-10-06 09:00 UTC-1:30', 1791282600],
    ['UTC', '2026-10-06 09:00 A', 1791273600],
    ['UTC', '2026-10-06 09:00 T', 1791302400],
    ['UTC', '2026-10-06 09:00 U.T.C.', 1791277200],
    ['Europe/Berlin', '2026-10-06 9 a.m.', 1791270000],
    ['UTC', '2026-10-06 9:30:15 PM', 1791322215],
    ['UTC', 'JUN-17-1992', 708739200],
    ['UTC', '10/06/69', -7516800],
    ['UTC', 'monday', 1791763200],
    ['UTC', 'next tuesday', 1791849600],
    ['UTC', 'last tuesday', 1790640000],
    ['UTC', 'third friday', 1792713600],
    ['UTC', 'Wed,', 1791331200],
    ['UTC', '3 days ago 10:00', 1791021600],
    ['UTC', '1 year 2 months 3 days ago', 1827826360],
    ['Europe/Berlin', '2 fortnights', 1793698360],
    ['UTC', '2026-01-31 +1 month -1 day', 1772409600],
    ['UTC', '20261006 0930', 1791279000],
    ['UTC', '20261006 +2 days', 1791417600],
    ['UTC', '2026', 1791318360],
    ['UTC', '12345', null],
    ['UTC', '10:00 -5 days', 1791385200],
    ['UTC', '2026-10-06T0930', null],
    ['UTC', '2026-10-06 T', null],
    ['UTC', '2026-10-06 23:59:60', null],
    ['UTC', 'noon', null],
    ['UTC', 'monday tuesday', null],
    ['UTC', '2026-10-06 10:00 UTC UTC', null],
    ['UTC', '2026-10-06 (comment) 10:00', 1791280800],
    ['Europe/Berlin', '2025-03-30 02:30', null],
    ['Europe/Berlin', '2025-10-26 02:30', 1761438600],
    ['UTC', '1969-12-31 23:00:00 -0100', 0],
    ['Europe/Berlin', '', 1791237600],
  ])('%s %s', (zone, text, epoch) => {
    const parsed = parseDateExpr(text, zone === 'UTC' ? UTC_ZONE : resolveTz(zone), GNU_NOW)
    expect(parsed === null ? null : parsed.getTime() / 1000).toBe(epoch)
  })
})

describe('parseDateExpr calendar shifts across a DST change', () => {
  // GNU date on debian:stable-slim: a shift landing in the hour a zone skips
  // moves past the gap under the offset in force before the change,
  // whichever side it started from, and one landing in the hour it repeats
  // keeps the base's side of the change. A base in the repeated hour itself
  // takes now's side.
  const SUMMER = new Date(1792331130 * 1000)
  const WINTER = new Date(1768478400 * 1000)
  it.each<[string, Date, number]>([
    ['2025-03-29 02:30:00 1 day', SUMMER, 1743298200],
    ['2025-03-31 02:30:00 1 day ago', SUMMER, 1743298200],
    ['2025-03-23 02:30:00 1 week', SUMMER, 1743298200],
    ['2025-04-30 02:30:00 1 month ago', SUMMER, 1743298200],
    ['2024-03-30 02:30:00 1 year', SUMMER, 1743298200],
    ['2025-10-25 02:30:00 1 day', WINTER, 1761438600],
    ['2025-10-27 02:30:00 1 day ago', SUMMER, 1761442200],
    ['2025-10-26 02:30:00 0 day', SUMMER, 1761438600],
    ['2025-10-26 02:30:00 0 day', WINTER, 1761442200],
    ['2025-10-26 02:30:00', SUMMER, 1761438600],
    ['2025-10-26 02:30:00', WINTER, 1761442200],
  ])('%s at %s in Berlin is @%d', (text, now, epoch) => {
    for (const zone of [resolveTz('Europe/Berlin'), resolveTz('CET-1CEST,M3.5.0,M10.5.0/3')]) {
      expect(parseDateExpr(text, zone, now)?.getTime()).toBe(epoch * 1000)
    }
  })

  it.each([
    ['2025-03-08 02:30:00 1 day', 1741505400],
    ['2025-03-10 02:30:00 1 day ago', 1741505400],
    ['2025-11-01 01:30:00 1 day', 1762061400],
    ['2025-11-03 01:30:00 1 day ago', 1762065000],
  ])('%s in New York is @%d', (text, epoch) => {
    // The same rules on the other side of UTC: 02:30 the night EDT starts
    // is 03:30 EDT, and 01:30 the night it ends keeps the base's side.
    expect(parseDateExpr(text, resolveTz('America/New_York'), SUMMER)?.getTime()).toBe(epoch * 1000)
  })
})

// More of the grammar, measured the same way with the clock at 2026-10-18
// 13:45:30.123 UTC (a Sunday, Berlin and New York on summer time) unless a
// case names another; the expectation is [epoch, nanoseconds], of which Date
// keeps milliseconds. Mirrors test_date_grammar in test_dates.py.
describe('parseDateExpr more grammar', () => {
  const CLOCK = 1792331130.123
  it.each<[string, string, number, [number, number] | null]>([
    // Signs: the last of a run signs the number.
    ['UTC', '2026--01-15', CLOCK, [1768435200, 0]],
    ['UTC', '- - 2 days', CLOCK, [1792158330, 123456789]],
    ['UTC', '-+2 days', CLOCK, [1792503930, 123456789]],
    // Only seconds take a fraction, and a signed one is no zone.
    ['UTC', '2026-01-15 12:00:00 0.5 seconds', CLOCK, [1768478400, 5e8]],
    ['UTC', '2026-01-15 12:00:00 1.5 sec ago', CLOCK, [1768478398, 5e8]],
    ['UTC', '2026-01-15 12:00:00 -1.5 sec ago', CLOCK, [1768478401, 5e8]],
    ['UTC', '2026-01-15 12:00:00.7 -0.9 seconds', CLOCK, [1768478399, 8e8]],
    ['UTC', '2026-01-15 12:00:00 0.1234567891 seconds', CLOCK, [1768478400, 123456789]],
    ['UTC', '2026-01-15 UTC +1.5 sec ago', CLOCK, [1768435198, 5e8]],
    ['UTC', '-0.25 seconds', CLOCK, [1792331129, 873456789]],
    // A negative one rounds down past its ninth digit.
    ['UTC', '2026-01-15 12:00:00 -0.0010000001 seconds', CLOCK, [1768478399, 998999999]],
    ['UTC', '2026-01-15 12:00 +1.5', CLOCK, null],
    ['UTC', '2026-01-15 12:00 1.5 min', CLOCK, null],
    // Only a bare weekday takes a comma after it.
    ['UTC', 'monday, 12:00', 1768478400, [1768824000, 0]],
    ['UTC', 'next monday,', 1768478400, null],
    ['UTC', '1 monday,', 1768478400, null],
    // Signs with no number after them are dropped.
    ['UTC', '2026-01-15 12:00 +day', CLOCK, [1768564800, 0]],
    ['UTC', '2026-01-15 12:00 5 -day', CLOCK, [1768910400, 0]],
    ['UTC', '2026-01-15 12:00 next +day', CLOCK, [1768564800, 0]],
    ['UTC', '2026-01-15 12:00 +EST', CLOCK, [1768496400, 0]],
    ['UTC', '15 -jan 2026', CLOCK, [1768435200, 0]],
    // Each unit keeps its own 64-bit count.
    ['UTC', '2026-01-15 12:00 9007199254740993 sec -9007199254740992 sec', CLOCK, [1768478401, 0]],
    [
      'UTC',
      '2026-01-15 12:00 9223372036854775807 sec 1 min -9223372036854775807 sec',
      CLOCK,
      [1768478460, 0],
    ],
    [
      'UTC',
      '2026-01-15 12:00 4611686018427387904 sec 4611686018427387904 sec -9223372036854775807 sec',
      CLOCK,
      null,
    ],
    ['UTC', '2026-01-15 12:00 1317624576693539402 weeks -1317624576693539402 weeks', CLOCK, null],
    ['UTC', '2026-01-15 12:00 9223372036854775808 sec -9223372036854775808 sec', CLOCK, null],
    // A number after a date without a year.
    ['UTC', '15 jan 27', CLOCK, [1799971200, 0]],
    ['UTC', 'jan 15 27', CLOCK, null],
    ['UTC', 'jan 15 7', CLOCK, [1768460400, 0]],
    ['UTC', 'jan 15 2027', CLOCK, [1799971200, 0]],
    ['UTC', 'jan 15 1030 2027', CLOCK, [-29662255980, 0]],
    ['UTC', 'jan 15 10:30 27', CLOCK, [1800009000, 0]],
    ['UTC', '15 jan 10:30', CLOCK, null],
    ['UTC', '260115', CLOCK, [1768435200, 0]],
    ['UTC', 'jan15,2027', CLOCK, null],
    ['UTC', '2026/01/15', CLOCK, [1768435200, 0]],
    ['UTC', '026/01/15', CLOCK, null],
    // Zone corrections bind to a clock time, and to a bare hour.
    ['UTC', '10 +0100', CLOCK, [1792314000, 0]],
    ['UTC', '1030 +0100', CLOCK, null],
    ['UTC', '10:30 +1 day', CLOCK, [1792402200, 0]],
    ['UTC', '10:30 +0099', CLOCK, [1792313460, 0]],
    ['UTC', '10:30 +12345', CLOCK, null],
    // A number a zone correction follows is an hour, whatever its digits.
    ['UTC', 'Jan 15 010 +0100 2026', CLOCK, [1768467600, 0]],
    ['UTC', '00000010 +0100', 1768478400, [1768467600, 0]],
    ['UTC', 'jan 15 060 +0100', CLOCK, null],
    ['UTC', '10 +0100 +1 day', CLOCK, null],
    ['UTC', '10 +01:00 +1 day', 1768478400, [1768554000, 0]],
    // Leading zeros never lengthen one.
    ['UTC', '2026-01-15 12:00 +0000100', CLOCK, [1768474800, 0]],
    ['UTC', '2026-01-15 12:00 +02401', CLOCK, null],
    ['UTC', '10:30 UTC-1:30', CLOCK, [1792324800, 0]],
    ['UTC', 'UTC +1 day', CLOCK, [1792417530, 123456789]],
    ['UTC', 'UTC +1 day ago', CLOCK, null],
    ['UTC', 'UTC DST', CLOCK, [1792278000, 0]],
    ['UTC', 'CEST DST', CLOCK, null],
    ['UTC', '10:30 A DST', CLOCK, [1792312200, 0]],
    ['UTC', 'a day', CLOCK, [1792413930, 123456789]],
    ['UTC', 'J', CLOCK, [1792281600, 0]],
    ['UTC', '10:30 J UTC', CLOCK, null],
    ['UTC', '10:30 U.T.C.', CLOCK, [1792319400, 0]],
    ['UTC', 'E.S.T.', CLOCK, [1792299600, 0]],
    // T joins an ISO date to its time, and is a zone anywhere else.
    ['UTC', '2026-01-15 T 10:30', CLOCK, [1768473000, 0]],
    ['UTC', '2026-01-15T10:30pm', CLOCK, null],
    ['UTC', '2026-01-15T10+0100', CLOCK, [1768467600, 0]],
    ['UTC', '2026-01-15T010+05:30', CLOCK, [1768451400, 0]],
    ['UTC', '2026-01-15T10+001:00', CLOCK, [1768467600, 0]],
    ['UTC', '2026-01-15T10+1 day', CLOCK, [1768554000, 0]],
    ['UTC', '2026-01-15T10', CLOCK, null],
    ['UTC', '2026-01-15T10.5+0100', CLOCK, null],
    ['UTC', 'jan 15 T 10:30', CLOCK, [1768498200, 0]],
    // Words.
    ['UTC', 'second monday', CLOCK, [1792368001, 0]],
    ['UTC', '15 monday', CLOCK, [1800835200, 0]],
    ['UTC', 'monday 1 day', CLOCK, [1792454400, 0]],
    ['UTC', 'jan 15 next monday', CLOCK, [1768435200, 0]],
    ['UTC', 'mon,10:30', CLOCK, [1792405800, 0]],
    ['UTC', ', monday', CLOCK, null],
    ['UTC', 'sat.', CLOCK, [1792800000, 0]],
    ['UTC', 'tues.', CLOCK, null],
    ['UTC', 'wednes', CLOCK, [1792540800, 0]],
    ['UTC', '1 day hence', CLOCK, [1792417530, 123456789]],
    ['UTC', 'last day ago', CLOCK, [1792417530, 123456789]],
    ['UTC', 'next next day', CLOCK, null],
    ['UTC', 'yesterday tomorrow', CLOCK, [1792331130, 123456789]],
    ['UTC', '1 year 2 months 3 days ago', CLOCK, [1828878330, 123456789]],
    ['UTC', '9:30 p.m.', CLOCK, [1792359000, 0]],
    ['UTC', '9:30 pm.', CLOCK, null],
    ['UTC', '12am', CLOCK, [1792281600, 0]],
    ['UTC', '0am', CLOCK, null],
    ['UTC', '10:30:45.1234567895', CLOCK, [1792319445, 123456789]],
    // Comments, epochs and a TZ prefix.
    ['UTC', '(unclosed 10:30', CLOCK, [1792281600, 0]],
    ['UTC', '10(x):30', CLOCK, [1792319400, 0]],
    ['UTC', '@-1.5', CLOCK, [-2, 500000000]],
    ['UTC', '@1 UTC', CLOCK, null],
    ['UTC', 'TZ="Asia/Tokyo" 2026-01-15 10:30', CLOCK, [1768440600, 0]],
    ['UTC', 'TZ="a\\b" 10:30', CLOCK, null],
    ['UTC', 'TZ="Europe/Berlin" 2026-10-25 02:30', CLOCK, [1792891800, 0]],
    ['Europe/Berlin', 'TZ="UTC" 10:30 CET', 1792331130, [1792315800, 0]],
    // A shift of now keeps now's daylight state; one of a date does not.
    ['Europe/Berlin', '1 month', CLOCK, [1795009530, 123456789]],
    ['Europe/Berlin', 'UTC 1 month', CLOCK, [1795013130, 123456789]],
    ['Europe/Berlin', '10:30 1 month', CLOCK, [1794994200, 0]],
    ['Europe/Berlin', '1 day', 1774661400, [1774747800, 0]],
    ['Europe/Berlin', '1 day ago', 1774830600, [1774744200, 0]],
    ['Europe/Moscow', '13 years ago', 1768478400, [1358247600, 0]],
    ['Australia/Lord_Howe', '6 months', 1768478400, [1784116800, 0]],
    ['Europe/Berlin', '2026-03-28 02:30 1 day', CLOCK, [1774747800, 0]],
    ['Europe/Berlin', '2026-03-29 02:30', CLOCK, null],
    // A zone given reads a skipped hour as its own.
    ['Europe/Berlin', '2026-03-29 02:30 +0000', CLOCK, [1774751400, 0]],
    ['Europe/Berlin', '2026-03-29 02:30 UTC 1 month', CLOCK, [1777429800, 0]],
    ['Europe/Berlin', '2026-03-29 02:30 CEST', CLOCK, null],
    // Ramadan's hour back is a daylight state of its own.
    ['Africa/Casablanca', '40 days', 1768046400, [1771502400, 0]],
    ['Africa/Casablanca', '1 month ago', 1772366400, [1769947200, 0]],
    ['Africa/Casablanca', '2 months', 1735732800, [1740830400, 0]],
    ['America/New_York', '2026-11-01 01:30', CLOCK, [1793511000, 0]],
    ['Europe/Berlin', '2026-10-25 02:30', 1792888200, [1792888200, 0]],
    ['Europe/Berlin', '2026-10-25 02:30', 1792891800, [1792891800, 0]],
    // The zone's own names keep it, in the daylight state they name.
    ['Europe/Berlin', '10:30 CET', CLOCK, null],
    ['Europe/Berlin', '10:30 CEST', CLOCK, [1792312200, 0]],
    ['Europe/Berlin', 'CET DST', CLOCK, [1792274400, 0]],
    ['Europe/Berlin', '2026-10-25 02:30 CET', CLOCK, [1792891800, 0]],
    ['Europe/Berlin', 'CET 1 month', 1792331130, null],
    ['Europe/Berlin', 'CET 9 month', 1792888200, [1816479000, 0]],
    ['Europe/Berlin', '2026-10-20 10:30 CEST 1 month', 1792331130, [1795163400, 0]],
    ['Europe/Berlin', '10:30 MEZ', 1792331130, [1792315800, 0]],
    ['America/New_York', '10:30 EST', CLOCK, null],
    ['America/New_York', 'E.S.T.', CLOCK, null],
    ['America/New_York', 'EST DST', 1792331130, [1792296000, 0]],
    // A POSIX zone names both halves when date sees both.
    ['STD0SUM-1,M4.1.0,M5.1.0', '2026-04-15 12:00 SUM', CLOCK, [1776250800, 0]],
    ['STD0SUM-1,M4.1.0,M5.1.0', '2026-10-15 12:00 SUM', CLOCK, null],
    // A name both seasons use pins neither.
    ['XXX0XXX-1,M3.2.0,M11.1.0', '2026-01-15 12:00 XXX', 1784116800, [1768478400, 0]],
    ['XXX0XXX-1,M3.2.0,M11.1.0', 'XXX 6 months ago', 1784116800, [1768482000, 0]],
    // The zone's names come after month, weekday and meridian words
    // and before every other word.
    ['MAY0', 'May 15, 2026', CLOCK, [1778803200, 0]],
    ['MON0', '12:00 MON', 1768478400, [1768824000, 0]],
    ['AGO0', '1 day ago', 1768478400, [1768564800, 0]],
    // A daylight time shorter than a day, and whose name date never
    // sees from a clock outside it.
    ['STD0SUM-1,M4.1.0/0,M4.1.0/6', '2026-04-05 03:00', 1768478400, [1775354400, 0]],
    ['STD0SUM-1,M4.1.0/0,M4.1.0/6', '2026-04-05 03:00 SUM', 1768478400, null],
    ['STD0SUM-1,M4.1.0/0,M4.1.0/6', '2026-04-05 03:00 SUM', 1775354400, [1775354400, 0]],
    // date reads the names now and 90, 180 and 270 days on.
    ['STD0SUM-1,J105/0,J106/0', '2026-04-15 12:00 SUM', 1768478400, [1776250800, 0]],
    ['STD0SUM-1,J1/0,J2/0', '2026-01-01 12:00 SUM', 1768478400, null],
    // A shift keeps a daylight time shorter than a day.
    ['STD0SUM-1,M4.1.0/0,M4.1.0/6', '2026-04-05 03:00 STD DST 1 day', 1768478400, [1775440800, 0]],
    // A weekday moves the date before months do.
    ['America/New_York', '-18 sec -25 month 16:47 third monday', CLOCK, [1727902002, 0]],
  ])('%s %s', (zone, text, now, expected) => {
    const parsed = parseDateExpr(
      text,
      zone === 'UTC' ? UTC_ZONE : resolveTz(zone),
      new Date(Math.round(now * 1000)),
    )
    const want = expected === null ? null : expected[0] * 1000 + Math.floor(expected[1] / 1e6)
    expect(parsed === null ? null : parsed.getTime()).toBe(want)
  })

  it('keeps a shift exact when other units cancel past what a double holds', () => {
    // The shared core keeps the intermediate shift exact, as GNU date does.
    const text = '2026-01-15 12:00:01 285426750 years -9007198249190400 seconds'
    expect(parseDateExpr(text, UTC_ZONE, new Date(1768478400_000))?.getTime()).toBe(1768478401_000)
  })

  it('reads a long run of signs once', () => {
    // A run of signs with no number after it is dropped, read once.
    const parsed = parseDateExpr('+'.repeat(100_000), UTC_ZONE, new Date(1768478400_000))
    expect(parsed?.getTime()).toBe(1768435200_000)
  })
})

describe('parseDateExpr years below 100', () => {
  it('keeps a year below 100 as itself, as GNU and Python do', () => {
    // `Date.UTC(42, ...)` is 1942; GNU `date -d 0042-01-01` is year 42.
    expect(parseDateExpr('0042-01-01', UTC_ZONE)?.getUTCFullYear()).toBe(42)
    expect(parseDateExpr('0042-01-01T00:00:00Z', UTC_ZONE)?.getUTCFullYear()).toBe(42)
    expect(parseDateExpr('0042-01-01T00:00+01:00', UTC_ZONE)?.getUTCFullYear()).toBe(41)
    expect(parseDateExpr('0099-12-31', UTC_ZONE)?.getUTCFullYear()).toBe(99)
    expect(parseDateExpr('0042-01-01', UTC_ZONE)?.getTime()).toBe(-60841756800 * 1000)
  })
})

describe('parseDateExpr @epoch', () => {
  it.each([
    ['@0', true],
    ['@1', true],
    ['@-1', true],
    ['@1.5', true],
    ['@ 1', true],
    ['@+1', true],
    ['@01', true],
    ['@0x1', false],
    ['@1e2', false],
    ['@1.', false],
    ['@.5', false],
  ])('%s is %s', (word, accepted) => {
    // findutils 4.10 and coreutils 9.7: Number() would take `0x1`, `1e2`,
    // `1.` and `.5`, and GNU refuses every one of them.
    expect(parseDateExpr(word, UTC_ZONE) !== null).toBe(accepted)
  })
})

describe('toIsoZ', () => {
  it.each([
    ['2026-09-05T10:55:39.000Z', '2026-09-05T10:55:39Z'],
    ['2026-09-05T10:55:39.001Z', '2026-09-05T10:55:39.001000Z'],
    ['2026-09-05T10:55:39.120Z', '2026-09-05T10:55:39.120000Z'],
    ['2026-09-05T12:55:39.123+02:00', '2026-09-05T10:55:39.123000Z'],
    ['1969-12-31T23:59:59.500Z', '1969-12-31T23:59:59.500000Z'],
  ])('formats %s like Python', (input, expected) => {
    expect(toIsoZ(new Date(input))).toBe(expected)
  })
})

// A clock setting as coreutils 9.7 date reads it (`date
// MMDDhhmm[[CC]YY][.ss]` as a user without the privilege to set the clock).
// Mirrors test_dates.py.
describe('parsePosixTimeAsync', () => {
  const NOW = new Date(Date.UTC(2026, 8, 22, 12))

  it.each([
    ['01010000', Date.UTC(2026, 0, 1)],
    ['0101000024', Date.UTC(2024, 0, 1)],
    ['0101000069', Date.UTC(1969, 0, 1)],
    ['010100002024', Date.UTC(2024, 0, 1)],
    ['01010000.30', Date.UTC(2026, 0, 1, 0, 0, 30)],
    ['0229000024', Date.UTC(2024, 1, 29)],
    ['1231235924.60', Date.UTC(2025, 0, 1)],
  ])('reads %s', async (text, epochMs) => {
    expect((await parsePosixTimeAsync(text, UTC_ZONE, NOW))?.getTime()).toBe(epochMs)
  })

  it.each([
    'x',
    '0101',
    '0101000',
    '010100002',
    '01010000.3',
    '01010000.61',
    '1301000024',
    '01320000',
    '01012500',
    '0229000025',
    '0101000\uff10',
  ])('refuses %s', async (text) => {
    expect(await parsePosixTimeAsync(text, UTC_ZONE, NOW)).toBeNull()
  })

  // mirage holds what Python's datetime holds, years 1-9999 in UTC and on the
  // wall clock, where GNU also shows year 0 and year 10000.
  it.each([
    ['010100000000', 'UTC'],
    ['123123599999.60', 'UTC'],
    ['123123599999', 'America/New_York'],
    ['123118599999.60', 'America/New_York'],
    ['010100000001', 'Asia/Tokyo'],
    ['123123599999.60', 'Asia/Tokyo'],
  ])('refuses %s in %s, a moment datetime cannot hold', async (text, zone) => {
    expect(await parsePosixTimeAsync(text, resolveTz(zone))).toBeNull()
  })

  it('reads the last second datetime holds', async () => {
    expect((await parsePosixTimeAsync('123123599999.59', UTC_ZONE))?.getTime()).toBe(
      253402300799000,
    )
    expect(
      (await parsePosixTimeAsync('123118599999.59', resolveTz('America/New_York')))?.getTime(),
    ).toBe(253402300799000)
  })

  it('refuses a wall clock the zone skips', async () => {
    const berlin = resolveTz('Europe/Berlin')
    expect(await parsePosixTimeAsync('033002302025', berlin)).toBeNull()
    expect((await parsePosixTimeAsync('033003302025', berlin))?.getTime()).toBe(
      Date.UTC(2025, 2, 30, 1, 30),
    )
  })

  it.each([
    ['040503002026', 1775354400],
    // The repeated hour reads as its later, standard reading.
    ['040505302026', 1775367000],
  ])('reads %s in a daylight time shorter than a day', async (text, epoch) => {
    const zone = resolveTz('STD0SUM-1,M4.1.0/0,M4.1.0/6')
    expect((await parsePosixTimeAsync(text, zone))?.getTime()).toBe(epoch * 1000)
  })
})

it('can cancel a long date expression between shared-core steps', async () => {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, 1)
  try {
    await expect(
      parseDateExprAsync(
        '1 day '.repeat(100000),
        UTC_ZONE,
        new Date(Date.UTC(2026, 7, 16)),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    clearTimeout(timer)
  }
})

it('refuses invalid raw UTF-8 as a date', () => {
  expect(parseDateExpr('\udcff', UTC_ZONE, new Date(Date.UTC(2026, 7, 16)))).toBeNull()
})

// The same table runs in Python's test_dates.py: both hosts must spell
// every time alike.
describe('msToRfc3339', () => {
  it.each([
    [1794381854062, '2026-11-11T07:24:14.062Z'],
    [1794381854061.9998, '2026-11-11T07:24:14.062Z'],
    [1794381854062.5, '2026-11-11T07:24:14.063Z'],
    [0, '1970-01-01T00:00:00.000Z'],
    [-1.5, '1969-12-31T23:59:59.999Z'],
  ] as const)('spells %s as %s', (ms, want) => {
    expect(msToRfc3339(ms)).toBe(want)
  })
})

describe('rfc3339Of', () => {
  it.each([
    ['2026-11-11T07:24:14.062Z', '2026-11-11T07:24:14.062Z'],
    ['2026-11-11T07:24:14Z', '2026-11-11T07:24:14.000Z'],
    ['2026-11-11T07:24:14.062345Z', '2026-11-11T07:24:14.062Z'],
    ['2026-11-11T07:24:14.0629+00:00', '2026-11-11T07:24:14.062Z'],
    ['2026-11-11T15:24:14+08:00', '2026-11-11T07:24:14.000Z'],
    ['2026-11-11T02:24:14-0500', '2026-11-11T07:24:14.000Z'],
    ['2026-11-11 07:24:14', '2026-11-11T07:24:14.000Z'],
    ['2026-11-11T07:24', '2026-11-11T07:24:00.000Z'],
    ['2026-11-11', '2026-11-11T00:00:00.000Z'],
    ['1969-12-31T23:59:59.5Z', '1969-12-31T23:59:59.500Z'],
    ['2026-02-30T00:00:00Z', null],
    ['2026-11-11T24:00:00Z', null],
    ['2026-11-11T07:24:60Z', null],
    ['0050-01-01T00:00:00Z', null],
    ['Wed, 21 Oct 2015 07:28:00 GMT', null],
    ['1794381854', null],
    ['', null],
    [null, null],
  ] as const)('reads %s as %s', (text, want) => {
    expect(rfc3339Of(text)).toBe(want)
  })
})
