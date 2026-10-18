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

import { gnuStrftime, winningPad } from '../../../builtin/utils/strftime.ts'
import {
  LOCAL_ZONE,
  TZ_VAR,
  posixTransitions,
  posixZone,
  resolveTz,
  zoneFromEnv,
  type Zone,
} from '../../../../utils/timezone.ts'
import { DateFormatColonError, UnknownDateFormatError } from './errors.ts'
import { DateKind, type DateMode } from './types.ts'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

// git's test clock: when set, the moment relative and human dates count from;
// its leading integer is read, and anything else reads as 0.
const NOW_VAR = 'GIT_TEST_DATE_NOW'
const LEADING_INT = /^[ \t\n\v\f\r]*([+-]?\d+)/

// The style names --date takes whole, each also with -local after it (git
// 2.50.1 and 2.47.3 refuse anything longer or shorter, ISO in capitals
// included). `format` instead takes its template after a colon.
const STYLE_NAMES: ReadonlyMap<string, DateKind> = new Map([
  ['default', DateKind.NORMAL],
  ['relative', DateKind.RELATIVE],
  ['short', DateKind.SHORT],
  ['iso', DateKind.ISO8601],
  ['iso8601', DateKind.ISO8601],
  ['iso-strict', DateKind.ISO8601_STRICT],
  ['iso8601-strict', DateKind.ISO8601_STRICT],
  ['rfc', DateKind.RFC2822],
  ['rfc2822', DateKind.RFC2822],
  ['human', DateKind.HUMAN],
  ['raw', DateKind.RAW],
  ['unix', DateKind.UNIX],
])
const FORMAT_WORD = 'format'
const AUTO_PREFIX = 'auto:'
const LOCAL_ALIAS = 'local'
const LOCAL_SUFFIX = '-local'
// One strftime directive: flags, width, an E or O modifier, conversion.
const DIRECTIVE = /%([-_0^#]*)(\d*)([EO]?)([\s\S]?)/g
// The conversions the C library knows; git leaves any other one as typed
// (git 2.47.3 on glibc prints %q, %N, %+ and %:z literally).
const LIBC_CONVERSIONS = new Set('aAbBcCdDeFgGhHIjklmMnpPrRsStTuUVwWxXyYzZ%')
// The numbers the C library prints, with the digits each fills by default; a
// width pads past them, and `-` drops them (git 2.47.3: `%I` is `04`, `%1I`
// `04`, `%-I` `4` and `%-3I` `  4`).
const PADDED_NUMBERS: Readonly<Record<string, number>> = {
  C: 2,
  d: 2,
  e: 2,
  g: 2,
  G: 1,
  H: 2,
  I: 2,
  j: 3,
  k: 2,
  l: 2,
  m: 2,
  M: 2,
  S: 2,
  s: 1,
  u: 1,
  U: 2,
  V: 2,
  w: 1,
  W: 2,
  y: 2,
  Y: 1,
}
// The numbers it fills with spaces unless `0` says zeros; every other number
// fills with zeros unless `_` or `-` says spaces.
const SPACE_FILLED_NUMBERS = new Set('ekls')
// The zone a date shown at its own offset hands strftime: offset zero, named
// as glibc names it.
const GMT = posixZone('GMT0')
// The spans tzdata 2026c marks a zone's lower offset as daylight saving time,
// each with the standard offset in force across it: start, end (null for
// open) and offset, in seconds. Only tzdata's main format says so; its
// rearguard format, which some systems and ICU ship, marks the higher offset
// instead, so the spans are spelled out to read every zone the same way on
// every host.
const NEGATIVE_DST: Readonly<
  Record<string, readonly (readonly [number, number | null, number])[]>
> = {
  'Africa/Casablanca': [[1540692000, 1789866000, 3600]],
  'Africa/El_Aaiun': [[1540692000, 1789866000, 3600]],
  'Africa/Windhoek': [[764200800, 1508796000, 7200]],
  Eire: [[57722400, null, 3600]],
  'Europe/Dublin': [[57722400, null, 3600]],
}
// The longest step the search for where a tzdata zone's reading changes takes,
// and how far it looks, in seconds. No tzdata 2026c zone holds a reading for
// less than 166 hours after 1970, so a day's step never passes one. A POSIX TZ
// string is read off its rules instead, and the host's zone, which nothing
// bounds, an hour at a time.
const STANDARD_SCAN_STEP = 86400
const HOST_SCAN_STEP = 3600
const STANDARD_SCAN_LIMIT = 800 * 86400
// The UTC years either side of an instant a POSIX TZ string's daylight saving
// windows are laid out over, past STANDARD_SCAN_LIMIT.
const POSIX_SCAN_YEARS = 3
// How far before an instant a zone with no daylight names is read, and as far
// after, for whether its offset stands above both sides as daylight saving
// time does: every 30 days, out past the longest summer, the US's 1974 one
// included.
const SEASON_READINGS = Array.from({ length: 12 }, (_, i) => (i + 1) * 30 * 86400)
// The host's zone per name Intl gives it, read through one formatter; null
// for a name Intl does not know, which leaves the host's offsets to Date.
const HOST_ZONES = new Map<string, Zone | null>()
// One Intl formatter per zone name, read for the zone's long name, which
// says whether ICU counts an instant as daylight saving time; null for a name
// Intl does not know.
const LONG_NAMES = new Map<string, Intl.DateTimeFormat | null>()
// The name a POSIX TZ string gives its standard time: its first one.
const POSIX_STANDARD = /^(?:<([^>]*)>|([A-Za-z]+))/

/**
 * A stretch of one daylight saving reading in a zone, and the standard time
 * nearest it on either side: the last instant of the one before and its offset,
 * and the first instant of the one after and its offset, null where none lies
 * within STANDARD_SCAN_LIMIT. Mirrors Python's DaylightStretch.
 */
interface DaylightStretch {
  readonly start: number
  readonly end: number
  readonly offset: number
  readonly before: readonly [number, number] | null
  readonly after: readonly [number, number] | null
}

// The daylight saving stretches found so far, per zone, sorted by start, so a
// later date in one costs a lookup.
const STRETCHES = new WeakMap<Zone, DaylightStretch[]>()

/** A wall-clock reading: month 1 to 12, weekday 0 for Sunday. */
interface Wall {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly weekday: number
}

/**
 * The default style, carrying the clock an invocation renders by.
 *
 * @param env the command environment, read for `GIT_TEST_DATE_NOW` and `TZ`
 */
export function dateClock(env: Readonly<Record<string, string>> | null | undefined): DateMode {
  let now = Math.floor(Date.now() / 1000)
  const test = env?.[NOW_VAR]
  if (test !== undefined) {
    const found = LEADING_INT.exec(test)
    now = found ? parseInt(found[1] ?? '0', 10) : 0
  }
  const zoneName =
    env?.[TZ_VAR]?.replace(/^:/, '') ?? new Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    kind: DateKind.NORMAL,
    local: false,
    strftime: '',
    now,
    zone: zoneFromEnv(env),
    zoneName,
  }
}
/**
 * Read a `--date` value.
 *
 * `auto:<anything>` is the default style, since it names the style for a
 * terminal and mirage's output is never one. `local` alone is `default-local`.
 * A value starting `format` takes `-local` and then must have its colon; any
 * other must be a style name, with or without `-local`.
 *
 * @param value the value as typed
 * @param clock the invocation's clock, from `dateClock`
 */
export function parseDateMode(value: string, clock: DateMode): DateMode {
  if (value.startsWith(AUTO_PREFIX))
    return { ...clock, kind: DateKind.NORMAL, local: false, strftime: '' }
  if (value === LOCAL_ALIAS) return { ...clock, kind: DateKind.NORMAL, local: true, strftime: '' }
  if (value.startsWith(FORMAT_WORD)) {
    let rest = value.slice(FORMAT_WORD.length)
    const local = rest.startsWith(LOCAL_SUFFIX)
    if (local) rest = rest.slice(LOCAL_SUFFIX.length)
    if (!rest.startsWith(':')) throw new DateFormatColonError(value)
    return { ...clock, kind: DateKind.STRFTIME, local, strftime: rest.slice(1) }
  }
  const local = value.endsWith(LOCAL_SUFFIX)
  const kind = STYLE_NAMES.get(local ? value.slice(0, -LOCAL_SUFFIX.length) : value)
  if (kind === undefined) throw new UnknownDateFormatError(value)
  return { ...clock, kind, local, strftime: '' }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/**
 * An offset as git prints one, `%+05d` of `±HHMM`.
 *
 * @param offsetMinutes minutes east of UTC
 */
export function zoneText(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const total = Math.abs(offsetMinutes)
  return `${sign}${pad(Math.floor(total / 60))}${pad(total % 60)}`
}

function fixedWall(timestamp: number, offsetMinutes: number): Wall {
  const shifted = new Date((timestamp + offsetMinutes * 60) * 1000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  }
}

/** A moment on the session's clock, its `TZ` or the host's zone, and its offset. */
function localWall(timestamp: number, mode: DateMode): [Wall, number] {
  const parts = (mode.zone ?? LOCAL_ZONE).parts(new Date(timestamp * 1000))
  return [
    {
      year: parts.year,
      month: parts.month + 1,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second,
      weekday: parts.weekday,
    },
    Math.round(parts.offsetSec / 60),
  ]
}

/** `1 day` or `2 days`, git's Q_ in the untranslated locale. */
export function plural(count: number, unit: string): string {
  return count === 1 ? `${String(count)} ${unit}` : `${String(count)} ${unit}s`
}
/**
 * How long before `now` a moment was, in git's words.
 *
 * Seconds count exactly; every larger unit is the one below it rounded half up
 * (minutes from seconds, hours from minutes, days from hours, then weeks,
 * months and years from days), and the first unit whose count stays under its
 * limit is the one shown: seconds under 90, minutes under 90, hours under 36,
 * days under 14, weeks while under 70 days and months while under 365. Up to
 * five years the months left over follow the years. Measured against git
 * 2.50.1 and 2.47.3 at every second of the first two days and of every
 * transition up to 40 years: 90 s is `2 minutes ago`, 89.5 minutes `2 hours
 * ago`.
 *
 * @param timestamp the moment, in epoch seconds
 * @param now the moment counted from
 */
export function relativeDate(timestamp: number, now: number): string {
  const elapsed = now - timestamp
  if (elapsed < 0) return 'in the future'
  if (elapsed < 90) return `${plural(elapsed, 'second')} ago`
  const minutes = Math.floor((elapsed + 30) / 60)
  if (minutes < 90) return `${plural(minutes, 'minute')} ago`
  const hours = Math.floor((minutes + 30) / 60)
  if (hours < 36) return `${plural(hours, 'hour')} ago`
  const days = Math.floor((hours + 12) / 24)
  if (days < 14) return `${plural(days, 'day')} ago`
  if (days < 70) return `${plural(Math.floor((days + 3) / 7), 'week')} ago`
  if (days < 365) return `${plural(Math.floor((days + 15) / 30), 'month')} ago`
  if (days >= 5 * 365) return `${plural(Math.floor((days + 183) / 365), 'year')} ago`
  const total = Math.floor((days * 24 + 365) / 730)
  const years = Math.floor(total / 12)
  const months = total % 12
  if (!months) return `${plural(years, 'year')} ago`
  return `${plural(years, 'year')}, ${plural(months, 'month')} ago`
}

/**
 * The wall clock a style shows and the offset it is at: the date's own, or
 * with `-local` the session's.
 *
 * @param timestamp seconds since the epoch
 * @param offsetMinutes the date's own offset, minutes east of UTC
 * @param mode carries `local` and the session's zone
 */
function shown(timestamp: number, offsetMinutes: number, mode: DateMode): [Wall, number] {
  return mode.local
    ? localWall(timestamp, mode)
    : [fixedWall(timestamp, offsetMinutes), offsetMinutes]
}

/**
 * The human style: only what the reader cannot tell from now.
 *
 * git 2.50.1 and 2.47.3, measured over 3.6 million dates against six clocks in
 * six zones: a date on today's day is relative, one in another year is
 * `Jan 5 2026`, one to four days back in this month is the weekday and time,
 * followed by the date's offset when it is not the session's own, and any
 * other is `Mon Jan 5 09:05`. The date's day is read at its own offset (the
 * session's with `-local`, which never adds an offset) and today's in the
 * session's zone.
 *
 * @param timestamp seconds since the epoch
 * @param offsetMinutes the date's own offset, minutes east of UTC
 * @param mode carries the clock and the zone
 */
function human(timestamp: number, offsetMinutes: number, mode: DateMode): string {
  const [today, todayOffset] = localWall(mode.now, mode)
  const [wall, offset] = shown(timestamp, offsetMinutes, mode)
  if (wall.year === today.year && wall.month === today.month && wall.day === today.day)
    return relativeDate(timestamp, mode.now)
  const month = MONTHS[wall.month - 1] ?? ''
  if (wall.year !== today.year) return `${month} ${String(wall.day)} ${String(wall.year)}`
  const clock = `${pad(wall.hour)}:${pad(wall.minute)}`
  const weekday = DAYS[wall.weekday] ?? ''
  if (wall.month === today.month && today.day - wall.day > 0 && today.day - wall.day < 5) {
    const zone = mode.local || offset === todayOffset ? '' : ` ${zoneText(offset)}`
    return `${weekday} ${clock}${zone}`
  }
  return `${weekday} ${month} ${String(wall.day)} ${clock}`
}

/**
 * A `format:` template, as git hands it to the C library.
 *
 * git answers a bare `%s` (the instant), `%z` (the shown offset) and `%Z`
 * (empty, or the session zone's name with `-local`) itself, and `%%` stays a
 * percent sign. Everything else goes to strftime over the shown wall clock, at
 * offset zero named `GMT` unless `-local`, which is why glibc's `%#Z` reads
 * `gmt`; a conversion the C library lacks, and a `%` that ends the template,
 * stay as typed.
 *
 * @param timestamp seconds since the epoch
 * @param offsetMinutes the date's own offset, minutes east of UTC
 * @param mode carries the template, `local` and the zone
 */
function formatted(timestamp: number, offsetMinutes: number, mode: DateMode): string {
  const zone = mode.local ? (mode.zone ?? LOCAL_ZONE) : GMT
  const moment = new Date((mode.local ? timestamp : timestamp + offsetMinutes * 60) * 1000)
  const reading = zone.parts(moment)
  const offset = mode.local ? Math.round(reading.offsetSec / 60) : offsetMinutes
  return mode.strftime.replace(
    DIRECTIVE,
    (whole: string, flags: string, width: string, modifier: string, conversion: string) => {
      const bare = !flags && !width && !modifier
      const size = width ? parseInt(width, 10) : 0
      if (bare && conversion === 's') return bareEpoch(timestamp, reading.year, offsetMinutes, mode)
      if (bare && conversion === 'z') return zoneText(offset)
      if (bare && conversion === 'Z') return mode.local ? reading.abbrev : ''
      if (bare && conversion === '%') return '%'
      if (!LIBC_CONVERSIONS.has(conversion)) return whole
      if (conversion === 'z') return libcZone(reading.offsetSec, flags, size)
      const text =
        conversion === 's'
          ? String(wallAsStandard(timestamp, moment, mode))
          : conversionText(moment, conversion, zone)
      return paddedConversion(text, conversion, flags, size)
    },
  )
}

/**
 * What git prints for a bare `%s`: the instant while the shown wall clock is in
 * the years 1970 to 2099, and outside them -1 as an unsigned 64-bit number,
 * less the date's own offset unless `-local` (git 2.47.3 and 2.50.1:
 * `4102444800 +0530`, 2100-01-01 05:30 there, prints `18446744073709531815`,
 * and `253402300799 -1200` `43199`).
 *
 * @param timestamp seconds since the epoch
 * @param year the year of the shown wall clock
 * @param offsetMinutes the date's own offset, minutes east of UTC
 * @param mode carries `local`
 */
function bareEpoch(timestamp: number, year: number, offsetMinutes: number, mode: DateMode): string {
  if (year >= 1970 && year <= 2099) return String(timestamp)
  const offset = mode.local ? 0n : BigInt(offsetMinutes * 60)
  return BigInt.asUintN(64, -1n - offset).toString()
}

/**
 * One conversion over the shown wall clock, unpadded: a number's digits alone,
 * and `%F` with its year unsigned past 9999 where GNU date signs it (git
 * 2.47.3: `10000-01-01`).
 *
 * @param moment the shown wall clock
 * @param conversion the conversion letter
 * @param zone the zone the moment is read in
 */
function conversionText(moment: Date, conversion: string, zone: Zone): string {
  if (conversion in PADDED_NUMBERS) return gnuStrftime(moment, `%-${conversion}`, zone)
  if (conversion === 'F') return gnuStrftime(moment, '%Y-%m-%d', zone)
  if (conversion === 'n') return '\n'
  if (conversion === 't') return '\t'
  if (conversion === '%') return '%'
  return gnuStrftime(moment, `%${conversion}`, zone)
}

/**
 * A conversion's text cased and padded as the C library does, git 2.47.3
 * measured over every conversion under 22 flag sets and 6 widths: the last of
 * `_`, `-` and `0` typed decides the padding (`%0_12s` is spaces, `%_012s`
 * zeros). `#` upcases a day or month name and lowers `%p` and `%Z`; otherwise
 * `^` upcases anything but `%P`. A width pads text and the composites with
 * spaces unless `0` is the padding, even under `-`.
 *
 * @param text the conversion's text, a number's digits unpadded
 * @param conversion the conversion letter
 * @param flags the directive's flags
 * @param width its width, 0 for none
 */
function paddedConversion(text: string, conversion: string, flags: string, width: number): string {
  let cased = text
  if (flags.includes('#') && 'aAbBh'.includes(conversion)) cased = text.toUpperCase()
  else if (flags.includes('#') && 'pZ'.includes(conversion)) cased = text.toLowerCase()
  else if (flags.includes('^') && conversion !== 'P') cased = text.toUpperCase()
  const pad = winningPad(flags)
  const digits = PADDED_NUMBERS[conversion]
  if (digits !== undefined) {
    const spaced =
      pad === '_' || pad === '-' || (pad === null && SPACE_FILLED_NUMBERS.has(conversion))
    return cased.padStart(Math.max(pad === '-' ? 0 : digits, width), spaced ? ' ' : '0')
  }
  return cased.padStart(width, pad === '0' ? '0' : ' ')
}

/**
 * The formatter that reads a zone's long name, built once per name; null for a
 * name Intl does not know.
 *
 * @param name the zone's name
 */
function longNames(name: string): Intl.DateTimeFormat | null {
  let format = LONG_NAMES.get(name)
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone: name, timeZoneName: 'long' })
    } catch (err) {
      if (!(err instanceof RangeError)) throw err
      format = null
    }
    LONG_NAMES.set(name, format)
  }
  return format
}

