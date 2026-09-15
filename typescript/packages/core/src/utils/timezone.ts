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

// The zone a command renders time in, read from its own environment's TZ
// the way glibc's tzset reads it, never from the process: two workspaces
// running at once each see their own TZ and neither moves the host's
// clock. Mirrors the Python mirage.utils.timezone.

import { TZ_ABBREVS } from './tz_abbrevs.ts'

export const TZ_VAR = 'TZ'

/** A wall-clock reading: the calendar fields a zone shows for an instant. */
export interface WallParts {
  year: number
  // 0 for January, as `Date` counts it.
  month: number
  day: number
  hour: number
  minute: number
  second: number
  ms: number
}

/** A wall-clock reading with the zone's offset and abbreviation at that instant. */
export interface ZoneParts extends WallParts {
  // 0 for Sunday.
  weekday: number
  // Seconds east of UTC.
  offsetSec: number
  abbrev: string
}

/**
 * A time zone: the wall clock it shows for an instant, and the instant its
 * wall clock reads as. `Date` has no zone of its own, so every rendering
 * (`strftime`) and every reading (`parseDateExpr`) goes through one of
 * these rather than through a `utc` flag.
 */
export interface Zone {
  parts(dt: Date): ZoneParts
  /**
   * The instant whose wall clock reads `p`. A wall clock two instants share
   * (the hour repeated when DST ends) resolves to the one under `prefer`,
   * the offset in seconds east that a displaced moment started from, which
   * is how gnulib hands mktime the base's tm_isdst, and to the later one
   * without it, as glibc's mktime resolves an absolute reading. One no
   * instant shows (the hour skipped when DST starts) is read under the
   * offset in force before the change and so lands forward by the gap,
   * which a caller that must refuse it detects by comparing `parts` of the
   * result against `p`.
   */
  fromWall(p: WallParts, prefer?: number): Date
}

const HOUR = 3600
const DAY_MS = 86_400_000

// A POSIX TZ name: `<...>` quotes three or more letters, digits and signs
// (`<+0530>`), and a bare name is three or more letters (`EST`).
const NAME_RE = /<([+\-0-9A-Za-z]{3,})>|([A-Za-z]{3,})/y
// An unsigned `h[:m[:s]]` as glibc's `%hu:%hu:%hu` reads it: each field
// takes any run of digits, and a colon with no digits after it ends the
// number there.
const CLOCK_RE = /(\d+)(?::(\d+))?(?::(\d+))?/y
const DIGITS_RE = /\d+/y
// `Mm.w.d`, read as far as it goes: `M3` and `M3.5` are the partial reads
// glibc keeps when it refuses the rule.
const MONTH_RULE_RE = /M(?:(\d+)(?:\.(\d+)(?:\.(\d+))?)?)?/y
// glibc clamps a POSIX offset at 24 hours (`UTC24`, and `UTC99` reads the
// same), one second past what Python's tzinfo may carry, so both mirage
// hosts stop there: `TZ=UTC24 date -d @0 +%z` is `-2359` here, `-2400`
// under GNU, and the wall clock lands one second later.
const MAX_OFFSET = 24 * HOUR - 1

/**
 * A Date from wall-clock fields read as UTC. `Date.UTC` reads a year below
 * 100 as 1900 plus that year; the setters do not, so a year GNU and Python
 * accept as itself (`0042-01-01`) lands where it belongs. Overflowing
 * fields carry, so day 32 is the next month's first.
 */
export function utcFromWall(p: WallParts): Date {
  const d = new Date(0)
  d.setUTCFullYear(p.year, p.month, p.day)
  d.setUTCHours(p.hour, p.minute, p.second, p.ms)
  return d
}

function utcWall(dt: Date): WallParts & { weekday: number } {
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth(),
    day: dt.getUTCDate(),
    hour: dt.getUTCHours(),
    minute: dt.getUTCMinutes(),
    second: dt.getUTCSeconds(),
    ms: dt.getUTCMilliseconds(),
    weekday: dt.getUTCDay(),
  }
}

