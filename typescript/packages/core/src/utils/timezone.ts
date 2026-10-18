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
   * the offset in seconds east that a displaced moment started from, so a
   * moved time keeps the side of the change its base was on, and to the
   * later one without it, as GNU date resolves an absolute reading. One no
   * instant shows (the hour skipped when DST starts) is read under the
   * offset in force before the change and so lands forward by the gap,
   * which a caller that must refuse it detects by comparing `parts` of the
   * result against `p`.
   */
  fromWall(p: WallParts, prefer?: number): Date
}

const HOUR = 3600
const DAY_MS = 86_400_000

// Character classes of a POSIX TZ string, ASCII only as in the C locale:
// `ÄBC5` has no name GNU accepts.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'
const QUOTABLE = `${LETTERS}${DIGITS}+-`
const BLANKS = ' \t\n\v\f\r'
const SIGNS = '+-'

// A numeric field holds 16 bits: `65536` reads as 0, `-5` as 65531, and
// anything past 2**64 - 1 as 65535.
const FIELD_SPAN = 0x10000
const FIELD_CEILING = '18446744073709551615'

// GNU prints offsets up to ±24:59:59; the Python twin's tzinfo must stay
// inside a day, so both hosts stop one second short of it.
const OFFSET_LIMIT = 24 * HOUR - 1

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
 * run past a day in either direction (`/-1`, `/25`), as POSIX allows. A
 * rule GNU date refused keeps the fields read of it (see weekdayRule),
 * which may sit outside POSIX's ranges; transitionAt places those where GNU
 * date 9.7 was measured to put them: week 0 counts as 1, a weekday past 6
 * counts on from the Sunday that opens the month's first week, and `J` day
 * 0 is the day before January 1.
 */
export interface TransitionRule {
  kind: 'M' | 'J' | 'D'
  month: number
  week: number
  weekday: number
  day: number
  seconds: number
}

// What a DST zone falls back to when its string names no rule, or only a
// start: DST from 02:00 on the second Sunday of March to 02:00 on the first
// Sunday of November.
const FALLBACK_START: TransitionRule = {
  kind: 'M',
  month: 3,
  week: 2,
  weekday: 0,
  day: 0,
  seconds: 2 * HOUR,
}
const FALLBACK_END: TransitionRule = { ...FALLBACK_START, month: 11, week: 1 }
// A rule GNU never read sits at midnight on January 1; a `J` or `Mm` rule
// whose day or month it refused at midnight on the day before.
const UNREAD_RULE: TransitionRule = { kind: 'D', month: 0, week: 0, weekday: 0, day: 0, seconds: 0 }
const DAY_BEFORE_YEAR: TransitionRule = { ...UNREAD_RULE, kind: 'J' }

// Days in `month` (1 for January) of `year`: day 0 of the next month.
function daysInMonth(year: number, month: number): number {
  return utcFromWall({ year, month, day: 0, hour: 0, minute: 0, second: 0, ms: 0 }).getUTCDate()
}

// Midnight of a calendar day, as a Date read as UTC; `day` may overflow.
function midnightOf(year: number, month: number, day: number): Date {
  return utcFromWall({ year, month, day, hour: 0, minute: 0, second: 0, ms: 0 })
}

/**
 * The day an `Mm.w.d` rule names. POSIX: week 1 holds the first `weekday`
 * of the month and week 5 the last. Measured on GNU date 9.7 beyond that:
 * week 0 reads as 1 and a week past the last occurrence as the last one; a
 * weekday past 6 counts that many days from the Sunday that opens the
 * month's first week (M9.1.7 is 2024-09-08, as September 2024 starts on a
 * Sunday), and a count that runs past the month stays there (M3.5.100 is
 * 2024-06-04). `month` is 1 for January.
 */
function weekdayInMonth(year: number, month: number, week: number, weekday: number): Date {
  const first = midnightOf(year, month - 1, 1)
  const opensOn = first.getUTCDay()
  const offset = weekday <= 6 ? (weekday - opensOn + 7) % 7 : weekday - opensOn
  const last = daysInMonth(year, month) - 1
  // How many of that day the month holds from the first one on: one even
  // when the first already runs past the month.
  const held = 1 + Math.max(0, Math.floor((last - offset) / 7))
  const nth = Math.min(Math.max(week, 1), held)
  return new Date(first.getTime() + (offset + 7 * (nth - 1)) * DAY_MS)
}

/**
 * The day a `Jn` rule names: the `day`-th of a year counted as if February
 * always had 28 days, so `J60` is March 1 in every year; day 0 is December
 * 31 of the year before.
 */
