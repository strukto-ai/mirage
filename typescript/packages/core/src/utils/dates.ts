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

import {
  LOCAL_ZONE,
  UTC_ZONE,
  posixTransitions,
  resolveTz,
  type WallParts,
  type Zone,
} from './timezone.ts'

/** The UTC day `ts` (epoch milliseconds) falls on, as `YYYY-MM-DD`. */
export function utcDateFolder(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/** UTC ISO text: whole seconds, or six fraction digits, matching Python to_iso_z. */
export function toIsoZ(date: Date): string {
  return date
    .toISOString()
    .replace(/\.(\d{3})Z$/, (_, ms: string) => (ms === '000' ? 'Z' : `.${ms}000Z`))
}

export function nowIso(): string {
  return toIsoZ(new Date())
}

// Truncated to whole seconds, matching Python epoch_to_iso.
export function epochToIso(seconds: number): string {
  return new Date(Math.floor(seconds) * 1000).toISOString().replace('.000Z', 'Z')
}

// Inverse of epochToIso; a naive stamp (no Z/offset, e.g. a `touch -t`
// overlay time) is read as UTC so this matches the Python isoToEpoch. JS
// interprets an offset-less date-time as local, so append Z when absent.
// Truncated to whole seconds to mirror epochToIso.
export function isoToEpoch(iso: string): number {
  const text = /(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`
  return Math.floor(Date.parse(text) / 1000)
}

// A date the user typed, as an epoch second, or null when it is not a date at
// all. Mirrors Python's isoTimestamp: an offset-less stamp is read as UTC and
// anything unparseable is null rather than NaN, so a caller can tell "not a
// date" from "the epoch".
export function isoTimestamp(value: string | null | undefined): number | null {
  if (value === undefined || value === null || value === '') return null
  const text = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? null : ms / 1000
}

function daysInMonth(year: number, month: number): number {
  return UTC_ZONE.fromWall({
    year,
    month: month + 1,
    day: 0,
    hour: 0,
    minute: 0,
    second: 0,
    ms: 0,
  }).getUTCDate()
}

/**
 * The instant `zone` shows `p` at, or null when it shows none: no instant
 * reads the hour skipped when DST starts, and GNU date answers a clock
 * setting for one with `invalid date`. The host's zone is not
 * checked, since the Python twin reads a host-local moment naively and
 * cannot refuse there.
 */
function placeWall(zone: Zone, p: WallParts): Date | null {
  const placed = zone.fromWall(p)
  if (zone === LOCAL_ZONE) return placed
  const shown = zone.parts(placed)
  const kept =
    shown.year === p.year &&
    shown.month === p.month &&
    shown.day === p.day &&
    shown.hour === p.hour &&
    shown.minute === p.minute &&
    shown.second === p.second
  return kept ? placed : null
}

// Whether an epoch-seconds timestamp sits inside an inclusive mtime window.
// An unbounded window keeps everything; an unknown timestamp fails any
// bounded one. Mirrors the Python in_mtime_window.
export function inMtimeWindow(
  timestamp: number | null | undefined,
  mtimeMin: number | null | undefined,
  mtimeMax: number | null | undefined,
): boolean {
  if (mtimeMin == null && mtimeMax == null) return true
  if (timestamp == null) return false
  if (mtimeMin != null && timestamp < mtimeMin) return false
  if (mtimeMax != null && timestamp > mtimeMax) return false
  return true
}

// The moments mirage holds, as Python's datetime does: 0001-01-01 00:00:00 to
// 9999-12-31 23:59:59 UTC.
const FIRST_SECOND = -62135596800
const LAST_SECOND = 253402300799
const DAY = 86400
const NANOS = 1_000_000_000
// date reads each number, and keeps each relative count, in a signed 64-bit
// integer, refusing one that overflows it.
const INT64 = 1n << 63n
// The largest relative total a double holds exactly.
const EXACT = BigInt(Number.MAX_SAFE_INTEGER)

const BLANKS = ' \t\n\v\f\r'
const DIGITS = '0123456789'
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SIGNS = '+-'

const MONTHS = [
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
]
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']

type Meaning = readonly [string, number]

// Longer abbreviations date reads beside the three-letter ones.
const NAMED_DAYS: Record<string, Meaning> = {
  SEPT: ['month', 9],
  TUES: ['weekday', 2],
  WEDNES: ['weekday', 3],
  THUR: ['weekday', 4],
  THURS: ['weekday', 4],
}
// [kind, amount]: a unit counts months, days or seconds.
const UNITS: Record<string, Meaning> = {
  YEAR: ['months', 12],
  MONTH: ['months', 1],
  FORTNIGHT: ['days', 14],
  WEEK: ['days', 7],
  DAY: ['days', 1],
  HOUR: ['seconds', 3600],
  MINUTE: ['seconds', 60],
  MIN: ['seconds', 60],
  SECOND: ['seconds', 1],
  SEC: ['seconds', 1],
}
const DAY_WORDS: Record<string, number> = { TOMORROW: 1, YESTERDAY: -1, TODAY: 0, NOW: 0 }
// "SECOND" is the unit, so the second ordinal has no word.
const ORDINALS: Record<string, number> = {
  LAST: -1,
  THIS: 0,
  NEXT: 1,
  FIRST: 1,
  THIRD: 3,
  FOURTH: 4,
  FIFTH: 5,
  SIXTH: 6,
  SEVENTH: 7,
  EIGHTH: 8,
  NINTH: 9,
  TENTH: 10,
  ELEVENTH: 11,
  TWELFTH: 12,
}
const SUFFIXES: Record<string, number> = { AGO: -1, HENCE: 1 }
const MERIDIANS: Record<string, number> = { AM: 0, 'A.M.': 0, PM: 12, 'P.M.': 12 }
// The zone names date accepts, measured on coreutils 9.7, each at its UTC
// offset in minutes as tzdata and RFC 5322 give it (SST is read at -12:00).
// The second set names daylight time, which takes no "DST" and no offset
// after it. Mirrors the Python tables.
const STANDARD_ZONES: Record<string, number> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  WET: 0,
  WAT: 60,
  CET: 60,
  MET: 60,
  MEZ: 60,
  EET: 120,
  CAT: 120,
  SAST: 120,
  EAT: 180,
  MSK: 180,
  IST: 330,
  SGT: 480,
  KST: 540,
  JST: 540,
  GST: 600,
  NZST: 720,
  ART: -180,
  BRT: -180,
  NST: -210,
  AST: -240,
  CLT: -240,
  EST: -300,
  CST: -360,
  MST: -420,
  PST: -480,
  AKST: -540,
  HST: -600,
  HAST: -600,
  SST: -720,
}
const DAYLIGHT_ZONES: Record<string, number> = {
  WEST: 60,
  BST: 60,
  CEST: 120,
  MEST: 120,
  MESZ: 120,
  EEST: 180,
  MSD: 240,
  NZDT: 780,
  BRST: -120,
  NDT: -150,
  ADT: -180,
  CLST: -180,
  EDT: -240,
  CDT: -300,
  MDT: -360,
  PDT: -420,
  AKDT: -480,
  HADT: -540,
}
// A zone correction reaches a whole day either way.
const ZONE_LIMIT = 24 * 60
const UNIT_KINDS = ['months', 'days', 'seconds']
// Names the zone's own abbreviations never stand in for.
const FIXED_NAMES = ['GMT', 'UT', 'UTC']

/** A date expression date would answer with `invalid date`. */
class NotADate extends Error {}

/**
 * One lexeme of a date expression. A number keeps its digits as typed, the
 * sign that led it ('' for none) and, after a `.` or `,`, its fraction in
 * nanoseconds; a word is upper-cased, dots kept; anything else is a single
 * character.
 */
interface Token {
  kind: 'number' | 'word' | 'char'
  text: string
  sign: string
  value: number
  nanos: number | null
}

// Minutes east of UTC for a military zone letter, J excluded.
function military(letter: string): number {
  if (letter === 'Z') return 0
  const at = letter.charCodeAt(0) - 65
  if (letter < 'J') return (at + 1) * 60
  if (letter < 'N') return at * 60
  return -(at - 12) * 60
}

/**
 * What an upper-cased word names, as [kind, value]: `meridian` (hours to
 * add), `month` (1-12), `weekday` (0 is Sunday), `dst`, a unit
 * (`months`/`days`/`seconds` with its size), `today` (and its neighbours, in
 * days), `ordinal`, `suffix` (ago, hence), `zone` and `daylight` (minutes
 * east) and `local` (J, the zone the expression is read in). Words are
 * upper-cased, so no lookup reaches a name Object.prototype holds.
 */
function meaning(word: string): Meaning | null {
  const meridian = MERIDIANS[word]
  if (meridian !== undefined) return ['meridian', meridian]
  if (MONTHS.includes(word)) return ['month', MONTHS.indexOf(word) + 1]
  if (WEEKDAYS.includes(word)) return ['weekday', WEEKDAYS.indexOf(word)]
  const named = NAMED_DAYS[word]
  if (named !== undefined) return named
  const short = word.length === 3 || (word.length === 4 && word[3] === '.') ? word.slice(0, 3) : ''
  if (/^[A-Z]{3}$/.test(short)) {
    const month = MONTHS.findIndex((name) => name.startsWith(short))
    if (month >= 0) return ['month', month + 1]
    const weekday = WEEKDAYS.findIndex((name) => name.startsWith(short))
    if (weekday >= 0) return ['weekday', weekday]
  }
  if (word === 'DST') return ['dst', 0]
  for (const unit of [word, word.endsWith('S') ? word.slice(0, -1) : '']) {
    const found = UNITS[unit]
    if (found !== undefined) return found
  }
  const today = DAY_WORDS[word]
  if (today !== undefined) return ['today', today]
  const ordinal = ORDINALS[word]
  if (ordinal !== undefined) return ['ordinal', ordinal]
  const suffix = SUFFIXES[word]
  if (suffix !== undefined) return ['suffix', suffix]
  const bare = word.replaceAll('.', '')
  const standard = STANDARD_ZONES[bare]
  if (standard !== undefined && bare.length > 1) return ['zone', standard]
  const daylight = DAYLIGHT_ZONES[bare]
  if (daylight !== undefined) return ['daylight', daylight]
  if (word.length === 1) return word === 'J' ? ['local', 0] : ['zone', military(word)]
  return null
}

function bareToken(kind: Token['kind'], text: string): Token {
  return { kind, text, sign: '', value: 0, nanos: null }
}

// The kind and size of a unit word the parser looked at.
function unit(token: Token): Meaning {
  const found = meaning(token.text)
  if (found === null) throw new NotADate()
  return found
}

// The number whose digits start at `at`, and where it ends.
function lexNumber(text: string, at: number, sign: string): [Token, number] {
  let stop = at
  while (stop < text.length && DIGITS.includes(text.charAt(stop))) stop++
  const digits = text.slice(at, stop)
  let nanos: number | null = null
  if (
    stop + 1 < text.length &&
    '.,'.includes(text.charAt(stop)) &&
    DIGITS.includes(text.charAt(stop + 1))
  ) {
    let end = stop + 1
    while (end < text.length && DIGITS.includes(text.charAt(end))) end++
    const fraction = text.slice(stop + 1, end)
    // Nanoseconds are all date keeps; further digits are dropped, though a
    // negative number's nonzero ones still take it one nanosecond further
    // down.
    nanos = Number(fraction.slice(0, 9).padEnd(9, '0'))
    if (sign === '-' && /[1-9]/.test(fraction.slice(9))) nanos++
    stop = end
  }
  const size = Number(digits)
  if (BigInt(digits) >= INT64) throw new NotADate()
  return [{ kind: 'number', text: digits, sign, value: sign === '-' ? -size : size, nanos }, stop]
}

/**
 * Split a date expression into tokens. White space and parenthesized
 * comments (which nest, and run to the end when unclosed) separate tokens. A
 * run of signs and blanks before digits signs the number with its last sign;
 * one before anything else is dropped.
 */
function lex(text: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < text.length) {
    const c = text.charAt(at)
    if (BLANKS.includes(c)) {
      at++
    } else if (c === '(') {
      let depth = 0
      while (at < text.length) {
        const here = text.charAt(at)
        depth += here === '(' ? 1 : here === ')' ? -1 : 0
        at++
        if (depth === 0) break
      }
    } else if (SIGNS.includes(c)) {
      let sign = c
      let probe = at + 1
      while (probe < text.length && (SIGNS + BLANKS).includes(text.charAt(probe))) {
        if (SIGNS.includes(text.charAt(probe))) sign = text.charAt(probe)
        probe++
      }
      if (probe < text.length && DIGITS.includes(text.charAt(probe))) {
        const [token, end] = lexNumber(text, probe, sign)
        tokens.push(token)
        at = end
      } else {
        at = probe
      }
    } else if (DIGITS.includes(c)) {
      const [token, end] = lexNumber(text, at, '')
      tokens.push(token)
      at = end
    } else if (LETTERS.includes(c)) {
      let stop = at
      while (
        stop < text.length &&
        (LETTERS.includes(text.charAt(stop)) || text.charAt(stop) === '.')
      )
        stop++
      tokens.push(bareToken('word', text.slice(at, stop).toUpperCase()))
      at = stop
    } else {
      tokens.push(bareToken('char', c))
      at++
    }
  }
  return tokens
}

// A year as typed: two digits are 1969-2068, any other count is literal.
function yearOf(token: Token): number {
  const year = Math.abs(token.value)
  if (token.text.length === 2) return year + (year < 69 ? 2000 : 1900)
  return year
}

/**
 * What a date expression names, before it is placed in time. `date` is
 * [year, month, day] with no year until one is given; `clock` is [hour,
 * minute, second, nanos]; `zone` is seconds east, null with `zoned` set for J
 * or a name of the zone the expression is read in, which sets `named`, and
 * `dst` to whether it names daylight time (null for a name both seasons
 * use); `weekday` is [ordinal, day]; the relative
 * items sum into `months`, `days`, `seconds` and `nanos`, the fractions of a
 * second.
 */
interface Reading {
  date: [number | null, number, number] | null
  clock: [number, number, number, number] | null
  zone: number | null
  zoned: boolean
  named: boolean
  dst: boolean | null
  weekday: [number, number] | null
  months: bigint
  days: bigint
  seconds: bigint
  nanos: number
  counts: Map<string, bigint>
  relative: boolean
  epoch: [number, number] | null
}

/**
 * Reads the items of a tokenized date expression into a Reading. Each date,
 * time of day, zone and day of the week may appear once; relative items add
 * up. Every refusal throws NotADate.
 */
class Parser {
  private at = 0
  // Where the last ISO date ended, for the "T" that may follow it.
  private isoEnd = -1
  readonly reading: Reading = {
    date: null,
    clock: null,
    zone: null,
    zoned: false,
    named: false,
    dst: null,
    weekday: null,
    months: 0n,
    days: 0n,
    seconds: 0n,
    nanos: 0,
    counts: new Map(),
    relative: false,
    epoch: null,
  }

  constructor(
    private readonly tokens: Token[],
    private readonly names: ReadonlyMap<string, boolean | null>,
  ) {}

  private peek(ahead = 0): Token | null {
    return this.tokens[this.at + ahead] ?? null
  }

  private take(): Token {
    const token = this.peek()
    if (token === null) throw new NotADate()
    this.at++
    return token
  }

  /**
   * What a word names: a month, a weekday or a meridian, then the zone's own
   * abbreviations, then every other word. One of the zone's names, dots
   * dropped, is a `named` zone, 1 for daylight time and -1 for a name both
   * seasons use; GMT, UT and UTC keep their fixed meaning even where the zone
   * uses them.
   */
  private mean(token: Token): Meaning | null {
    const found = meaning(token.text)
    if (found !== null && ['meridian', 'month', 'weekday'].includes(found[0])) return found
    const bare = token.text.replaceAll('.', '')
    const named = this.names.get(bare)
    if (named !== undefined && !FIXED_NAMES.includes(bare)) {
      return ['named', named === null ? -1 : named ? 1 : 0]
    }
    return found
  }

  // The kind of the token `ahead`: a word's meaning, else its own.
  private kind(ahead = 0): string | null {
    const token = this.peek(ahead)
    if (token === null) return null
    if (token.kind === 'word') return this.mean(token)?.[0] ?? null
    return token.kind
  }

  // The value of a word whose kind was looked at.
  private value(token: Token): number {
    const found = this.mean(token)
    if (found === null) throw new NotADate()
    return found[1]
  }

  private char(c: string, ahead = 0): boolean {
    const token = this.peek(ahead)
    return token !== null && token.kind === 'char' && token.text === c
  }

  // Whether the token `ahead` is a whole number with no sign.
  private plain(ahead = 0): boolean {
    const token = this.peek(ahead)
    return token !== null && token.kind === 'number' && token.sign === '' && token.nanos === null
  }

  // Whether the token `ahead` is a whole number `-` signs.
  private minus(ahead = 0): boolean {
    const token = this.peek(ahead)
    return token !== null && token.kind === 'number' && token.sign === '-' && token.nanos === null
  }

  // Whether the token `ahead` is a signed whole number: a signed fraction is
  // never a zone correction, only seconds.
  private signed(ahead = 0): boolean {
    const token = this.peek(ahead)
    return token !== null && token.kind === 'number' && token.sign !== '' && token.nanos === null
  }

  private unit(ahead = 0): boolean {
    return UNIT_KINDS.includes(this.kind(ahead) ?? '')
  }

  // Take a whole number with no sign.
  private whole(): Token {
    if (!this.plain()) throw new NotADate()
    return this.take()
  }

  parse(): Reading {
    if (this.char('@')) {
      this.take()
      const stamp = this.take()
      if (stamp.kind !== 'number' || this.peek() !== null) throw new NotADate()
      const big = BigInt(NANOS)
      const size = BigInt(stamp.text) * big + BigInt(stamp.nanos ?? 0)
      const signed = stamp.sign === '-' ? -size : size
      const seconds = signed >= 0n ? signed / big : -((-signed + big - 1n) / big)
      this.reading.epoch = [Number(seconds), Number(signed - seconds * big)]
      return this.reading
    }
    while (this.peek() !== null) this.item()
    return this.reading
  }

  private item(): void {
    const token = this.take()
    if (token.kind === 'number') {
      this.number(token)
      return
    }
    const found = token.kind === 'word' ? this.mean(token) : null
    if (found === null) throw new NotADate()
    const [kind, value] = found
    if (kind === 'month') {
      this.month(value)
    } else if (kind === 'weekday') {
      this.setWeekday(0, value)
      // Only a bare weekday takes a comma after it.
      if (this.char(',')) this.take()
    } else if (kind === 'ordinal') {
      if (this.kind() === 'weekday') this.setWeekday(value, this.value(this.take()))
      else if (this.unit()) this.relative(BigInt(value))
      else throw new NotADate()
    } else if (UNIT_KINDS.includes(kind)) {
      this.add(kind, value, 1n)
    } else if (kind === 'today') {
      this.tally('days', 1, BigInt(value))
    } else if (kind === 'zone' && token.text === 'T' && this.isoEnd === this.at - 1) {
      // A time of day: H:M[:S], or an hour that a zone correction must follow.
      if (this.plain() && this.char(':', 1)) {
        this.clock(this.take(), false)
      } else if (this.plain() && this.signed(1)) {
        this.setClock(this.take().value, 0, 0, 0)
        this.setZone(this.zoneNumber(this.take()))
      } else {
        throw new NotADate()
      }
    } else if (kind === 'zone') {
      this.zone(value * 60)
    } else if (kind === 'daylight') {
      this.setZone(value * 60)
    } else if (kind === 'local') {
      this.setZone(null)
    } else if (kind === 'named') {
      let dst = value < 0 ? null : value === 1
      if (this.kind() === 'dst') {
        this.take()
        dst = true
      }
      this.setZone(null)
      this.reading.named = true
      this.reading.dst = dst
    } else {
      throw new NotADate()
    }
  }

  // A standard zone, then DST, an offset, or a relative item of its own.
  private zone(base: number): void {
    let offset = base
    if (this.kind() === 'dst') {
      this.take()
      offset += 3600
    } else if (this.signedZone()) {
      offset += this.zoneNumber(this.take())
    } else if (this.signed() && this.unit(1)) {
      // `UTC +1 day` is the zone and a relative item, which then takes no
      // `ago`.
      this.setZone(offset)
      const count = this.take()
      const [kind, size] = unit(this.take())
      this.add(kind, size, BigInt(count.sign + count.text), false)
      return
    }
    this.setZone(offset)
  }

  private number(token: Token): void {
    if (token.nanos !== null) {
      this.fraction(token)
    } else if (token.sign !== '') {
      if (!this.unit()) throw new NotADate()
      this.relative(BigInt(token.sign + token.text))
    } else if (this.char(':')) {
      this.clock(token, true)
    } else if (this.char('/')) {
      this.slashed(token)
    } else if (this.minus() && this.minus(1)) {
      this.iso(token)
    } else if (this.kind() === 'month') {
      this.dayMonth(token)
    } else if (this.unit()) {
      this.relative(BigInt(token.text))
    } else if (this.kind() === 'weekday') {
      this.setWeekday(token.value, this.value(this.take()))
    } else if (this.kind() === 'meridian') {
      this.setClock(this.meridian(token.value, this.value(this.take())), 0, 0, 0)
    } else {
      this.pure(token)
    }
  }

  /**
   * A number standing alone: a year, a date, or a time of day. One a zone
   * correction follows is an hour, whatever its digits, and no signed number
   * may follow a ±HHMM correction there (one may follow ±H:M). Otherwise,
   * after a date with no year and before any relative item, it is the year,
   * when a time of day came first or it has three digits or more; five digits
   * or more are [YY]YYMMDD and fewer are HH or HHMM.
   */
  private pure(token: Token): void {
    const reading = this.reading
    const digits = token.text.length
    const value = token.value
    const date = reading.date
    if (this.signedZone()) {
      const colon = this.char(':', 1) && this.plain(2)
      this.setClock(value, 0, 0, 0)
      this.setZone(this.zoneNumber(this.take()))
      if (!colon && this.signed()) throw new NotADate()
    } else if (
      date !== null &&
      date[0] === null &&
      !reading.relative &&
      (reading.clock !== null || digits > 2)
    ) {
      reading.date = [yearOf(token), date[1], date[2]]
    } else if (digits > 4) {
      let year = Math.floor(value / 10000)
      if (digits === 6) year += year < 69 ? 2000 : 1900
      this.setDate(year, Math.floor(value / 100) % 100, value % 100)
    } else if (digits <= 2) {
      this.setClock(value, 0, 0, 0)
    } else {
      this.setClock(Math.floor(value / 100), value % 100, 0, 0)
    }
  }

  // H:M[:S[.frac]], then a meridian or a zone correction.
  private clock(hour: Token, meridian: boolean): void {
    this.take()
    const minute = this.whole().value
    let second = 0
    let nanos = 0
    if (this.char(':')) {
      this.take()
      const token = this.take()
      if (token.kind !== 'number' || token.sign !== '') throw new NotADate()
      second = token.value
      nanos = token.nanos ?? 0
    }
    if (meridian && this.kind() === 'meridian') {
      this.setClock(this.meridian(hour.value, this.value(this.take())), minute, second, nanos)
      return
    }
    this.setClock(hour.value, minute, second, nanos)
    if (this.signed()) this.setZone(this.zoneNumber(this.take()))
  }

  // M/D, M/D/Y or, four digits leading, Y/M/D.
  private slashed(first: Token): void {
    this.take()
    const second = this.whole()
    let third: Token | null = null
    if (this.char('/')) {
      this.take()
      third = this.whole()
    }
    if (first.text.length >= 4) {
      if (third === null) throw new NotADate()
      this.setDate(first.value, second.value, third.value)
    } else {
      this.setDate(third === null ? null : yearOf(third), first.value, second.value)
    }
  }

  // Y-M-D, read as the year and two `-` signed numbers.
  private iso(year: Token): void {
    const month = this.take()
    const day = this.take()
    this.setDate(yearOf(year), -month.value, -day.value)
    this.isoEnd = this.at
  }

  // D [-]MONTH [Y]: a number after the month is its year.
  private dayMonth(day: Token): void {
    const month = this.value(this.take())
    let year: number | null = null
    if (this.plain() || this.minus()) year = yearOf(this.take())
    this.setDate(year, month, day.value)
  }

  // MONTH D[, Y] or MONTH -D -Y.
  private month(month: number): void {
    if (this.plain()) {
      const day = this.take().value
      let year: number | null = null
      if (this.char(',')) {
        this.take()
        year = yearOf(this.whole())
      }
      this.setDate(year, month, day)
    } else if (this.minus() && this.minus(1)) {
      const day = this.take()
      const year = this.take()
      this.setDate(yearOf(year), month, -day.value)
    } else {
      throw new NotADate()
    }
  }

  // N.F SECONDS [ago|hence]: only seconds take a fraction.
  private fraction(token: Token): void {
    if (this.kind() !== 'seconds' || this.value(this.take()) !== 1) throw new NotADate()
    let times = token.sign === '-' ? -1 : 1
    if (this.kind() === 'suffix') times *= this.value(this.take())
    this.tally('seconds', 1, BigInt(times) * BigInt(token.text))
    this.reading.nanos += times * (token.nanos ?? 0)
  }

  // count UNIT [ago|hence], the unit next.
  private relative(count: bigint): void {
    const [kind, size] = unit(this.take())
    this.add(kind, size, count)
  }

  private add(kind: string, size: number, count: bigint, suffix = true): void {
    let times = count
    if (suffix && this.kind() === 'suffix') times *= BigInt(this.value(this.take()))
    this.tally(kind, size, times)
  }

  // Add `count` units of `size` to the relative `kind`, each unit counted on
  // its own, a week's and a fortnight's as days.
  private tally(kind: string, size: number, count: bigint): void {
    let [step, times] = [BigInt(size), count]
    if (kind === 'days') [step, times] = [1n, count * step]
    const reading = this.reading
    const key = `${kind} ${String(step)}`
    const total = (reading.counts.get(key) ?? 0n) + times
    if (times < -INT64 || times >= INT64 || total < -INT64 || total >= INT64) throw new NotADate()
    reading.counts.set(key, total)
    if (kind === 'months') reading.months += step * times
    else if (kind === 'days') reading.days += step * times
    else reading.seconds += step * times
    reading.relative = true
  }

  // Whether a signed number comes next that is no relative item's.
  private signedZone(): boolean {
    return this.signed() && !this.unit(1)
  }

  // A zone correction in seconds east: ±H and ±HH are hours, a longer number
  // hours and minutes as ±HHMM reads, its leading zeros aside, and ±H:M takes
  // any count of minutes.
  private zoneNumber(token: Token): number {
    if (token.nanos !== null) throw new NotADate()
    const size = Math.abs(token.value)
    let minutes: number
    if (this.char(':') && this.plain(1)) {
      this.take()
      minutes = size * 60 + this.take().value
    } else if (token.text.length <= 2) {
      minutes = size * 60
    } else {
      minutes = Math.floor(size / 100) * 60 + (size % 100)
    }
    if (minutes > ZONE_LIMIT) throw new NotADate()
    return (token.sign === '-' ? -minutes : minutes) * 60
  }

  private meridian(hour: number, add: number): number {
    if (hour < 1 || hour > 12) throw new NotADate()
    return (hour % 12) + add
  }

  private setDate(year: number | null, month: number, day: number): void {
    if (this.reading.date !== null) throw new NotADate()
    this.reading.date = [year, month, day]
  }

  private setClock(hour: number, minute: number, second: number, nanos: number): void {
    if (this.reading.clock !== null) throw new NotADate()
    this.reading.clock = [hour, minute, second, nanos]
  }

  private setZone(offset: number | null): void {
    if (this.reading.zoned) throw new NotADate()
    this.reading.zoned = true
    this.reading.zone = offset
  }

  private setWeekday(ordinal: number, day: number): void {
    if (this.reading.weekday !== null) throw new NotADate()
    this.reading.weekday = [ordinal, day]
  }
}

/**
 * Days from 1970-01-01 to a proleptic Gregorian date. A month past 12 or below
 * 1 carries into the year, and a day past the month's end into the months
 * after, as a calendar shift needs.
 */
function civilDays(year: number, month: number, day: number): number {
  const y = year + Math.floor((month - 1) / 12)
  const m = ((((month - 1) % 12) + 12) % 12) + 1
  // Counted from March, so February's leap day ends the year.
  const shifted = y - (m <= 2 ? 1 : 0)
  const march = m <= 2 ? m + 9 : m - 3
  const days =
    365 * shifted + Math.floor(shifted / 4) - Math.floor(shifted / 100) + Math.floor(shifted / 400)
  return days + Math.floor((153 * march + 2) / 5) + day - 1 - 719468
}

// The calendar fields of wall-clock seconds read as UTC.
function wallFields(wall: number): [number, number, number, number, number, number] {
  const shown = new Date(wall * 1000)
  return [
    shown.getUTCFullYear(),
    shown.getUTCMonth() + 1,
    shown.getUTCDate(),
    shown.getUTCHours(),
    shown.getUTCMinutes(),
    shown.getUTCSeconds(),
  ]
}

/** The UTC offsets a zone shows. Mirrors Python's _Clock. */
class Clock {
  constructor(private readonly zone: Zone) {}

  // Clamped a few days inside what mirage holds, so a far moment reads as the
  // nearest one it does.
  private at(instant: number): Date {
    const kept = Math.min(Math.max(instant, FIRST_SECOND + 2 * DAY), LAST_SECOND - 2 * DAY)
    return new Date((Number.isFinite(kept) ? kept : 0) * 1000)
  }

  offset(instant: number): number {
    return this.zone.parts(this.at(instant)).offsetSec
  }

  abbreviation(instant: number): string {
    return this.zone.parts(this.at(instant)).abbrev.toUpperCase()
  }

  /**
   * Whether an instant is in daylight time: ahead of the lesser of the
   * offsets its year shows on January 1 and July 1, or behind the offsets of
   * both the January 1 or July 1 before it and the one after, as Ramadan's
   * hour back in Casablanca is.
   */
  isdst(instant: number): boolean {
    const year = wallFields(Math.min(Math.max(instant, FIRST_SECOND), LAST_SECOND))[0]
    const winter = this.offset(civilDays(year, 1, 1) * DAY)
    const july = civilDays(year, 7, 1) * DAY
    const summer = this.offset(july)
    const shown = this.offset(instant)
    if (shown > Math.min(winter, summer)) return true
    const [before, after] =
      instant < july ? [winter, summer] : [summer, this.offset(civilDays(year + 1, 1, 1) * DAY)]
    return shown < before && shown < after
  }

  // The abbreviations the zone shows now and 90, 180 and 270 days on, the
  // instants date reads its names at, each with whether it names daylight
  // time, null for one both seasons use.
  names(now: number): Map<string, boolean | null> {
    const found = new Map<string, boolean | null>()
    for (let step = 0; step < 4; step++) {
      const instant = Math.min(now + step * 90 * DAY, LAST_SECOND)
      const name = this.abbreviation(instant)
      const dst = this.isdst(instant)
      const known = found.get(name)
      found.set(name, known === undefined || known === dst ? dst : null)
    }
    return found
  }

  // When a POSIX rule changes the clock in `wall`'s year; none for a zone from
  // tzdata.
  ruleChanges(wall: number): readonly number[] {
    const year = wallFields(Math.min(Math.max(wall, FIRST_SECOND), LAST_SECOND))[0]
    return posixTransitions(this.zone, year) ?? []
  }

  /**
   * The instants this zone's clock reads `wall` at: one, two in an hour
   * repeated when DST ends, none in one skipped when it starts.
   */
  readings(wall: number): number[] {
    const offsets = new Set([this.offset(wall - DAY), this.offset(wall + DAY)])
    // A POSIX rule's daylight time can be shorter than a day.
    for (const change of this.ruleChanges(wall)) offsets.add(this.offset(change))
    return [...offsets]
      .filter((offset) => this.offset(wall - offset) === offset)
      .map((offset) => wall - offset)
      .sort((a, b) => a - b)
  }

  /**
   * The instant this zone's clock reads `wall` at. The search starts under
   * `guess`, so a reading the clock shows twice takes the side of the change
   * whose offset `guess` is. One it never shows is read under the offset
   * before the change.
   */
  place(wall: number, guess: number): number {
    let instant = wall - guess
    for (let step = 0; step < 2; step++) {
      const shown = this.offset(instant)
      if (this.offset(wall - shown) === shown) return wall - shown
      instant = wall - shown
    }
    return wall - this.offset(wall - DAY)
  }

  /**
   * The instant a wall clock the expression names reads at, null when the
   * clock never reads it (or not in the daylight state `dst` asks for).
   */
  settle(wall: number, guess: number, dst: boolean | null): number | null {
    const shown = this.readings(wall).filter((t) => dst === null || this.isdst(t) === dst)
    if (shown.length === 2) {
      const placed = this.place(wall, guess)
      return shown.includes(placed) ? placed : (shown[1] ?? null)
    }
    return shown[0] ?? null
  }

  /**
   * The instant a moved wall clock reads at, kept in daylight state `dst`: a
   * reading in another state, or none, is read under the offset of the
   * nearest time in that state.
   */
  keepState(wall: number, dst: boolean, guess: number): number {
    const shown = this.readings(wall).filter((t) => this.isdst(t) === dst)
    if (shown.length === 2) return this.place(wall, guess)
    const only = shown[0]
    if (only !== undefined) return only
    // A POSIX rule's daylight time can be shorter than any step.
    for (const change of this.ruleChanges(wall)) {
      if (this.isdst(change) === dst) return wall - this.offset(change)
    }
    for (let step = 1; step < 14; step++) {
      for (const instant of [wall - step * 30 * DAY, wall + step * 30 * DAY]) {
        if (this.isdst(instant) === dst) return wall - this.offset(instant)
      }
    }
    return this.place(wall, guess)
  }
}

// The remainder of `n` by 7, from 0 to 6 even when `n` is negative.
function mod7(n: number): number {
  return ((n % 7) + 7) % 7
}

/**
 * Days from a weekday to the `ordinal`-th `day` from it. Ordinal 0 is that
 * day this week, today included; a positive one counts occurrences after
 * today; -1 is the last one before it.
 */
function weekdayShift(base: number, ordinal: number, day: number): number {
  const ahead = mod7(day - base)
  if (ordinal > 0) return (ahead || 7) + 7 * (ordinal - 1)
  if (ordinal === 0) return ahead
  return -(mod7(base - day) || 7) + 7 * (ordinal + 1)
}

/**
 * Place a reading in time, as [epoch seconds, nanoseconds]. A field left out
 * comes from now on the zone's clock, and the time of day is midnight unless
 * only relative items (and a zone) were given. The wall clock named must
 * exist on the zone's clock, a skipped hour refused and a repeated one read on
 * now's side, unless a zone given reads it. A
 * weekday moves the date, then days, months and years move it on the
 * calendar, read from the side of any change the base was on; the zone and
 * the hours, minutes and seconds then move the instant. A shift keeps the
 * daylight state a name of the zone gives, and a shift of now's own clock
 * now's, as date's does. `guess` is the offset a repeated wall clock is first read
 * under: now's, in the zone the command runs in even when `TZ="..."` names
 * another. Mirrors Python's _resolve.
 */
function resolve(
  reading: Reading,
  clock: Clock,
  now: number,
  nowNanos: number,
  guess: number,
): [number, number] | null {
  if (reading.epoch !== null) return reading.epoch
  // A total past what a double holds exactly lands past the years mirage
  // holds unless another unit's cancels it, which mirage refuses rather than
  // round; Python's integers keep it exact.
  const [months, shift, seconds] = [reading.months, reading.days, reading.seconds].map((total) => {
    if (total > EXACT || total < -EXACT) throw new NotADate()
    return Number(total)
  }) as [number, number, number]
  const here = clock.offset(now)
  let [year, month, day, hour, minute, second] = wallFields(now + here)
  let nanos = nowNanos
  const fromNow =
    reading.relative && reading.date === null && reading.clock === null && reading.weekday === null
  if (reading.date !== null) {
    const [given, m, d] = reading.date
    month = m
    day = d
    if (given !== null) year = given
  }
  if (reading.clock !== null) {
    ;[hour, minute, second, nanos] = reading.clock
  } else if (!fromNow) {
    hour = 0
    minute = 0
    second = 0
    nanos = 0
  }
  if (month < 1 || month > 12) return null
  const monthDays = civilDays(year, month + 1, 1) - civilDays(year, month, 1)
  if (day < 1 || day > monthDays) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  let days = civilDays(year, month, day)
  const within = hour * 3600 + minute * 60 + second
  const state = reading.dst ?? clock.isdst(now)
  let instant: number
  if (reading.zone !== null) {
    // A zone given reads the wall clock as its own, whether or not the
    // zone's clock shows it.
    instant = days * DAY + within - reading.zone
  } else if (fromNow && reading.dst === null) {
    instant = now
  } else {
    // A shift of now's wall clock starts in the daylight state the zone name
    // asks for.
    const settled = clock.settle(days * DAY + within, guess, reading.dst)
    if (settled === null) return null
    instant = settled
  }
  let moving = shift !== 0 || months !== 0
  if (reading.weekday !== null && reading.date === null) {
    days += weekdayShift(mod7(days + 4), ...reading.weekday)
    ;[year, month, day] = wallFields(days * DAY)
    moving = true
  }
  if (moving) {
    const wall = (civilDays(year, month + months, day) + shift) * DAY + within
    // A shifted wall clock past what a double holds exactly is refused too,
    // rather than rounded.
    if (!Number.isSafeInteger(wall)) throw new NotADate()
    // A name both seasons use places the shift where it lands.
    instant =
      reading.dst !== null || (fromNow && !reading.named)
        ? clock.keepState(wall, state, guess)
        : clock.place(wall, clock.offset(instant))
    if (reading.zone !== null) instant += clock.offset(instant) - reading.zone
  }
  const total = nanos + reading.nanos
  const carry = Math.floor(total / NANOS)
  return [instant + seconds + carry, total - carry * NANOS]
}

/**
 * A leading `TZ="..."` and the rest, or no zone and the text. Inside the
 * quotes a backslash escapes a backslash or a quote, and nothing else.
 */
function splitZone(text: string): [string | null, string] {
  let start = 0
  while (start < text.length && BLANKS.includes(text.charAt(start))) start++
  const lead = text.slice(start)
  if (!lead.startsWith('TZ="')) return [null, text]
  let value = ''
  let at = 4
  while (at < lead.length) {
    let c = lead.charAt(at)
    if (c === '"') return [value, lead.slice(at + 1)]
    if (c === '\\') {
      const escaped = lead.charAt(at + 1)
      if (escaped !== '\\' && escaped !== '"') throw new NotADate()
      c = escaped
      at++
    }
    value += c
    at++
  }
  throw new NotADate()
}

/**
 * Parse a free-form date expression as `date -d` reads it, or null for date's
 * `invalid date`. The grammar is coreutils 9.7's as measured on
 * debian:stable-slim: calendar dates (`2026-01-15`, `1/15/26`, `15 Jan 2026`,
 * `Jan 15, 2026`, `20260115`), times of day (`10:30:45.5`, `9pm`) with zone
 * corrections (`+05:30`), zone names (`UTC`, `EST DST`, `UTC+3`, military
 * letters), days of the week (`next monday`), relative items (`2 days ago`,
 * `tomorrow`), `@epoch` and a leading `TZ="zone"`, with parenthesized
 * comments ignored. Mirage also refuses a moment outside years 1-9999, which
 * date shows. Mirrors Python's parse_date_expr.
 */
export function parseDateExpr(text: string, zone: Zone, now?: Date): Date | null {
  try {
    const [inner, rest] = splitZone(text)
    const ms = (now ?? new Date()).getTime()
    const current = Math.floor(ms / 1000)
    const currentNanos = (ms - current * 1000) * 1_000_000
    const outer = new Clock(zone)
    const clock = inner === null ? outer : new Clock(resolveTz(inner))
    const reading = new Parser(lex(rest), clock.names(current)).parse()
    const placed = resolve(reading, clock, current, currentNanos, outer.offset(current))
    if (placed === null) return null
    const [instant, nanos] = placed
    if (!(instant >= FIRST_SECOND && instant <= LAST_SECOND)) return null
    const shown = zone.parts(new Date(instant * 1000)).year
    if (shown < 1 || shown > 9999) return null
    return new Date(instant * 1000 + Math.floor(nanos / 1_000_000))
  } catch (err) {
    if (err instanceof NotADate || err instanceof RangeError) return null
    throw err
  }
}

const POSIX_TIME_RE = /^([0-9]{8}|[0-9]{10}|[0-9]{12})(?:\.([0-9]{2}))?$/

// As GNU date reads it, measured on coreutils 9.7: no year is this year, a
// two-digit one is 2000-2068 up to 68 and 1969-1999 from 69, and `.ss` takes
// exactly two digits. A field out of range (`1301000024`,
// `01012500`) is not a date, nor is a wall clock the zone skips; second 60 is
// the next minute's first, as mktime reads a leap second. One divergence: GNU
// shows year 0 and year 10000, where mirage holds what Python's datetime
// holds, so a year 0 operand, a UTC moment outside years 1-9999 and the leap
// second after 9999-12-31 23:59:59 are not a date either. Mirrors the Python
// parse_posix_time.
export function parsePosixTime(text: string, zone: Zone, now?: Date): Date | null {
  const m = POSIX_TIME_RE.exec(text)
  if (m === null) return null
  const digits = m[1] ?? ''
  const pair = (at: number): number => Number(digits.slice(at, at + 2))
  const month = pair(0) - 1
  const day = pair(2)
  const hour = pair(4)
  const minute = pair(6)
  const tail = digits.slice(8)
  let year: number
  if (tail === '') year = zone.parts(now ?? new Date()).year
  else if (tail.length === 2) year = Number(tail) + (Number(tail) <= 68 ? 2000 : 1900)
  else year = Number(tail)
  const second = m[2] !== undefined ? Number(m[2]) : 0
  if (
    year < 1 ||
    month < 0 ||
    month > 11 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 60
  )
    return null
  const leap = second === 60
  const placed = placeWall(zone, {
    year,
    month,
    day,
    hour,
    minute,
    second: leap ? 59 : second,
    ms: 0,
  })
  if (placed === null) return null
  const first = placed.getTime() / 1000
  if (first < FIRST_SECOND || first + (leap ? 1 : 0) > LAST_SECOND) return null
  if (!leap) return placed
  if (year === 9999 && month === 11 && day === 31 && hour === 23 && minute === 59) return null
  return new Date(placed.getTime() + 1000)
}