class UtcZone implements Zone {
  parts(dt: Date): ZoneParts {
    return { ...utcWall(dt), offsetSec: 0, abbrev: 'UTC' }
  }

  fromWall(p: WallParts): Date {
    return utcFromWall(p)
  }
}

// Resolve the host zone at the instant being formatted, just as explicit TZ does.
class LocalZone implements Zone {
  parts(dt: Date): ZoneParts {
    return {
      year: dt.getFullYear(),
      month: dt.getMonth(),
      day: dt.getDate(),
      hour: dt.getHours(),
      minute: dt.getMinutes(),
      second: dt.getSeconds(),
      ms: dt.getMilliseconds(),
      weekday: dt.getDay(),
      offsetSec: -dt.getTimezoneOffset() * 60,
      abbrev: tzAbbreviation(
        new Intl.DateTimeFormat().resolvedOptions().timeZone,
        -dt.getTimezoneOffset() * 60,
        Math.floor(dt.getTime() / 1000),
      ),
    }
  }

  fromWall(p: WallParts): Date {
    const d = new Date(0)
    d.setFullYear(p.year, p.month, p.day)
    d.setHours(p.hour, p.minute, p.second, p.ms)
    return d
  }
}

/** One offset under one abbreviation: `UTC0`, `JST-9`, `<+0530>-5:30`. */
class FixedZone implements Zone {
  constructor(
    private readonly offsetSec: number,
    private readonly abbrev: string,
  ) {}

  parts(dt: Date): ZoneParts {
    const shown = utcWall(new Date(dt.getTime() + this.offsetSec * 1000))
    return { ...shown, offsetSec: this.offsetSec, abbrev: this.abbrev }
  }

  fromWall(p: WallParts): Date {
    return new Date(utcFromWall(p).getTime() - this.offsetSec * 1000)
  }
}

/**
 * The abbreviation tzdata gives an offset it has no letters for: `+08`,
 * `-03`, `+0530`, with minutes only when they are not zero.
 */
export function numericAbbreviation(offsetSec: number): string {
  const sign = offsetSec < 0 ? '-' : '+'
  const total = Math.abs(offsetSec)
  const hours = String(Math.floor(total / 3600)).padStart(2, '0')
  const minutes = Math.floor((total % 3600) / 60)
  return minutes === 0 ? `${sign}${hours}` : `${sign}${hours}${String(minutes).padStart(2, '0')}`
}

/**
 * The abbreviation tzdata gives `name` at `offsetSec` as of `atSec` (epoch
 * seconds), which is what GNU date prints for `%Z` and what Python's
 * zoneinfo renders. Intl only offers `GMT+8`, so the names ship in
 * TZ_ABBREVS (generated from zoneinfo by scripts/gen_tz_abbrevs.py), one
 * row per name an offset has carried with the moment it took effect: the
 * latest row for the offset that had taken effect by `atSec` wins, the
 * earliest stands in before the table's 1970 start, and an offset with no
 * row is one tzdata spells out (`+08`).
 */
export function tzAbbreviation(name: string, offsetSec: number, atSec: number): string {
  let found: string | undefined
  for (const [offset, abbrev, since] of TZ_ABBREVS[name] ?? []) {
    if (offset !== offsetSec) continue
    if (found === undefined || since <= atSec) found = abbrev
  }
  return found ?? numericAbbreviation(offsetSec)
}

/**
 * A tzdata zone, read through Intl for its offsets and through
 * tzAbbreviation for its `%Z`, so `Asia/Hong_Kong` renders `HKT` here as
 * it does under GNU date and in the Python twin.
 */
class IntlZone implements Zone {
  private readonly format: Intl.DateTimeFormat

  constructor(private readonly name: string) {
    this.format = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
  }

