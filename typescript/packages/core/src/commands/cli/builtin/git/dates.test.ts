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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveTz, UTC_ZONE, type Zone } from '../../../../utils/timezone.ts'
import { dateClock, parseDateMode, relativeDate, showDate } from './dates.ts'
import { DateFormatColonError, UnknownDateFormatError } from './errors.ts'
import { DateKind, type DateMode } from './types.ts'

const BASE: DateMode = { kind: DateKind.NORMAL, local: false, strftime: '', now: 0, zone: null }
const CLOCK: DateMode = { ...BASE, now: 1768561800, zone: UTC_ZONE }

describe('showDate', () => {
  it.each([
    [330, '16:40 +0530'],
    [-420, '04:10 -0700'],
  ])('keeps the instant and percent escapes when formatting epoch at offset %i', (offset, wall) => {
    const mode = parseDateMode('format:%s %%s %%%s %H:%M %z', CLOCK)
    expect(showDate(1768561800, offset, mode)).toBe(`1768561800 %s %1768561800 ${wall}`)
  })

  it('keeps the instant when formatting a local epoch', () => {
    const clock = dateClock({ TZ: 'Asia/Kolkata' })
    const mode = parseDateMode('format-local:%s %H:%M %z', clock)
    expect(showDate(1768561800, -420, mode)).toBe('1768561800 16:40 +0530')
  })

  it("matches git's default format, the day unpadded", () => {
    expect(showDate(1768561800, 0, BASE)).toBe('Fri Jan 16 11:10:00 2026 +0000')
    expect(showDate(1767603900, 0, BASE)).toBe('Mon Jan 5 09:05:00 2026 +0000')
  })

  it("renders in the author's own offset", () => {
    expect(showDate(1768561800, 8 * 60, BASE)).toBe('Fri Jan 16 19:10:00 2026 +0800')
    expect(showDate(1768561800, -7 * 60, BASE)).toBe('Fri Jan 16 04:10:00 2026 -0700')
  })

  it.each([
    ['iso', '2026-01-16 16:40:00 +0530'],
    ['iso8601', '2026-01-16 16:40:00 +0530'],
    ['iso-strict', '2026-01-16T16:40:00+05:30'],
    ['iso8601-strict', '2026-01-16T16:40:00+05:30'],
    ['rfc', 'Fri, 16 Jan 2026 16:40:00 +0530'],
    ['rfc2822', 'Fri, 16 Jan 2026 16:40:00 +0530'],
    ['short', '2026-01-16'],
    ['raw', '1768561800 +0530'],
    ['unix', '1768561800'],
    ['default', 'Fri Jan 16 16:40:00 2026 +0530'],
    ['auto:iso', 'Fri Jan 16 16:40:00 2026 +0530'],
    ['local', 'Fri Jan 16 11:10:00 2026'],
    ['iso-local', '2026-01-16 11:10:00 +0000'],
    ['format:%Y/%m/%d %z [%Z]', '2026/01/16 +0530 []'],
    ['format-local:%H:%M %Z', '11:10 UTC'],
    ['format:', ''],
  ])('renders the style %s', (value, expected) => {
    expect(showDate(1768561800, 330, parseDateMode(value, CLOCK))).toBe(expected)
  })

  it('names UTC as Z in the strict ISO style', () => {
    expect(showDate(1768561800, 0, parseDateMode('iso-strict', CLOCK))).toBe('2026-01-16T11:10:00Z')
  })

  it.each([
    [1768561800 + 3600, '60 minutes ago'],
    [1768561800 + 3 * 86400, 'Fri 16:40 +0530'],
    [1768561800 + 20 * 86400, 'Fri Jan 16 16:40'],
    [1768561800 + 400 * 86400, 'Jan 16 2026'],
  ])('hides what the reader knows in the human style, now %i', (now, expected) => {
    const mode = { ...BASE, kind: DateKind.HUMAN, now, zone: UTC_ZONE }
    expect(showDate(1768561800, 330, mode)).toBe(expected)
  })

  it("hides the reader's own offset in the human style", () => {
    const mode = {
      ...BASE,
      kind: DateKind.HUMAN,
      now: 1768561800 + 3 * 86400,
      zone: resolveTz('Asia/Kolkata'),
    }
    expect(showDate(1768561800, 330, mode)).toBe('Fri 16:40')
  })
})

