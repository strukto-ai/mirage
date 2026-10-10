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

import { gnuStrftime } from '../../../builtin/utils/strftime.ts'
import { LOCAL_ZONE, UTC_ZONE, zoneFromEnv, type Zone } from '../../../../utils/timezone.ts'
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

// git's test clock: when set, the moment relative and human dates count from,
// read as atoi reads it.
const NOW_VAR = 'GIT_TEST_DATE_NOW'
const LEADING_INT = /^[ \t\n\v\f\r]*([+-]?\d+)/

// parse_date_type's table, in its order: each spelling is a prefix, so the
// strict ISO spellings are tried before the plain ones they start with.
const DATE_SPELLINGS: readonly (readonly [string, DateKind])[] = [
  ['relative', DateKind.RELATIVE],
  ['iso8601-strict', DateKind.ISO8601_STRICT],
  ['iso-strict', DateKind.ISO8601_STRICT],
  ['iso8601', DateKind.ISO8601],
  ['iso', DateKind.ISO8601],
  ['rfc2822', DateKind.RFC2822],
  ['rfc', DateKind.RFC2822],
  ['short', DateKind.SHORT],
  ['default', DateKind.NORMAL],
  ['human', DateKind.HUMAN],
  ['raw', DateKind.RAW],
  ['unix', DateKind.UNIX],
  ['format', DateKind.STRFTIME],
]
const AUTO_PREFIX = 'auto:'
const LOCAL_ALIAS = 'local'
const LOCAL_SUFFIX = '-local'

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
  return { kind: DateKind.NORMAL, local: false, strftime: '', now, zone: zoneFromEnv(env) }
}

/**
 * Read a `--date` value the way git's `parse_date_format` does.
 *
 * `auto:<style>` is the style on a terminal and the default anywhere else, and
 * mirage's output is never a terminal. `local` is the historical spelling of
 * `default-local`.
 *
 * @param value the value as typed
 * @param clock the invocation's clock, from `dateClock`
 */