/**
 * Whether ICU counts an instant as daylight saving time in a named zone, read
 * off the zone's long name, or null for a zone ICU names only by its offset
 * (`GMT+02:00`) or does not know.
 *
 * @param name the zone's tzdata name
 * @param instant seconds since the epoch
 */
function daylightName(name: string, instant: number): boolean | null {
  const format = longNames(name)
  if (format === null) return null
  const long =
    format.formatToParts(new Date(instant * 1000)).find((part) => part.type === 'timeZoneName')
      ?.value ?? ''
  if (/^GMT([+-]|$)/.test(long)) return null
  return /Daylight|Summer/.test(long)
}

/**
 * The session zone's offset at an instant, and whether tzdata calls it
 * standard time there. Intl has no daylight saving flag, so a named zone is
 * read through its long name, a POSIX TZ string through the name it shows
 * (its first is its standard time's), and any other zone through its offsets
 * up to a year either side: daylight saving time stands above both.
 * Mirrors Python's _zone_reading, which reads tzinfo's dst().
 *
 * @param instant seconds since the epoch
 * @param mode carries the session's zone and its name
 */
function zoneReading(instant: number, mode: DateMode): [number, boolean] {
  const zone = sessionZone(mode)
  const offset = offsetAt(zone, instant)
  const name = zone === LOCAL_ZONE ? '' : (mode.zoneName ?? '')
  for (const [start, end, standard] of NEGATIVE_DST[name] ?? []) {
    if (start <= instant && (end === null || instant < end)) return [offset, offset === standard]
  }
  const daylight = name === '' ? null : daylightName(name, instant)
  if (daylight !== null) return [offset, !daylight]
  const posix = mode.zone !== null && longNames(name) === null ? POSIX_STANDARD.exec(name) : null
  if (posix !== null) {
    return [offset, zone.parts(new Date(instant * 1000)).abbrev === (posix[1] ?? posix[2])]
  }
  const lowest = (sign: number): number =>
    Math.min(...SEASON_READINGS.map((shift) => offsetAt(zone, instant + sign * shift)))
  return [offset, !(offset > lowest(-1) && offset > lowest(1))]
}