describe('parseDateMode', () => {
  it.each(['bogus', 'iso8601x', 'local-bogus'])('refuses %s whole', (value) => {
    expect(() => parseDateMode(value, CLOCK)).toThrow(UnknownDateFormatError)
    expect(() => parseDateMode(value, CLOCK)).toThrow(`unknown date format ${value}`)
  })

  it('needs the colon after format', () => {
    expect(() => parseDateMode('format', CLOCK)).toThrow(DateFormatColonError)
    expect(() => parseDateMode('format', CLOCK)).toThrow(
      'date format missing colon separator: format',
    )
  })
})

it.each([
  [-5, 'in the future'],
  [0, '0 seconds ago'],
  [1, '1 second ago'],
  [89, '89 seconds ago'],
  [90, '2 minutes ago'],
  [5369, '89 minutes ago'],
  [5399, '2 hours ago'],
  [36 * 3600, '2 days ago'],
  [14 * 86400, '2 weeks ago'],
  [70 * 86400, '2 months ago'],
  [365 * 86400, '1 year ago'],
  [400 * 86400, '1 year, 1 month ago'],
  [800 * 86400, '2 years, 2 months ago'],
  [1825 * 86400, '5 years ago'],
])('rounds a relative date %i seconds back as git does', (seconds, expected) => {
  expect(relativeDate(1768561800 - seconds, 1768561800)).toBe(expected)
})

it("reads git's test clock and TZ", () => {
  const clock = dateClock({ GIT_TEST_DATE_NOW: '1234 rest', TZ: 'UTC' })
  expect(clock.now).toBe(1234)
  expect(clock.zone).not.toBeNull()
  expect(dateClock({ GIT_TEST_DATE_NOW: 'x' }).now).toBe(0)
})

// Probed against git 2.50.1 and 2.47.3 with GIT_TEST_DATE_NOW at 2026-10-17
// and TZ=UTC.
it.each([
  ['relative-local', '9 months ago'],
  ['unix-local', '1768561800'],
  ['human-local', 'Fri Jan 16 11:10'],
  ['short-local', '2026-01-16'],
  ['rfc2822-local', 'Fri, 16 Jan 2026 11:10:00 +0000'],
  ['iso8601-strict-local', '2026-01-16T11:10:00Z'],
  ['raw-local', '1768561800 +0000'],
  ['auto:bogus', 'Fri Jan 16 16:40:00 2026 +0530'],
  ['format-local:', ''],
  ['format:-local', '-local'],
])('takes the spelling %s as git 2.50 does', (value, expected) => {
  const clock = dateClock({ TZ: 'UTC', GIT_TEST_DATE_NOW: '1792195200' })
  expect(showDate(1768561800, 330, parseDateMode(value, clock))).toBe(expected)
})

it.each(['normal', 'ISO', 'local-local', 'iso-', '-local', 'auto', ' iso'])(
  'refuses the spelling %j',
  (value) => {
    expect(() => parseDateMode(value, CLOCK)).toThrow(UnknownDateFormatError)
  },
)

it.each(['formatx', 'format-localx:%Y', 'format-local'])('wants a colon in %s', (value) => {
  expect(() => parseDateMode(value, CLOCK)).toThrow(`date format missing colon separator: ${value}`)
})

it.each([
  [149, '2 minutes ago'],
  [150, '3 minutes ago'],
  [127769, '35 hours ago'],
  [127770, '2 days ago'],
  [1164569, '13 days ago'],
  [1164570, '2 weeks ago'],
  [6002969, '10 weeks ago'],
  [6002970, '2 months ago'],
  [31490969, '12 months ago'],
  [31490970, '1 year ago'],
  [32873370, '1 year, 1 month ago'],
  [156338970, '5 years ago'],
  [173359770, '6 years ago'],
])('words a relative date %i seconds back to the second', (seconds, expected) => {
  expect(relativeDate(2000000000 - seconds, 2000000000)).toBe(expected)
})

it.each([
  // Later today, and three days ahead.
  [1768561800, 1768561800 + 7200, 0, 'in the future'],
  [1768561800, 1768561800 + 3 * 86400, 0, 'Mon Jan 19 11:10'],
  // Five days back is past the weekday window.
  [1768561800, 1768561800 - 5 * 86400, 0, 'Sun Jan 11 11:10'],
  // Yesterday in the month before.
  [1782907200, 1782907200 - 43201, 0, 'Tue Jun 30 23:59'],
  // Already next year at the date's own offset.
  [1767223800, 1767223800, 330, 'Jan 1 2026'],
])('shows a human date against the clock %i', (now, timestamp, offset, expected) => {
  const mode = { ...BASE, kind: DateKind.HUMAN, now, zone: UTC_ZONE }
  expect(showDate(timestamp, offset, mode)).toBe(expected)
})

