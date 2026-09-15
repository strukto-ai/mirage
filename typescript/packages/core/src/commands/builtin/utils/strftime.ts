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

// GNU date's format directives, rendered the way `date +FMT` and
// `ls --time-style=+FMT` print them; `%q` and `%N` are the two GNU adds
// no C library strftime knows.
import type { Zone } from '../../../utils/timezone.ts'

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const MONTH_NAMES = [
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
]

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function pad4(n: number): string {
  return String(n).padStart(4, '0')
}

function dayOfYear(year: number, month: number, day: number): number {
  return Math.floor((Date.UTC(year, month, day) - Date.UTC(year, 0, 0)) / 86_400_000)
}

// ISO 8601 week-based year and week number (%G/%g/%V): the week belongs to
// the year holding its Thursday.
function isoWeekParts(year: number, month: number, day: number): [number, number] {
  const dow = new Date(Date.UTC(year, month, day)).getUTCDay()
  const isoDow = dow === 0 ? 7 : dow
  const thursday = new Date(Date.UTC(year, month, day + 4 - isoDow))
  const ty = thursday.getUTCFullYear()
  const yday = dayOfYear(ty, thursday.getUTCMonth(), thursday.getUTCDate())
  return [ty, Math.floor((yday - 1) / 7) + 1]
}