/**
 * A zone's offset at an instant, seconds east of UTC; the host's straight from
 * Date, which reads it without building a formatter.
 *
 * @param zone the zone
 * @param instant seconds since the epoch
 */
function offsetAt(zone: Zone, instant: number): number {
  const at = new Date(instant * 1000)
  return zone === LOCAL_ZONE ? -at.getTimezoneOffset() * 60 : zone.parts(at).offsetSec
}

/**
 * The host's zone as Intl names it, built once per name; null for a name Intl
 * does not know. Mirrors Python's _host_zone.
 *
 * @param name the name Intl gives the host's zone
 */
function hostZone(name: string): Zone | null {
  let zone = HOST_ZONES.get(name)
  if (zone === undefined) {
    zone = name !== '' && longNames(name) !== null ? resolveTz(name) : null
    HOST_ZONES.set(name, zone)
  }
  return zone
}

/**
 * The zone a session reads its dates in: its TZ's, else the host's when Intl
 * can name it, else LOCAL_ZONE, whose offsets only Date knows. Mirrors Python's
 * _session_zone.
 *
 * @param mode carries the session's zone and, without TZ, the host's name
 */
function sessionZone(mode: DateMode): Zone {
  return mode.zone ?? hostZone(mode.zoneName ?? '') ?? LOCAL_ZONE
}