function julianDate(year: number, day: number): Date {
  if (day === 0) return midnightOf(year, 0, 0)
  // 2001 has no February 29, so its calendar is the one J counts in.
  const common = midnightOf(2001, 0, day)
  return midnightOf(year, common.getUTCMonth(), common.getUTCDate())
}

/** The transition's wall-clock moment in `year`, as ms of that wall clock read as UTC. */
export function transitionAt(rule: TransitionRule, year: number): number {
  let day: Date
  if (rule.kind === 'M') day = weekdayInMonth(year, rule.month, rule.week, rule.weekday)
  else if (rule.kind === 'J') day = julianDate(year, rule.day)
  else day = midnightOf(year, 0, 1 + rule.day)
  return day.getTime() + rule.seconds * 1000
}

/**
 * A zone read from a POSIX TZ string with a DST half
 * (`CET-1CEST,M3.5.0,M10.5.0/3`). The two offsets and the two rules decide
 * everything, as measured on GNU date 9.7: both of a year's transitions are
 * laid out in the year the UTC clock reads, the start in standard wall time
 * and the end in DST wall time, and an instant shows the state the latest
 * of them up to it set, or, before either, the state the year ends in, so a
 * southern window wraps the new year and two transitions at one instant
 * leave DST off. The DST half may be nameless with a zero offset, which is
 * what GNU date shows when it cannot read that name.
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
    // The year's two changes in order, an end after a start at the same
    // instant: the latest one passed sets the state, and before either the
    // year's last change still holds from the year before.
    let early: [number, boolean] = [start, true]
    let late: [number, boolean] = [end, false]
    if (end < start) [early, late] = [late, early]
    if (utcMs >= late[0]) return late[1]
    return utcMs >= early[0] ? early[1] : late[1]
  }

  /**
   * When daylight saving time starts and ends in a UTC year, as epoch seconds:
   * the instants the two rules lay out in the year the UTC clock reads, the
   * end first when the window wraps the year and the two equal when it is
   * empty. Mirrors Python's PosixZone.transitions.
   */
  transitions(year: number): [number, number] {
    const start = transitionAt(this.start, year) - this.stdOffsetSec * 1000
    const end = transitionAt(this.end, year) - this.dstOffsetSec * 1000
    return [Math.floor(start / 1000), Math.floor(end / 1000)]
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
    // standard time, the later of the two, which is the one GNU date 9.7
    // picks. A skipped hour reads under standard time, the offset in force
    // before the change.
    if (stdShows && dstShows) return new Date(prefer === this.dstOffsetSec ? asDst : asStd)
    if (dstShows) return new Date(asDst)
    return new Date(asStd)
  }
}

/**
 * When a POSIX TZ zone's daylight saving time starts and ends in a UTC year
 * (see PosixZone.transitions), null for any other zone, whose transitions come
 * from tzdata. Mirrors Python's posix_transitions.
 */