  parts(dt: Date): ZoneParts {
    const fields: Record<string, string> = {}
    for (const part of this.format.formatToParts(dt)) fields[part.type] = part.value
    const wall: WallParts = {
      year: Number(fields.year),
      month: Number(fields.month) - 1,
      day: Number(fields.day),
      hour: Number(fields.hour) % 24,
      minute: Number(fields.minute),
      second: Number(fields.second),
      ms: dt.getUTCMilliseconds(),
    }
    const shown = utcFromWall(wall)
    const offsetSec = Math.round((shown.getTime() - dt.getTime()) / 1000)
    return {
      ...wall,
      weekday: shown.getUTCDay(),
      offsetSec,
      abbrev: tzAbbreviation(this.name, offsetSec, Math.floor(dt.getTime() / 1000)),
    }
  }

  fromWall(p: WallParts, prefer?: number): Date {
    const wall = utcFromWall(p).getTime()
    // The offsets a day before and a day after the wall clock read as UTC
    // bracket any change near it; reading under each gives the candidate
    // instants, both of which show `p` in a repeated hour and neither of
    // which does in a skipped one.
    const before = this.parts(new Date(wall - DAY_MS)).offsetSec
    const after = this.parts(new Date(wall + DAY_MS)).offsetSec
    const candidates =
      before === after ? [wall - before * 1000] : [wall - before * 1000, wall - after * 1000]
    const shown = candidates.filter((t) => utcFromWall(this.parts(new Date(t))).getTime() === wall)
    if (shown.length === 0) return new Date(wall - before * 1000)
    const kept = shown.find((t) => this.parts(new Date(t)).offsetSec === prefer)
    return new Date(kept ?? Math.max(...shown))
  }
}

/**
 * One POSIX DST transition, `Mm.w.d`, `Jn` or `n`, with the local time of
 * day it happens at: `M` is month/week/weekday (week 5 is the last such
 * weekday, weekday 0 is Sunday), `J` a Julian day that never counts
 * February 29, `D` a zero-based day of the year that does. The time may
 * run past a day in either direction (`/-1`, `/25`), as POSIX allows. The
 * fields hold what glibc read, which for a rule it refused may sit outside
 * POSIX's ranges (see readRule): week 0 counts as 1, a weekday past 6
 * counts on from the month's first Sunday, and `J` day 0 is the day before
 * January 1, the way glibc's arithmetic has them.
 */
export interface TransitionRule {
  kind: 'M' | 'J' | 'D'
  month: number
  week: number
  weekday: number
  day: number
  seconds: number
}

// The rules glibc applies when a DST name comes with no `,rule`, or one
// clause is missing: the US transitions, second Sunday of March and first
// Sunday of November, at 02:00.
const US_RULES: readonly [TransitionRule, TransitionRule] = [
  { kind: 'M', month: 3, week: 2, weekday: 0, day: 0, seconds: 2 * HOUR },
  { kind: 'M', month: 11, week: 1, weekday: 0, day: 0, seconds: 2 * HOUR },
]
// What glibc leaves in a rule it refused: the state it zeroed before
// reading, day 0 of the year at 00:00, or, once it had read a `J`, Julian
// day 0, the day before January 1.
const ZERO_RULE: TransitionRule = { kind: 'D', month: 0, week: 0, weekday: 0, day: 0, seconds: 0 }
const REFUSED_JULIAN: TransitionRule = { ...ZERO_RULE, kind: 'J' }

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

// Days in `month` (1 for January) of `year`: day 0 of the next month.
function daysInMonth(year: number, month: number): number {
  return utcFromWall({ year, month, day: 0, hour: 0, minute: 0, second: 0, ms: 0 }).getUTCDate()
}