/**
 * Where the zone's reading at an instant changes: the first instant of the
 * stretch holding it (`direction` -1) or the first after it (1), found by
 * doubling steps up to STANDARD_SCAN_STEP and then halving the last one down to
 * the second; null when the reading holds past STANDARD_SCAN_LIMIT. Mirrors
 * Python's _reading_edge.
 *
 * @param instant seconds since the epoch
 * @param direction -1 to look back, 1 to look ahead
 * @param reading the zone's reading at `instant`
 * @param mode carries the session's zone
 */
function readingEdge(
  instant: number,
  direction: number,
  reading: readonly [number, boolean],
  mode: DateMode,
): number | null {
  const same = (at: number): boolean => {
    const [offset, standard] = zoneReading(at, mode)
    return offset === reading[0] && standard === reading[1]
  }
  const longest = sessionZone(mode) === LOCAL_ZONE ? HOST_SCAN_STEP : STANDARD_SCAN_STEP
  let held = instant
  let step = 3600
  while (Math.abs(held - instant) < STANDARD_SCAN_LIMIT) {
    let probe = held + direction * step
    if (!same(probe)) {
      while (Math.abs(probe - held) > 1) {
        const middle = Math.floor((held + probe) / 2)
        if (same(middle)) held = middle
        else probe = middle
      }
      return direction < 0 ? held : probe
    }
    held = probe
    step = Math.min(2 * step, longest)
  }
  return null
}