export function posixTransitions(zone: Zone, year: number): [number, number] | null {
  return zone instanceof PosixZone ? zone.transitions(year) : null
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
 * The zone a TZ value names, read as GNU date 9.7 reads it: a leading
 * colon is dropped; an empty value is UTC; a name tzdata knows
 * (`Asia/Hong_Kong`, `UTC`, `EST5EDT`) is that zone; anything else is a
 * POSIX TZ string (`UTC0`, `JST-9`, `<+0530>-5:30`,
 * `CET-1CEST,M3.5.0,M10.5.0/3`), where a bare name with no offset is UTC
 * under that name, which is how GNU date renders `TZ=Bogus/Zone`
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

// Where the run of `chars` starting at `pos` ends.
function spanOf(spec: string, pos: number, chars: string): number {
  while (pos < spec.length && chars.includes(spec.charAt(pos))) pos++
  return pos
}

/**
 * A numeric field of an offset, a rule time or an `M` rule: GNU skips
 * blanks before the digits and takes one sign, then keeps the value in 16
 * bits, so `UTC65559` is -23:00, `UTC--65535` (the offset's sign, then
 * -65535) is +01:00, and `UTC99999999999999999999` reads its hours as
 * 65535. Returns the value and the position after its digits, or null when
 * no digit follows.
 */
function numberField(spec: string, pos: number): [number, number] | null {
  let start = spanOf(spec, pos, BLANKS)
  const negative = spec.startsWith('-', start)
  if (start < spec.length && SIGNS.includes(spec.charAt(start))) start++
  const stop = spanOf(spec, start, DIGITS)
  if (stop === start) return null
  const digits = spec.slice(start, stop).replace(/^0+/, '')
  if (
    digits.length > FIELD_CEILING.length ||
    (digits.length === FIELD_CEILING.length && digits > FIELD_CEILING)
  ) {
    return [FIELD_SPAN - 1, stop]
  }
  let value = 0
  for (const digit of digits) value = (value * 10 + Number(digit)) % FIELD_SPAN
  return [((negative ? -value : value) + FIELD_SPAN) % FIELD_SPAN, stop]
}

/**
 * `hh[:mm[:ss]]`, each a numeric field. A colon with no field after it is
 * left unread, so `UTC5:` is -05:00 followed by `:`. Returns hours, minutes
 * and seconds (0 when absent) and the position after the last field read,
 * or null when there are no hours.
 */
function clockFields(spec: string, pos: number): [[number, number, number], number] | null {
  const hours = numberField(spec, pos)
  if (hours === null) return null
  const fields = [hours[0]]
  pos = hours[1]
  while (fields.length < 3 && spec.startsWith(':', pos)) {
    const more = numberField(spec, pos + 1)
    if (more === null) break
    fields.push(more[0])
    pos = more[1]
  }
  const [hh = 0, mm = 0, ss = 0] = fields
  return [[hh, mm, ss], pos]
}

/**
 * An abbreviation: three or more ASCII letters, or three or more of
 * letters, digits, `+` and `-` between `<` and `>`. Returns the name and the
 * position after it, or null when there is no name GNU accepts there.
 */
function zoneName(spec: string, pos: number): [string, number] | null {
  if (spec.startsWith('<', pos)) {
    const stop = spanOf(spec, pos + 1, QUOTABLE)
    if (stop - pos - 1 < 3 || !spec.startsWith('>', stop)) return null
    return [spec.slice(pos + 1, stop), stop + 1]
  }
  const stop = spanOf(spec, pos, LETTERS)
  if (stop - pos < 3) return null
  return [spec.slice(pos, stop), stop]
}

/**
 * An offset `[+-]hh[:mm[:ss]]`, as seconds east of UTC (POSIX counts west,
 * so `EST5` is -05:00). GNU caps the hours at 24 and the minutes and
 * seconds at 59 (`UTC5:99` is -05:59, `UTC24:30` -24:30). Returns null for
 * the offset when no hours follow the optional sign, and the position after
 * what was read (a sign is read even then).
 */
function utcOffset(spec: string, pos: number): [number | null, number] {
  const west = !spec.startsWith('-', pos)
  if (pos < spec.length && SIGNS.includes(spec.charAt(pos))) pos++
  const clock = clockFields(spec, pos)
  if (clock === null) return [null, pos]
  const [[hours, minutes, seconds], stop] = clock
  const total = Math.min(hours, 24) * HOUR + Math.min(minutes, 59) * 60 + Math.min(seconds, 59)
  return [west ? -total : total, stop]
}

/**
 * The `/time` after a rule's day, which is 02:00 when absent. The time takes
 * a leading `-` and no caps (`/-1`, `/25`, `/3:99`). What GNU 9.7 does with
 * a broken one, measured: `/` at the end of the string is midnight and
 * refused; a `/` with no hours after it is 02:00 (`-02:00` after `/-`),
 * accepted only when a comma or the end follows; any other character after
 * the day is midnight and refused. Returns the rule with its time, the
 * position after it, and whether GNU accepted it.
 */
function ruleTime(
  spec: string,
  pos: number,
  rule: TransitionRule,
): [TransitionRule, number, boolean] {
  if (pos === spec.length || spec[pos] === ',') return [{ ...rule, seconds: 2 * HOUR }, pos, true]
  if (spec[pos] !== '/' || pos + 1 === spec.length) return [rule, pos, false]
  pos++
  const sign = spec[pos] === '-' ? -1 : 1
  if (sign < 0) pos++
  const clock = clockFields(spec, pos)
  let seconds = 2 * HOUR
  if (clock !== null) {
    const [[hours, minutes, secs], stop] = clock
    seconds = hours * HOUR + minutes * 60 + secs
    pos = stop
  }
  const accepted = pos === spec.length || spec[pos] === ','
  return [{ ...rule, seconds: sign * seconds }, pos, accepted]
}

/**
 * The day of a `Jn` (1 to 365) or `n` (0 to 365) rule: plain digits, no
 * blank or sign; one out of range, or none, is refused as day 0. Returns the
 * rule at midnight, the position after the digits, and whether the day was
 * accepted.
 */
function yearDayRule(
  spec: string,
  pos: number,
  kind: 'J' | 'D',
  first: number,
): [TransitionRule, number, boolean] {
  const stop = spanOf(spec, pos, DIGITS)
  const digits = spec.slice(pos, stop).replace(/^0+/, '')
  const day = digits.length <= 3 ? Number(digits) : 1000
  if (stop === pos || day < first || day > 365) return [{ ...UNREAD_RULE, kind }, stop, false]
  return [{ ...UNREAD_RULE, kind, day }, stop, true]
}

/**
 * The `m.w.d` of an `Mm.w.d` rule. A refused rule keeps all three fields as
 * written: `M3.6.3` is the last Wednesday of March, `M3.5.9` the last
 * Tuesday, `M3` the first Sunday. A month outside 1 to 12 gives GNU dates
 * that follow no rule we measured; mirage reads that rule as Julian day 0.
 * Returns the rule at midnight, the position after it, and whether all three
 * fields were in range.
 */
function weekdayRule(spec: string, pos: number): [TransitionRule, number, boolean] {
  const fields: number[] = []
  while (fields.length < 3) {
    if (fields.length > 0 && !spec.startsWith('.', pos)) break
    const got = numberField(spec, pos + (fields.length > 0 ? 1 : 0))
    if (got === null) break
    fields.push(got[0])
    pos = got[1]
  }
  const [month = 0, week = 0, weekday = 0] = fields
  if (month < 1 || month > 12) return [DAY_BEFORE_YEAR, pos, false]
  const rule: TransitionRule = { kind: 'M', month, week, weekday, day: 0, seconds: 0 }
  const accepted = fields.length === 3 && week >= 1 && week <= 5 && weekday <= 6
  return [rule, pos, accepted]
}

/**
 * One rule, `Mm.w.d`, `Jn` or `n`, with its time. Returns the rule, the
 * position after it, and whether GNU accepted it; a refused rule keeps what
 * was read of it.
 */
function dstTransition(spec: string, pos: number): [TransitionRule, number, boolean] {
  const lead = spec.slice(pos, pos + 1)
  let read: [TransitionRule, number, boolean]
  if (lead === 'M') read = weekdayRule(spec, pos + 1)
  else if (lead === 'J') read = yearDayRule(spec, pos + 1, 'J', 1)
  else if (lead !== '' && DIGITS.includes(lead)) read = yearDayRule(spec, pos, 'D', 0)
  else return [UNREAD_RULE, pos, false]
  const [rule, stop, accepted] = read
  if (!accepted) return [rule, stop, false]
  return ruleTime(spec, stop, rule)
}

/**
 * The `,start[,end]` that follows the DST name and offset. With nothing
 * there, or only a comma, both rules fall back; with only a start, the end
 * does. A refused start leaves the end unread, and text other than a comma
 * leaves both unread, which puts DST all year east of UTC
 * (`CET-1CEST,bogus`) and nearly all year west of it.
 */
function dstRules(spec: string, pos: number): [TransitionRule, TransitionRule] {
  if (pos === spec.length || spec.slice(pos) === ',') return [FALLBACK_START, FALLBACK_END]
  if (spec[pos] !== ',') return [UNREAD_RULE, UNREAD_RULE]
  const [start, stop, accepted] = dstTransition(spec, pos + 1)
  if (!accepted) return [start, UNREAD_RULE]
  if (stop + 1 >= spec.length) return [start, FALLBACK_END]
  return [start, dstTransition(spec, stop + 1)[0]]
}

// An offset in seconds east, held to what the Python twin's tzinfo may return.
function clamped(east: number): number {
  return Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, east))
}