/** The transition's wall-clock moment in `year`, as ms of that wall clock read as UTC. */
export function transitionAt(rule: TransitionRule, year: number): number {
  const jan1 = utcFromWall({ year, month: 0, day: 1, hour: 0, minute: 0, second: 0, ms: 0 })
  let date: number
  if (rule.kind === 'M') {
    const first = utcFromWall({
      year,
      month: rule.month - 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
      ms: 0,
    })
    let day = rule.weekday - first.getUTCDay()
    if (day < 0) day += 7
    const days = daysInMonth(year, rule.month)
    for (let week = 1; week < rule.week; week++) {
      if (day + 7 >= days) break
      day += 7
    }
    date = first.getTime() + day * DAY_MS
  } else if (rule.kind === 'J') {
    date = jan1.getTime() + (rule.day - 1) * DAY_MS
    if (isLeap(year) && rule.day >= 60) date += DAY_MS
  } else {
    date = jan1.getTime() + rule.day * DAY_MS
  }
  return date + rule.seconds * 1000
}

/**
 * A zone read from a POSIX TZ string with a DST half
 * (`CET-1CEST,M3.5.0,M10.5.0/3`), the way glibc reads one. The two offsets
 * and the two rules decide everything: an instant is in DST when it lies
 * between the start transition, given in standard wall time, and the end
 * transition, given in DST wall time, both laid out in the year the UTC
 * clock reads, with the window wrapping the year in the southern
 * hemisphere and empty when the two coincide. The DST half may be nameless
 * with a zero offset, which is what glibc keeps when it cannot read its
 * name.
 */
class PosixZone implements Zone {
  constructor(
    private readonly std: string,
    private readonly stdOffsetSec: number,
    private readonly dst: string,
    private readonly dstOffsetSec: number,
    private readonly start: TransitionRule,
    private readonly end: TransitionRule,
  ) {}

  private inDst(utcMs: number): boolean {
    const year = new Date(utcMs).getUTCFullYear()
    const start = transitionAt(this.start, year) - this.stdOffsetSec * 1000
    const end = transitionAt(this.end, year) - this.dstOffsetSec * 1000
    if (start <= end) return start <= utcMs && utcMs < end
    return !(end <= utcMs && utcMs < start)
  }

  parts(dt: Date): ZoneParts {
    const inDst = this.inDst(dt.getTime())
    const offsetSec = inDst ? this.dstOffsetSec : this.stdOffsetSec
    const shown = utcWall(new Date(dt.getTime() + offsetSec * 1000))
    return { ...shown, offsetSec, abbrev: inDst ? this.dst : this.std }
  }

  fromWall(p: WallParts, prefer?: number): Date {
    const wall = utcFromWall(p).getTime()
    const asStd = wall - this.stdOffsetSec * 1000
    const asDst = wall - this.dstOffsetSec * 1000
    const stdShows = !this.inDst(asStd)
    const dstShows = this.inDst(asDst)
    // A repeated hour: the reading on the base's side of the change, else
    // standard time, the later of the two, which is the one glibc's mktime
    // picks. A skipped hour reads under standard time, the offset in force
    // before the change.
    if (stdShows && dstShows) return new Date(prefer === this.dstOffsetSec ? asDst : asStd)
    if (dstShows) return new Date(asDst)
    return new Date(asStd)
  }
}

export const UTC_ZONE: Zone = new UtcZone()
export const LOCAL_ZONE: Zone = new LocalZone()

/**
 * The zone a command environment's TZ names, or null when TZ is unset (or
 * there is no environment), which means the host's local zone.
 */
export function zoneFromEnv(env: Readonly<Record<string, string>> | null | undefined): Zone | null {
  const spec = env?.[TZ_VAR]
  if (spec === undefined) return null
  return resolveTz(spec)
}

/**
 * The zone a TZ value names, read as glibc's tzset reads it: a leading
 * colon is dropped; an empty value is UTC; a name tzdata knows
 * (`Asia/Hong_Kong`, `UTC`, `EST5EDT`) is that zone; anything else is a
 * POSIX TZ string (`UTC0`, `JST-9`, `<+0530>-5:30`,
 * `CET-1CEST,M3.5.0,M10.5.0/3`), where a bare name with no offset is UTC
 * under that name, which is how glibc renders `TZ=Bogus/Zone`
 * (`+0000 Bogus`), and a name shorter than three letters is refused,
 * leaving `%Z` empty.
 */