/**
 * The daylight saving stretch holding an instant in a zone given as a POSIX TZ
 * string, read off its rules: each UTC year's window from the instant its
 * start rule lays out to the one its end rule does, wrapping the year when the
 * end comes first, merged across years. Null for a zone of any other kind.
 * Mirrors Python's _posix_stretch.
 *
 * @param instant seconds since the epoch, in daylight saving time
 * @param offset the zone's offset then, seconds east of UTC
 * @param mode carries the session's zone
 */
function posixStretch(instant: number, offset: number, mode: DateMode): DaylightStretch | null {
  if (mode.zone === null) return null
  const year = new Date(instant * 1000).getUTCFullYear()
  const first = year - POSIX_SCAN_YEARS
  const last = year + POSIX_SCAN_YEARS
  const windows: [number, number][] = []
  for (let each = first; each <= last; each++) {
    const laid = posixTransitions(mode.zone, each)
    if (laid === null) return null
    const [start, end] = laid
    const opens = Date.UTC(each, 0, 1) / 1000
    const closes = Date.UTC(each + 1, 0, 1) / 1000
    const pieces: [number, number][] =
      start <= end
        ? [[start, end]]
        : [
            [opens, end],
            [start, closes],
          ]
    for (const [begin, finish] of pieces) {
      const from = Math.max(begin, opens)
      const to = Math.min(finish, closes)
      if (from >= to) continue
      const previous = windows[windows.length - 1]
      if (previous !== undefined && previous[1] >= from) previous[1] = Math.max(previous[1], to)
      else windows.push([from, to])
    }
  }
  const low = Date.UTC(first, 0, 1) / 1000
  const high = Date.UTC(last + 1, 0, 1) / 1000
  for (const [start, end] of windows) {
    if (start <= instant && instant < end) {
      return {
        start,
        end,
        offset,
        before: start <= low ? null : [start - 1, zoneReading(start - 1, mode)[0]],
        after: end >= high ? null : [end, zoneReading(end, mode)[0]],
      }
    }
  }
  return { start: instant, end: instant + 1, offset, before: null, after: null }
}