export function parseDateMode(value: string, clock: DateMode): DateMode {
  let spelled = value.startsWith(AUTO_PREFIX) ? 'default' : value
  if (spelled === LOCAL_ALIAS) spelled = 'default-local'
  const found = DATE_SPELLINGS.find(([word]) => spelled.startsWith(word))
  if (found === undefined) throw new UnknownDateFormatError(spelled)
  const [word, kind] = found
  let rest = spelled.slice(word.length)
  const local = rest.startsWith(LOCAL_SUFFIX)
  if (local) rest = rest.slice(LOCAL_SUFFIX.length)
  if (kind === DateKind.STRFTIME) {
    if (!rest.startsWith(':')) throw new DateFormatColonError(spelled)
    return { ...clock, kind, local, strftime: rest.slice(1) }
  }
  if (rest) throw new UnknownDateFormatError(spelled)
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
 * How long before `now` a moment was, as `show_date_relative` words it.
 *
 * @param timestamp seconds since the epoch
 * @param now the moment counted from
 */
export function relativeDate(timestamp: number, now: number): string {
  if (now < timestamp) return 'in the future'
  let diff = now - timestamp
  if (diff < 90) return `${plural(diff, 'second')} ago`
  diff = Math.floor((diff + 30) / 60)
  if (diff < 90) return `${plural(diff, 'minute')} ago`
  diff = Math.floor((diff + 30) / 60)
  if (diff < 36) return `${plural(diff, 'hour')} ago`
  diff = Math.floor((diff + 12) / 24)
  if (diff < 14) return `${plural(diff, 'day')} ago`
  if (diff < 70) return `${plural(Math.floor((diff + 3) / 7), 'week')} ago`
  if (diff < 365) return `${plural(Math.floor((diff + 15) / 30), 'month')} ago`
  if (diff < 1825) {
    const total = Math.floor((diff * 12 * 2 + 365) / (365 * 2))
    const years = Math.floor(total / 12)
    const months = total % 12
    if (months) return `${plural(years, 'year')}, ${plural(months, 'month')} ago`
    return `${plural(years, 'year')} ago`
  }
  return `${plural(Math.floor((diff + 183) / 365), 'year')} ago`
}

/**
 * git's default style, and `human`, as `show_date_normal` lays them out.
 *
 * `human` hides what the reader's own clock already says: the year when it is
 * this year, the date when it is this week, the zone when it is the reader's,
 * and a moment from today reads as a relative one. Without `human` nothing is
 * hidden but the zone of a `-local` date.
 */
function normal(timestamp: number, wall: Wall, offsetMinutes: number, mode: DateMode): string {
  const human = mode.kind === DateKind.HUMAN
  let hideTz = mode.local
  let hideYear = false
  let hideDate = false
  let hideWday = false
  let hideTime = false
  let hideSeconds = false
  if (human) {
    const [here, hereOffset] = localWall(mode.now, mode)
    hideTz = hideTz || zoneText(offsetMinutes) === zoneText(hereOffset)
    hideYear = wall.year === here.year
    if (hideYear && wall.month === here.month) {
      if (wall.day === here.day) {
        hideDate = true
        hideWday = true
      } else if (wall.day < here.day && wall.day + 5 > here.day) {
        hideDate = true
      }
    }
    if (hideWday) return relativeDate(timestamp, mode.now)
    hideSeconds = true
    hideTz = hideTz || !hideDate
    hideWday = !hideYear
    hideTime = !hideYear
  }
  let out = ''
  if (!hideWday) out += `${DAYS[wall.weekday] ?? ''} `
  if (!hideDate) out += `${MONTHS[wall.month - 1] ?? ''} ${String(wall.day)} `
  if (!hideTime) {
    out += `${pad(wall.hour)}:${pad(wall.minute)}`
    if (!hideSeconds) out += `:${pad(wall.second)}`
  } else {
    out = out.replace(/\s+$/, '')
  }
  if (!hideYear) out += ` ${String(wall.year)}`
  if (!hideTz) out += ` ${zoneText(offsetMinutes)}`
  return out
}

/**
 * A `format:` date, with `%s`, `%z` and `%Z` as git's `strbuf_addftime` handles
 * them: `%s` keeps the original instant, `%z` is the date's recorded offset, and `%Z`
 * is dropped unless the date is shown in the session's zone, whose name is the
 * only one strftime can know.
 */
function formatted(timestamp: number, offsetMinutes: number, mode: DateMode): string {
  const template = mode.strftime
  const munged: string[] = []
  let i = 0
  while (i < template.length) {
    const char = template[i] ?? ''
    if (char !== '%' || i + 1 === template.length) {
      munged.push(char)
      i += 1
      continue
    }
    const after = template[i + 1] ?? ''
    if (after === '%') munged.push('%%')
    else if (after === 's') munged.push(String(timestamp))
    else if (after === 'z') munged.push(zoneText(offsetMinutes))
    else if (after !== 'Z' || mode.local) munged.push(`%${after}`)
    i += 2
  }
  const zone: Zone = mode.local ? (mode.zone ?? LOCAL_ZONE) : UTC_ZONE
  const shown = mode.local ? timestamp : timestamp + offsetMinutes * 60
  return gnuStrftime(new Date(shown * 1000), munged.join(''), zone)
}

/**
 * Render a moment in a git date style, as git's `show_date` does.
 *
 * The day of the month is never padded in the default style (`Fri Jan 16
 * 11:30:00 2026 +0000`), and every style but `-local` reads the moment in the
 * offset it was recorded with, so a commit prints the wall clock its author saw.
 *
 * @param timestamp seconds since the epoch
 * @param offsetMinutes the recorded UTC offset, minutes east
 * @param mode the style, with the clock it counts from
 */
export function showDate(timestamp: number, offsetMinutes: number, mode: DateMode): string {
  if (mode.kind === DateKind.UNIX) return String(timestamp)
  let wall: Wall
  let offset = offsetMinutes
  if (mode.local) [wall, offset] = localWall(timestamp, mode)
  else wall = fixedWall(timestamp, offsetMinutes)
  const zone = zoneText(offset)
  const date = `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`
  const time = `${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
  switch (mode.kind) {
    case DateKind.RAW:
      return `${String(timestamp)} ${zone}`
    case DateKind.RELATIVE:
      return relativeDate(timestamp, mode.now)
    case DateKind.SHORT:
      return date
    case DateKind.ISO8601:
      return `${date} ${time} ${zone}`
    case DateKind.ISO8601_STRICT:
      return `${date}T${time}${offset === 0 ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(3)}`}`
    case DateKind.RFC2822:
      return (
        `${DAYS[wall.weekday] ?? ''}, ${String(wall.day)} ${MONTHS[wall.month - 1] ?? ''} ` +
        `${String(wall.year)} ${time} ${zone}`
      )
    case DateKind.STRFTIME:
      return formatted(timestamp, offset, mode)
    default:
      return normal(timestamp, wall, offset, mode)
  }
}