// Render `fmt` for the instant `dt` on the wall clock `zone` shows for it:
// the fields, `%z` and `%Z` all come from one reading of the zone, so a
// rendering cannot mix a UTC field with a local offset.
export function strftime(dt: Date, fmt: string, zone: Zone): string {
  const parts = zone.parts(dt)
  const { year, month, day, hour, minute, second } = parts
  const dow = parts.weekday
  const render = (code: string): string => {
    switch (code) {
      case 'a':
        return DAY_NAMES[dow] ?? ''
      case 'A': {
        const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        return full[dow] ?? ''
      }
      case 'b':
        return MONTH_NAMES[month] ?? ''
      case 'B': {
        const full = [
          'January',
          'February',
          'March',
          'April',
          'May',
          'June',
          'July',
          'August',
          'September',
          'October',
          'November',
          'December',
        ]
        return full[month] ?? ''
      }
      case 'c':
        // C-locale %c (%a %b %e %H:%M:%S %Y), what glibc renders and what
        // Python's strftime produces under LC_ALL=C.
        return `${DAY_NAMES[dow] ?? ''} ${MONTH_NAMES[month] ?? ''} ${String(day).padStart(2, ' ')} ${pad2(hour)}:${pad2(minute)}:${pad2(second)} ${pad4(year)}`
      case 'C':
        return pad2(Math.floor(year / 100))
      case 'd':
        return pad2(day)
      case 'D':
        return `${pad2(month + 1)}/${pad2(day)}/${pad2(year % 100)}`
      case 'F':
        return `${pad4(year)}-${pad2(month + 1)}-${pad2(day)}`
      case 'g':
        return pad2(isoWeekParts(year, month, day)[0] % 100)
      case 'G':
        return pad4(isoWeekParts(year, month, day)[0])
      case 'h':
        return MONTH_NAMES[month] ?? ''
      case 'H':
        return pad2(hour)
      case 'k':
        return String(hour).padStart(2, ' ')
      case 'l': {
        const h12l = hour % 12 === 0 ? 12 : hour % 12
        return String(h12l).padStart(2, ' ')
      }
      case 'n':
        return '\n'
      case 'N':
        return String(parts.ms * 1_000_000).padStart(9, '0')
      case 'P':
        return hour < 12 ? 'am' : 'pm'
      case 'q':
        return String(Math.floor(month / 3) + 1)
      case 'r': {
        const h12r = hour % 12 === 0 ? 12 : hour % 12
        return `${pad2(h12r)}:${pad2(minute)}:${pad2(second)} ${hour < 12 ? 'AM' : 'PM'}`
      }
      case 'R':
        return `${pad2(hour)}:${pad2(minute)}`
      case 't':
        return '\t'
      case 'U':
        // Week of year, Sunday-first, week 00 before the first Sunday.
        return pad2(Math.floor((dayOfYear(year, month, day) + 6 - dow) / 7))
      case 'V':
        return pad2(isoWeekParts(year, month, day)[1])
      case 'W':
        // Week of year, Monday-first.
        return pad2(Math.floor((dayOfYear(year, month, day) + 6 - ((dow + 6) % 7)) / 7))
      case 'x':
        return `${pad2(month + 1)}/${pad2(day)}/${pad2(year % 100)}`
      case 'X':
        return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`
      case 'I': {
        const h12 = hour % 12 === 0 ? 12 : hour % 12
        return pad2(h12)
      }
      case 'M':
        return pad2(minute)
      case 'm':
        return pad2(month + 1)
      case 'Y':
        return pad4(year)
      case 'y':
        return pad2(year % 100)
      case 'p':
        return hour < 12 ? 'AM' : 'PM'
      case 'S':
        return pad2(second)
      case 's':
        return String(Math.floor(dt.getTime() / 1000))
      case 'z':
        return zoneOffset(parts.offsetSec, 0, '', null)
      case 'Z':
        return parts.abbrev
      case 'e':
        return String(day).padStart(2, ' ')
      case 'T':
        return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`
      case 'j':
        return String(dayOfYear(year, month, day)).padStart(3, '0')
      case 'w':
        return String(dow)
      case 'u':
        return String(dow === 0 ? 7 : dow)
      case '%':
        return '%'
      default:
        return ''
    }
  }
  return fmt.replace(
    /%([-_0^#+]*)(\d*)((?::{1,3}(?=z))?)([aAbBcCdDeFgGhHIjklMmnNpPqrRsStTuUVwWxXYyzZ%])/g,
    (_m, flags: string, digits: string, colons: string, code: string) => {
      if (code === 'z') {
        const width = digits === '' ? null : Number(digits)
        return zoneOffset(parts.offsetSec, colons.length, flags, width)
      }
      return modified(render(code), code, flags, digits)
    },
  )
}

// GNU's flag and width prefix, pinned against date 9.7. %N is the one
// directive its flags do not touch: a width keeps that many leading
// digits and pads a wider one with zeros on the right (%3N is
// milliseconds). Everywhere else the last of `-`, `_` and `0` typed wins
// (%0_d is " 3", %_0d is "03"): `-` strips the padding and ignores the
// width (%-3d is "3"), `_` pads with spaces, `0` with zeros, and a bare
// width fills with zeros for a digit-led value and spaces otherwise
// (%3d is "003", %5b is "  Jan"); on a numeric directive the width
// replaces the default digits rather than adding to them (%1d is "3",
// %1j is "3", %3e is "  3", %03e is "003"). `^` upcases; `#` is per directive
// and outranks `^`: it lowers %p and %Z, uppers the day and month names,
// and changes nothing else (%^#B and %#^B are both JANUARY, %^#p and
// %#^p both am). `+`
// pads like `0`, and on the year directives %Y, %G, %C, %y and %g also
// leads with a sign when the value outgrows the digits the directive
// normally shows or the width leaves room for one (%+5Y is "+2026",
// %+4Y is "2026", %+6Y is "+02026", %+3C is "+20", %+3y is "+26"). A
// negative number pads after its sign (%3s of -1 is "-01", %_3s is
// " -1"). %z with a colon (%:z, %::z, %:::z) pads the hours field with
// the width covering the whole (%_:z is " +5:30", %8:z is "+0005:30"),
// while plain %z is one hhmm number, so `-` and `_` reach its minutes
// (%-z is "+530", and "+0" in UTC; %_z is " +530" and "   +0"); a colon
// before any other directive stays literal.
// The directives GNU's `+` flag signs, with the digits each shows
// before the sign becomes necessary; the two-digit years never outgrow
// theirs, so only a width signs them.
const YEARISH_DIGITS: Record<string, number> = { Y: 4, G: 4, C: 2, y: 2, g: 2 }

// The numeric directives, with the digits each shows by default; a width
// typed on one replaces that default rather than adding to it.
const NUMERIC_DIGITS: Record<string, number> = {
  C: 2,
  d: 2,
  e: 2,
  g: 2,
  G: 4,
  H: 2,
  I: 2,
  j: 3,
  k: 2,
  l: 2,
  m: 2,
  M: 2,
  S: 2,
  u: 1,
  U: 2,
  V: 2,
  w: 1,
  W: 2,
  y: 2,
  Y: 4,
}
// The numeric directives GNU fills with spaces rather than zeros.
const SPACE_PADDED = new Set(['e', 'k', 'l'])

// The directives that render a whole date or time. GNU applies the
// padding flags to their parts, not to the finished text, so `-`, `_`
// and `0` change nothing (%-D stays 09/03/26), `^` upcases the text, and
// a width pads the whole on the left, with spaces under a bare width or
// `_` and with zeros under `0` or `+` (%12D is "    09/03/26", %012D is
// 000009/03/26); %F is the exception, being %+4Y-%m-%d, so a bare, `0`
// or `+` width reaches the year (%12F is 002026-09-03, %+12F is
// +02026-09-03) while `_` still pads the whole with spaces.
const COMPOSITES = new Set(['c', 'D', 'F', 'r', 'R', 'T', 'x', 'X'])

function paddedComposite(
  base: string,
  code: string,
  pad: string | null,
  upcase: boolean,
  width: number | null,
): string {
  const out = upcase ? base.toUpperCase() : base
  if (width === null || pad === '-') return out
  if (code === 'F' && pad !== '_') {
    const year = Number(out.slice(0, -6))
    const yearWidth = width - 6
    const sign = pad === '+' && (year > 9999 || yearWidth > 4) ? '+' : ''
    return sign + String(year).padStart(yearWidth - sign.length, '0') + out.slice(-6)
  }
  return out.padStart(width, pad === '0' || pad === '+' ? '0' : ' ')
}

function winningPad(flags: string): string | null {
  const padFlags = flags.replace(/[^-_0+]/g, '')
  return padFlags === '' ? null : (padFlags[padFlags.length - 1] ?? null)
}

// GNU's padding of a signed number: zeros go after the sign, spaces
// before it, and `-` pads nothing; `width` is what the digits fill.
function padSigned(sign: string, digits: string, pad: string | null, width: number | null): string {
  if (pad === '-' || width === null || width <= digits.length) return sign + digits
  if (pad === '_') return ' '.repeat(width - digits.length) + sign + digits
  return sign + digits.padStart(width, '0')
}

// %z and its colon forms, from the offset in seconds east of UTC: %:z is
// +05:30, %::z adds seconds, %:::z keeps only the parts that are not zero.
// Mirrors the Python zone_offset.
function zoneOffset(
  offsetSec: number,
  colons: number,
  flags: string,
  width: number | null,
): string {
  const sign = offsetSec < 0 ? '-' : '+'
  const total = Math.abs(offsetSec)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (colons === 0) {
    const digits = width === null ? 4 : width - 1
    return padSigned(sign, String(hours * 100 + minutes), winningPad(flags), digits)
  }
  let tail: string
  if (colons === 1 || (colons === 3 && minutes !== 0 && seconds === 0)) tail = `:${pad2(minutes)}`
  else if (colons === 2 || seconds !== 0) tail = `:${pad2(minutes)}:${pad2(seconds)}`
  else tail = ''
  const digits = width === null ? 2 : width - tail.length - 1
  return padSigned(sign, String(hours), winningPad(flags), digits) + tail
}

function modified(base: string, code: string, flags: string, digits: string): string {
  const width = digits === '' ? null : Number(digits)
  if (code === '%') return base
  if (code === 'N') return width === null ? base : base.slice(0, width).padEnd(width, '0')
  if (flags === '' && width === null) return base
  let pad = winningPad(flags)
  if (COMPOSITES.has(code)) return paddedComposite(base, code, pad, flags.includes('^'), width)
  if (pad === '+') {
    const shown = YEARISH_DIGITS[code]
    if (shown !== undefined) {
      const value = Number(base)
      const sign = value > 10 ** shown - 1 || (width !== null && width > shown) ? '+' : ''
      return sign + String(value).padStart((width ?? 0) - sign.length, '0')
    }
    pad = '0'
  }
  const shown = NUMERIC_DIGITS[code]
  if (shown !== undefined) {
    const filler = pad ?? (SPACE_PADDED.has(code) ? '_' : '0')
    return padSigned('', String(Number(base)), filler, width ?? shown)
  }
  let out = base
  if (pad === '-') out = out.replace(/^[0 ]+(?=.)/, '')
  if (pad === '_') out = out.replace(/^0+(?=.)/, (zeros) => ' '.repeat(zeros.length))
  if (pad === '0') out = out.replace(/^ +(?=.)/, (spaces) => '0'.repeat(spaces.length))
  if (flags.includes('#')) {
    if (code === 'p' || code === 'Z') out = out.toLowerCase()
    else if ('aAbBh'.includes(code)) out = out.toUpperCase()
  } else if (flags.includes('^')) {
    out = out.toUpperCase()
  }
  if (width !== null && pad !== '-') {
    const signed = /^(-?)(\d[\s\S]*)$/.exec(out)
    const sign = signed?.[1] ?? ''
    if (signed === null || pad === '_') out = out.padStart(width, pad === '0' ? '0' : ' ')
    else out = padSigned(sign, signed[2] ?? '', '0', width - sign.length)
  }
  return out
}