// git 2.47.3 on glibc, TZ=Asia/Kolkata for -local and UTC otherwise.
it.each([
  ['%q|%N|%+|%:z|abc%', false, '%q|%N|%+|%:z|abc%'],
  ['%_z|%5z|%05z|%-z', false, '+   0|    +00000|0000+00000|+0'],
  ['%_z|%-z|%Ez', true, '+ 530|+530|+0530'],
  ['%12F|%#Z|%^Z', false, '  2026-01-16|gmt|GMT'],
  ['%10s|%012s|%s', false, '1768581600|001768581600|1768561800'],
  ['%10s|%Z|%#Z', true, '1768561800|IST|ist'],
])('hands the template %s to the C library as git does', (template, local, expected) => {
  const clock = dateClock({ TZ: local ? 'Asia/Kolkata' : 'UTC' })
  const mode = parseDateMode(`${local ? 'format-local:' : 'format:'}${template}`, clock)
  expect(showDate(1768561800, 330, mode)).toBe(expected)
})

it('keeps counting past year 9999', () => {
  expect(showDate(253402300799, 14 * 60, BASE)).toBe('Sat Jan 1 13:59:59 10000 +1400')
})

// git 2.47.3 on glibc, TZ=Asia/Kolkata for -local and UTC otherwise: the last
// of _, - and 0 decides, a width pads past a number's own digits, and - still
// pads to a width. Mirrors test_dates.py.
it.each([
  [
    '%0_12s|%_012s|%0_15F|%_015F|%0_3z|%_03z',
    false,
    '  1768581600|001768581600|     2026-01-16|000002026-01-16|  +   0|00+0000',
  ],
  [
    '%-3I|%1I|%^#p|%#Z|%3%|%-12a|%0-12F|%-6Y|%0^6b',
    false,
    '  4|04|pm|gmt|  %|         Fri|  2026-01-16|  2026|000JAN',
  ],
  [
    '%0_6z|%-_6z|%_-6z|%0-3H|%-03H|%^#Z',
    true,
    '     +   530|     +   530|     +   530| 16|016|ist',
  ],
])('pads %s by the last padding flag', (template, local, expected) => {
  const clock = dateClock({ TZ: local ? 'Asia/Kolkata' : 'UTC' })
  const mode = parseDateMode(`${local ? 'format-local:' : 'format:'}${template}`, clock)
  expect(showDate(1768561800, 330, mode)).toBe(expected)
})

// git 2.47.3 on glibc: the date's wall clock read back as the standard time
// nearest it, which in Dublin is IST and in Windhoek until 2017 and Casablanca
// from 2018 the higher offset. Mirrors test_dates.py.
it.each([
  ['Europe/Dublin', 1782907200, 60, '  1782907200'],
  ['Europe/Dublin', 1768561800, 0, '  1768558200'],
  ['Africa/Windhoek', 962971200, 60, '   962967600'],
  ['Africa/Casablanca', 1590000000, 0, '  1589996400'],
  ['Australia/Lord_Howe', 1768561800, 660, '  1768563600'],
  ['Australia/Sydney', 1782907200, 600, '  1782907200'],
  ['IST-1GMT0,M10.5.0,M3.5.0/1', 1782907200, 60, '  1782907200'],
  ['America/New_York', 1782907200, -240, '  1782910800'],
])('reads a padded epoch in %s as standard time', (zone, timestamp, offset, expected) => {
  const mode = parseDateMode('format:%12s', dateClock({ TZ: zone }))
  expect(showDate(timestamp, offset, mode)).toBe(expected)
})