export function resolveTz(spec: string): Zone {
  const name = spec.startsWith(':') ? spec.slice(1) : spec
  if (name === '') return UTC_ZONE
  try {
    return new IntlZone(name)
  } catch (err) {
    if (!(err instanceof RangeError)) throw err
    return posixZone(name)
  }
}

function readName(spec: string, pos: number): [string, number] {
  NAME_RE.lastIndex = pos
  const m = NAME_RE.exec(spec)
  if (m === null) return ['', pos]
  return [m[1] ?? m[2] ?? '', NAME_RE.lastIndex]
}

// An unsigned `h[:m[:s]]` at `pos` as glibc's `%hu:%hu:%hu` reads it: the
// three fields and the position after them, or null and `pos` when no
// digit starts there.
function readClock(spec: string, pos: number): [[number, number, number] | null, number] {
  CLOCK_RE.lastIndex = pos
  const m = CLOCK_RE.exec(spec)
  if (m === null) return [null, pos]
  return [[Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], CLOCK_RE.lastIndex]
}

// A POSIX offset at `pos` as glibc's parse_offset reads it: seconds west of
// Greenwich, and the position after it. A standard offset must start with
// a sign or a digit and read at least an hour, else there is none (null,
// and `pos` unmoved). A daylight offset takes a sign even when no hours
// follow, and reads as null then, past the sign, for the caller to default.
// Hours are clamped at 24 and minutes and seconds at 59, glibc's
// compute_offset.
function readOffset(spec: string, pos: number, dst: boolean): [number | null, number] {
  const head = spec[pos] ?? ''
  if (!dst && !(head === '+' || head === '-' || /\d/.test(head))) return [null, pos]
  let sign = 1
  if (head === '+' || head === '-') {
    sign = head === '-' ? -1 : 1
    pos += 1
  }
  const [clock, end] = readClock(spec, pos)
  if (clock === null) return [null, pos]
  const [hours, minutes, seconds] = clock
  const west = Math.min(hours, 24) * HOUR + Math.min(minutes, 59) * 60 + Math.min(seconds, 59)
  return [sign * west, end]
}

// An offset Python's tzinfo can carry too: within a day, one second short.
function bounded(offsetSec: number): number {
  return Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, offsetSec))
}

/**
 * One transition rule at `pos` as glibc's parse_rule reads it: the rule,
 * the position after it, and whether glibc accepts it. An optional comma
 * leads. `Jn` and `n` take a day, `Mm.w.d` a month, week and weekday, and
 * the end of the string stands for the US rule of that half; `/time` may
 * follow, `h[:m[:s]]` with an optional `-`, and is two o'clock when absent
 * or unreadable. glibc refuses a day past 365, `J0`, a month outside 1 to
 * 12, a week outside 1 to 5, a weekday past 6, anything else where a rule
 * should start, and anything but `/`, `,` or the end after the date part;
 * it keeps what it had read so far, and the time of day, which comes last,
 * is still zero then. The refused rule comes back as glibc leaves it,
 * except that a month outside its table (which glibc reads past) is the
 * refused Julian rule here; the second rule is then never read (see
 * posixZone).
 */