/**
 * The standard time nearest an edge, walking on past any other daylight saving
 * stretch next to it: the instant where it meets the edge's side and its
 * offset, null when none lies within reach. Mirrors Python's _standard_beyond.
 *
 * @param edge the first instant outside a stretch on this side
 * @param direction -1 to look back, 1 to look ahead
 * @param mode carries the session's zone
 */
function standardBeyond(edge: number, direction: number, mode: DateMode): [number, number] | null {
  let at: number | null = edge
  while (at !== null && Math.abs(at - edge) < STANDARD_SCAN_LIMIT) {
    const reading = zoneReading(at, mode)
    if (reading[1]) return [at, reading[0]]
    const far = readingEdge(at, direction, reading, mode)
    at = far === null ? null : direction < 0 ? far - 1 : far
  }
  return null
}

/**
 * The daylight saving stretches found so far in the session's zone, the host's
 * under LOCAL_ZONE. Mirrors Python's _stretches_of.
 *
 * @param mode carries the session's zone, null for the host's
 */
function stretchesOf(mode: DateMode): DaylightStretch[] {
  const zone = sessionZone(mode)
  let found = STRETCHES.get(zone)
  if (found === undefined) {
    found = []
    STRETCHES.set(zone, found)
  }
  return found
}

/**
 * The standard offset nearest an instant in the session's zone: its own where
 * tzdata calls it standard time, else that of the standard time nearer to it,
 * before or after. Measured on git 2.47.3 over 20 zones and 2,376 dates each,
 * among them Europe/Dublin, whose standard time is IST and whose GMT winter is
 * negative daylight saving time, Africa/Casablanca since 2018,
 * Africa/Windhoek from 1994 to 2017, Australia/Lord_Howe's half hour and the
 * southern hemisphere. A daylight saving stretch is searched once per zone and
 * kept. Mirrors Python's _standard_offset.
 *
 * @param instant seconds since the epoch
 * @param mode carries the session's zone
 */