/**
 * The zone a POSIX TZ string describes, as GNU 9.7 renders it:
 * `std offset [dst [offset] [,start[/time],end[/time]]]`. No DST name gives
 * a fixed zone, and a DST offset defaults to an hour east of the standard
 * one. A string GNU cannot read keeps what it read: no standard name is UTC
 * with an empty name (`AB5`), no standard offset UTC under the name (`XYZ`,
 * `Bogus/Zone`), and a DST name it cannot read a nameless half at UTC
 * (`EST5x`).
 */
export function posixZone(spec: string): Zone {
  const std = zoneName(spec, 0)
  if (std === null) return new FixedZone(0, '')
  const [stdName, afterName] = std
  const lead = spec.slice(afterName, afterName + 1)
  if (lead === '' || !`${SIGNS}${DIGITS}`.includes(lead)) return new FixedZone(0, stdName)
  const [stdEast, afterOffset] = utcOffset(spec, afterName)
  if (stdEast === null) return new FixedZone(0, stdName)
  if (afterOffset === spec.length) return new FixedZone(clamped(stdEast), stdName)
  let pos = afterOffset
  let dstName = ''
  let dstEast = 0
  const dst = zoneName(spec, pos)
  if (dst !== null) {
    let offset: number | null
    ;[dstName, pos] = dst
    ;[offset, pos] = utcOffset(spec, pos)
    dstEast = offset ?? stdEast + HOUR
  }
  const [start, end] = dstRules(spec, pos)
  return new PosixZone(stdName, clamped(stdEast), dstName, clamped(dstEast), start, end)
}