function readRule(spec: string, pos: number, which: 0 | 1): [TransitionRule, number, boolean] {
  if (spec[pos] === ',') pos += 1
  const head = spec[pos] ?? ''
  let rule: TransitionRule
  if (head === 'J' || /\d/.test(head)) {
    const kind = head === 'J' ? 'J' : 'D'
    const refused = kind === 'J' ? REFUSED_JULIAN : ZERO_RULE
    DIGITS_RE.lastIndex = pos + (kind === 'J' ? 1 : 0)
    const m = DIGITS_RE.exec(spec)
    if (m === null) return [refused, pos, false]
    const day = Number(m[0])
    if (day > 365 || (kind === 'J' && day === 0)) return [refused, pos, false]
    rule = { ...ZERO_RULE, kind, day }
    pos = DIGITS_RE.lastIndex
  } else if (head === 'M') {
    MONTH_RULE_RE.lastIndex = pos
    const m = MONTH_RULE_RE.exec(spec)
    if (m === null) return [ZERO_RULE, pos, false]
    const month = Number(m[1] ?? 0)
    const week = Number(m[2] ?? 0)
    const weekday = Number(m[3] ?? 0)
    rule = { ...ZERO_RULE, kind: 'M', month, week, weekday }
    if (!(month >= 1 && month <= 12)) return [REFUSED_JULIAN, pos, false]
    const partial = m[1] === undefined || m[2] === undefined || m[3] === undefined
    if (partial || !(week >= 1 && week <= 5) || weekday > 6) return [rule, pos, false]
    pos = MONTH_RULE_RE.lastIndex
  } else if (head === '') {
    rule = US_RULES[which]
  } else {
    return [ZERO_RULE, pos, false]
  }
  const tail = spec[pos] ?? ''
  if (tail !== '' && tail !== '/' && tail !== ',') return [rule, pos, false]
  let seconds = 2 * HOUR
  if (tail === '/') {
    pos += 1
    if (pos === spec.length) return [rule, pos, false]
    const negative = spec[pos] === '-'
    if (negative) pos += 1
    const [clock, end] = readClock(spec, pos)
    const [hours, minutes, secs] = clock ?? [2, 0, 0]
    pos = end
    seconds = (negative ? -1 : 1) * (hours * HOUR + minutes * 60 + secs)
  }
  return [{ ...rule, seconds }, pos, true]
}

/**
 * The zone a POSIX TZ string names, read as glibc's tzset reads one:
 * `std[offset[dst[offset][,start[/time],end[/time]]]]`. POSIX counts an
 * offset west of Greenwich as positive, so `EST5` is five hours behind
 * UTC; a missing standard offset is zero and ends the reading
 * (`Bogus/Zone` is UTC under that name), and a missing daylight offset is
 * one hour ahead of standard. What glibc cannot read it keeps rather than
 * drops. A string with no name at all is UTC with no abbreviation. A
 * daylight half whose name it cannot read is nameless UTC, so `EST5x`
 * renders `+0000` with an empty `%Z` nearly all year, its rules being the
 * zero ones. A rule it refuses is kept as far as it was read and the rule
 * after it is never read, so `CET-1CEST,bogus` is CEST almost all year
 * and `CET-1CEST,M3.5.0,M13.1.0` is CEST from late March to the year's
 * end. A rule that is missing is the US one for that half; glibc consults
 * a `posixrules` file for that on hosts that ship one, which is not
 * mirrored.
 */
export function posixZone(spec: string): Zone {
  const [std, afterStd] = readName(spec, 0)
  if (std === '') return new FixedZone(0, '')
  const [west, afterOffset] = readOffset(spec, afterStd, false)
  if (west === null || afterOffset === spec.length) {
    return new FixedZone(bounded(0 - (west ?? 0)), std)
  }
  const stdOffsetSec = bounded(0 - west)
  const [dst, afterDst] = readName(spec, afterOffset)
  let dstOffsetSec = 0
  let pos = afterDst
  if (dst !== '') {
    const [dstWest, afterDstOffset] = readOffset(spec, afterDst, true)
    dstOffsetSec = bounded(dstWest === null ? stdOffsetSec + HOUR : 0 - dstWest)
    pos = afterDstOffset
  }
  const [start, afterStart, accepted] = readRule(spec, pos, 0)
  const end = accepted ? readRule(spec, afterStart, 1)[0] : ZERO_RULE
  return new PosixZone(std, stdOffsetSec, dst, dstOffsetSec, start, end)
}