function standardOffset(instant: number, mode: DateMode): number {
  const stretches = stretchesOf(mode)
  let low = 0
  let high = stretches.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((stretches[middle]?.start ?? 0) <= instant) low = middle + 1
    else high = middle
  }
  let stretch = stretches[low - 1]
  if (stretch === undefined || instant >= stretch.end) {
    const reading = zoneReading(instant, mode)
    if (reading[1]) return reading[0]
    let found = posixStretch(instant, reading[0], mode)
    if (found === null) {
      const start = readingEdge(instant, -1, reading, mode)
      const end = readingEdge(instant, 1, reading, mode)
      found = {
        start: start ?? instant,
        end: end ?? instant + 1,
        offset: reading[0],
        before: start === null ? null : standardBeyond(start - 1, -1, mode),
        after: end === null ? null : standardBeyond(end, 1, mode),
      }
    }
    stretch = found
    if (stretch.before !== null && stretch.after !== null) stretches.splice(low, 0, stretch)
  }
  const { before, after } = stretch
  if (before !== null && (after === null || instant - before[0] <= after[0] - instant)) {
    return before[1]
  }
  return after === null ? stretch.offset : after[1]
}

/**
 * What a `%s` that carries a flag, a width or a modifier prints. With
 * `-local` that is the instant; otherwise the date's own wall clock read back
 * as standard time in the session's zone, so it moves by the difference (git
 * 2.47.3, `TZ=UTC`: `999999999 -0930` prints `999965799`; in New York it
 * counts EST all year, and in Dublin IST). Mirrors Python's _wall_as_standard.
 *
 * @param timestamp seconds since the epoch
 * @param moment the shown wall clock, as a UTC reading unless `-local`
 * @param mode carries `local` and the session's zone
 */