// git 2.47.3 on glibc, TZ=UTC: every year a template prints is the date's own,
// at 9999 and past it, and a bare %s past 2099 is -1 as an unsigned number less
// the date's offset (only -1 with -local). Mirrors test_dates.py.
it.each([
  [
    253402300799,
    0,
    'format:%Y|%C|%G|%F|%c|%s|%12s|%12F|%_12Y',
    '9999|99|9999|9999-12-31|Fri Dec 31 23:59:59 9999|18446744073709551615|253402300799|  9999-12-31|        9999',
  ],
  [
    253402300799,
    14 * 60,
    'format:%Y|%C|%y|%F|%c|%s|%12s|%+6Y',
    '10000|100|00|10000-01-01|Sat Jan  1 13:59:59 10000|18446744073709501215|253402351199|%+6Y',
  ],
  [253402300799, -12 * 60, 'format:%s|%Y|%j', '43199|9999|365'],
  [
    2534023007990,
    0,
    'format-local:%Y|%F|%s|%12s|%^c',
    '82269|82269-12-28|18446744073709551615|2534023007990|TUE DEC 28 23:59:50 82269',
  ],
  [4102444799, 0, 'format:%s|%Y', '4102444799|2099'],
  [4102444800, 330, 'format:%s|%Y', '18446744073709531815|2100'],
  [4102444800, -570, 'format:%s|%Y', '4102444800|2099'],
])('prints the year of %i at offset %i through %s', (timestamp, offset, template, expected) => {
  const mode = parseDateMode(template, dateClock({ TZ: 'UTC' }))
  expect(showDate(timestamp, offset, mode)).toBe(expected)
})

// 1,000 dates over ten New York years: each of the ten summers is searched once
// and kept, so a later date in one reads nothing and a winter date reads the
// zone once. Mirrors test_dates.py.
it('searches each daylight stretch of a padded epoch once', () => {
  const inner = resolveTz('America/New_York')
  let reads = 0
  const zone: Zone = {
    parts: (dt) => {
      reads += 1
      return inner.parts(dt)
    },
    fromWall: (p, prefer) => inner.fromWall(p, prefer),
  }
  const mode = parseDateMode('format:%12s', {
    ...dateClock({ TZ: 'UTC' }),
    zone,
    zoneName: 'America/New_York',
  })
  const stamps = Array.from({ length: 1000 }, (_, i) => 1420070400 + i * 315619)
  const first = stamps.map((stamp) => showDate(stamp, 0, mode))
  expect(reads).toBeLessThan(stamps.length + 400 * 10)
  reads = 0
  expect(stamps.map((stamp) => showDate(stamp, 0, mode))).toEqual(first)
  expect(reads).toBeLessThan(400)
})

// Random POSIX TZ strings whose standard or daylight window lasts 1 to 12 hours,
// against git 2.47.3; where glibc missed the short standard window and read the
// clock at the daylight offset less an hour, the row carries the nearest
// standard time's reading too, which is the one printed here. Shared with
// test_dates.py.
const POSIX_EPOCHS = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../../../integ/fixtures/git/padded_epoch_posix.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { zones: { tz: string; dates: number[][] }[] }
).zones

it.each(POSIX_EPOCHS.map((zone) => [zone.tz, zone.dates] as const))(
  'reads a padded epoch in %s off its rules',
  (tz, dates) => {
    const mode = parseDateMode('format:%12s', dateClock({ TZ: tz }))
    for (const [timestamp, minutes, printed, nearest] of dates) {
      const expected = nearest ?? printed
      expect(showDate(timestamp ?? 0, minutes ?? 0, mode)).toBe(String(expected).padStart(12))
    }
  },
)

it('finds a short standard window far off', () => {
  // git 2.47.3: a nine-hour standard window in March, read from October.
  const mode = parseDateMode('format:%12s', dateClock({ TZ: 'EST5EDT,M3.2.0/11,M3.2.0/3' }))
  expect(showDate(1792304967, -420, mode)).toBe('  1792297767')
})

// Without TZ in the session, a host Intl names America/New_York is read as that
// tzdata zone through formatters built once, not one per reading. Mirrors
// test_dates.py.
it('reads a named host zone through formatters built once', () => {
  const Built = Intl.DateTimeFormat
  let built = 0
  const counted = new Proxy(Built, {
    construct(target, args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      built += 1
      return new target(...args)
    },
  })
  const host = parseDateMode('format:%12s', {
    ...dateClock({}),
    zone: null,
    zoneName: 'America/New_York',
  })
  const named = parseDateMode('format:%12s', dateClock({ TZ: 'America/New_York' }))
  const stamps = Array.from({ length: 1000 }, (_, i) => 1420070400 + i * 315619)
  Intl.DateTimeFormat = counted
  let shown: string[]
  try {
    shown = stamps.map((stamp) => showDate(stamp, 0, host))
  } finally {
    Intl.DateTimeFormat = Built
  }
  expect(built).toBeLessThanOrEqual(2)
  expect(shown).toEqual(stamps.map((stamp) => showDate(stamp, 0, named)))
})
