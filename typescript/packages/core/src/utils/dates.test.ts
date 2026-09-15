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
  parseDateExpr,
  toIsoZ,
  utcDateFolder,
} from './dates.ts'
import { LOCAL_ZONE, UTC_ZONE, resolveTz } from './timezone.ts'

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

  it('refuses a zone past a day, as GNU and Python do', () => {
    for (const zone of ['+99:99', '+24:00', '+23:60']) {
      expect(parseDateExpr(`2026-01-01T00:00${zone}`, UTC_ZONE)).toBeNull()
    }
    expect(parseDateExpr('2026-01-01T00:00+23:59', UTC_ZONE)).not.toBeNull()
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
    expect(parseDateExpr('', UTC_ZONE, NOW)).toBeNull()
    expect(parseDateExpr('@abc', UTC_ZONE, NOW)).toBeNull()
  })
})

describe('parseDateExpr calendar shifts across a DST change', () => {
  // GNU date on debian:stable-slim: a shift landing in the hour a zone skips
  // moves past the gap under the offset in force before the change,
  // whichever side it started from, and one landing in the hour it repeats
  // keeps the base's side of the change, as gnulib hands mktime the base's
  // tm_isdst.
  it.each([
    ['2025-03-29 02:30:00 1 day', 1743298200],
    ['2025-03-31 02:30:00 1 day ago', 1743298200],
    ['2025-03-23 02:30:00 1 week', 1743298200],
    ['2025-04-30 02:30:00 1 month ago', 1743298200],
    ['2024-03-30 02:30:00 1 year', 1743298200],
    ['2025-10-25 02:30:00 1 day', 1761438600],
    ['2025-10-27 02:30:00 1 day ago', 1761442200],
    ['2025-10-26 02:30:00 0 day', 1761442200],
  ])('%s in Berlin is @%d', (text, epoch) => {
    for (const zone of [resolveTz('Europe/Berlin'), resolveTz('CET-1CEST,M3.5.0,M10.5.0/3')]) {
      expect(parseDateExpr(text, zone)?.getTime()).toBe(epoch * 1000)
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
    expect(parseDateExpr(text, resolveTz('America/New_York'))?.getTime()).toBe(epoch * 1000)
  })
})

describe('parseDateExpr years below 100', () => {
  it('keeps a year below 100 as itself, as GNU and Python do', () => {
    // `Date.UTC(42, ...)` is 1942; GNU `date -d 0042-01-01` is year 42.
    expect(parseDateExpr('0042-01-01', UTC_ZONE)?.getUTCFullYear()).toBe(42)
    expect(parseDateExpr('0042-01-01T00:00:00Z', UTC_ZONE)?.getUTCFullYear()).toBe(42)
    expect(parseDateExpr('0042-01-01T00:00+01:00', UTC_ZONE)?.getUTCFullYear()).toBe(41)
    expect(parseDateExpr('0099-12-31', LOCAL_ZONE)?.getFullYear()).toBe(99)
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
    // findutils 4.10 (gnulib): Number() would take `0x1`, `1e2`, `1.` and
    // `.5`, and GNU refuses every one of them.
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