function wallAsStandard(timestamp: number, moment: Date, mode: DateMode): number {
  if (mode.local) return timestamp
  const wall = Math.floor(moment.getTime() / 1000)
  return wall - standardOffset(wall, mode)
}

/**
 * What glibc prints for a `%z` that carries a flag, a width or a modifier, from
 * the offset its wall clock carries: zero for a date shown at its own offset,
 * the session's with `-local`.
 *
 * The width pads twice, in front of the sign and inside the `hhmm` number,
 * which keeps four digits unless `-` drops them, and the last of `_`, `-` and
 * `0` typed decides both (git 2.47.3: `%5z` is `    +00000`, `%05z`
 * `0000+00000`, `%_z` `+   0`, `%-z` `+0` and `%0_3z` `  +   0`).
 *
 * @param offsetSec seconds east of UTC
 * @param flags the directive's flags
 * @param width its width, 0 for none
 */
function libcZone(offsetSec: number, flags: string, width: number): string {
  const sign = offsetSec < 0 ? '-' : '+'
  const total = Math.floor(Math.abs(offsetSec) / 60)
  const number = String(Math.floor(total / 60) * 100 + (total % 60))
  const pad = winningPad(flags)
  const lead = (pad === '0' ? '0' : ' ').repeat(Math.max(0, width - 1))
  if (pad === '-') return `${lead}${sign}${number.padStart(width)}`
  return `${lead}${sign}${number.padStart(Math.max(4, width), pad === '_' ? ' ' : '0')}`
}

/**
 * A date as `--date` renders it.
 *
 * `default` is `Mon Jan 5 09:05:00 2026 +0000` (the day unpadded, no offset
 * with `-local`), `iso` is `2026-01-05 09:05:00 +0000`, `iso-strict`
 * `2026-01-05T09:05:00+00:00` with `Z` for a zero offset, `rfc`
 * `Mon, 5 Jan 2026 09:05:00 +0000`, `short` the date alone, `raw` the instant
 * and the shown offset, and `unix` and `relative` the instant whatever
 * `-local` says.
 *
 * @param timestamp seconds since the epoch
 * @param offsetMinutes the date's own offset, minutes east of UTC
 * @param mode the style, with its clock and zone
 */
export function showDate(timestamp: number, offsetMinutes: number, mode: DateMode): string {
  const kind = mode.kind
  if (kind === DateKind.UNIX) return String(timestamp)
  if (kind === DateKind.RELATIVE) return relativeDate(timestamp, mode.now)
  if (kind === DateKind.HUMAN) return human(timestamp, offsetMinutes, mode)
  if (kind === DateKind.STRFTIME) return formatted(timestamp, offsetMinutes, mode)
  const [wall, offset] = shown(timestamp, offsetMinutes, mode)
  if (kind === DateKind.RAW) return `${String(timestamp)} ${zoneText(offset)}`
  const day = `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`
  if (kind === DateKind.SHORT) return day
  const clock = `${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
  const weekday = DAYS[wall.weekday] ?? ''
  const month = MONTHS[wall.month - 1] ?? ''
  if (kind === DateKind.ISO8601) return `${day} ${clock} ${zoneText(offset)}`
  if (kind === DateKind.ISO8601_STRICT) {
    const zone = zoneText(offset)
    return `${day}T${clock}${offset ? `${zone.slice(0, 3)}:${zone.slice(3)}` : 'Z'}`
  }
  if (kind === DateKind.RFC2822)
    return `${weekday}, ${String(wall.day)} ${month} ${String(wall.year)} ${clock} ${zoneText(offset)}`
  const text = `${weekday} ${month} ${String(wall.day)} ${clock} ${String(wall.year)}`
  return mode.local ? text : `${text} ${zoneText(offset)}`
}
