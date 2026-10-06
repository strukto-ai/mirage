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
  resolveTz,
  utcFromWall,
  type WallParts,
  type Zone,
} from './timezone.ts'

export function utcDateFolder(ts?: number): string {
  const d = ts === undefined ? new Date() : new Date(ts)
  return d.toISOString().slice(0, 10)
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
 * The instant `zone` shows `p` at, or null when it shows none: glibc's
 * mktime finds no instant for the hour skipped when DST starts, and GNU
 * date answers `-d` for one with `invalid date`. The host's zone is not
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

// The UTC seconds Python's datetime holds: 0001-01-01 to 9999-12-31.
const FIRST_SECOND = -62135596800
const LAST_SECOND = 253402300799
const EPOCH_RE = /^@\s*[+-]?\d+(?:\.\d+)?$/
const SPACES = ' \t\n\v\f\r'
const DIGITS = '0123456789'
const HOUR = 3600
const BILLION = 1_000_000_000
const MER24 = 0
const AM = 1
const PM = 2
// Each unit token's field of a relative item.
const UNITS: ReadonlyMap<string, keyof Rel> = new Map([
  ['YEAR_UNIT', 'year'],
  ['MONTH_UNIT', 'month'],
  ['DAY_UNIT', 'day'],
  ['HOUR_UNIT', 'hour'],
  ['MINUTE_UNIT', 'minutes'],
  ['SEC_UNIT', 'seconds'],
])

// gnulib parse-datetime's word tables (coreutils 9.7), in the order lookup_word
// tries them.
const MERIDIANS: Readonly<Record<string, number>> = { AM, 'A.M.': AM, PM, 'P.M.': PM }
const MONTHS_AND_DAYS: readonly (readonly [string, string, number])[] = [
  ['JANUARY', 'MONTH', 1],
  ['FEBRUARY', 'MONTH', 2],
  ['MARCH', 'MONTH', 3],
  ['APRIL', 'MONTH', 4],
  ['MAY', 'MONTH', 5],
  ['JUNE', 'MONTH', 6],
  ['JULY', 'MONTH', 7],
  ['AUGUST', 'MONTH', 8],
  ['SEPTEMBER', 'MONTH', 9],
  ['SEPT', 'MONTH', 9],
  ['OCTOBER', 'MONTH', 10],
  ['NOVEMBER', 'MONTH', 11],
  ['DECEMBER', 'MONTH', 12],
  ['SUNDAY', 'DAY', 0],
  ['MONDAY', 'DAY', 1],
  ['TUESDAY', 'DAY', 2],
  ['TUES', 'DAY', 2],
  ['WEDNESDAY', 'DAY', 3],
  ['WEDNES', 'DAY', 3],
  ['THURSDAY', 'DAY', 4],
  ['THUR', 'DAY', 4],
  ['THURS', 'DAY', 4],
  ['FRIDAY', 'DAY', 5],
  ['SATURDAY', 'DAY', 6],
]
const TIME_UNITS: Readonly<Record<string, readonly [string, number]>> = {
  YEAR: ['YEAR_UNIT', 1],
  MONTH: ['MONTH_UNIT', 1],
  FORTNIGHT: ['DAY_UNIT', 14],
  WEEK: ['DAY_UNIT', 7],
  DAY: ['DAY_UNIT', 1],
  HOUR: ['HOUR_UNIT', 1],
  MINUTE: ['MINUTE_UNIT', 1],
  MIN: ['MINUTE_UNIT', 1],
  SECOND: ['SEC_UNIT', 1],
  SEC: ['SEC_UNIT', 1],
}
const RELATIVE_WORDS: Readonly<Record<string, readonly [string, number]>> = {
  TOMORROW: ['DAY_SHIFT', 1],
  YESTERDAY: ['DAY_SHIFT', -1],
  TODAY: ['DAY_SHIFT', 0],
  NOW: ['DAY_SHIFT', 0],
  LAST: ['ORDINAL', -1],
  THIS: ['ORDINAL', 0],
  NEXT: ['ORDINAL', 1],
  FIRST: ['ORDINAL', 1],
  THIRD: ['ORDINAL', 3],
  FOURTH: ['ORDINAL', 4],
  FIFTH: ['ORDINAL', 5],
  SIXTH: ['ORDINAL', 6],
  SEVENTH: ['ORDINAL', 7],
  EIGHTH: ['ORDINAL', 8],
  NINTH: ['ORDINAL', 9],
  TENTH: ['ORDINAL', 10],
  ELEVENTH: ['ORDINAL', 11],
  TWELFTH: ['ORDINAL', 12],
  AGO: ['AGO', -1],
  HENCE: ['AGO', 1],
}
const UNIVERSAL_ZONES: Readonly<Record<string, number>> = { GMT: 0, UT: 0, UTC: 0 }
// Seconds east of UTC; a DAYZONE is an hour more.
const ZONES: Readonly<Record<string, readonly [string, number]>> = {
  WET: ['ZONE', 0],
  WEST: ['DAYZONE', 0],
  BST: ['DAYZONE', 0],
  ART: ['ZONE', -3 * HOUR],
  BRT: ['ZONE', -3 * HOUR],
  BRST: ['DAYZONE', -3 * HOUR],
  NST: ['ZONE', -(3 * HOUR + 1800)],
  NDT: ['DAYZONE', -(3 * HOUR + 1800)],
  AST: ['ZONE', -4 * HOUR],
  ADT: ['DAYZONE', -4 * HOUR],
  CLT: ['ZONE', -4 * HOUR],
  CLST: ['DAYZONE', -4 * HOUR],
  EST: ['ZONE', -5 * HOUR],
  EDT: ['DAYZONE', -5 * HOUR],
  CST: ['ZONE', -6 * HOUR],
  CDT: ['DAYZONE', -6 * HOUR],
  MST: ['ZONE', -7 * HOUR],
  MDT: ['DAYZONE', -7 * HOUR],
  PST: ['ZONE', -8 * HOUR],
  PDT: ['DAYZONE', -8 * HOUR],
  AKST: ['ZONE', -9 * HOUR],
  AKDT: ['DAYZONE', -9 * HOUR],
  HST: ['ZONE', -10 * HOUR],
  HAST: ['ZONE', -10 * HOUR],
  HADT: ['DAYZONE', -10 * HOUR],
  SST: ['ZONE', -12 * HOUR],
  WAT: ['ZONE', HOUR],
  CET: ['ZONE', HOUR],
  CEST: ['DAYZONE', HOUR],
  MET: ['ZONE', HOUR],
  MEZ: ['ZONE', HOUR],
  MEST: ['DAYZONE', HOUR],
  MESZ: ['DAYZONE', HOUR],
  EET: ['ZONE', 2 * HOUR],
  EEST: ['DAYZONE', 2 * HOUR],
  CAT: ['ZONE', 2 * HOUR],
  SAST: ['ZONE', 2 * HOUR],
  EAT: ['ZONE', 3 * HOUR],
  MSK: ['ZONE', 3 * HOUR],
  MSD: ['DAYZONE', 3 * HOUR],
  IST: ['ZONE', 5 * HOUR + 1800],
  SGT: ['ZONE', 8 * HOUR],
  KST: ['ZONE', 9 * HOUR],
  JST: ['ZONE', 9 * HOUR],
  GST: ['ZONE', 10 * HOUR],
  NZST: ['ZONE', 12 * HOUR],
  NZDT: ['DAYZONE', 12 * HOUR],
}
// The military letters, RFC 5322's way round; T is the ISO 8601 separator
// and J the local zone.
const MILITARY: Readonly<Record<string, number>> = {
  ...Object.fromEntries(Array.from('ABCDEFGHI', (letter, i) => [letter, (i + 1) * HOUR])),
  ...Object.fromEntries(Array.from('KLM', (letter, i) => [letter, (i + 10) * HOUR])),
  ...Object.fromEntries(Array.from('NOPQRS', (letter, i) => [letter, -(i + 1) * HOUR])),
  ...Object.fromEntries(Array.from('UVWXY', (letter, i) => [letter, -(i + 8) * HOUR])),
  Z: 0,
}

/**
 * One lexeme of a date expression, gnulib's yylex output: `kind` is UNUMBER,
 * SNUMBER, UDECIMAL, SDECIMAL, a word's table type or a lone character; `ns`
 * is a decimal's nanoseconds, always a positive offset; `negative` marks a
 * number written with a minus sign, zero too; `offset` is a local zone's
 * offset east of UTC, null when its abbreviation names both of the zone's
 * offsets.
 */
interface Token {
  kind: string
  value: number
  digits: number
  ns: number
  negative: boolean
  offset: number | null
}

interface Rel {
  year: number
  month: number
  day: number
  hour: number
  minutes: number
  seconds: number
  ns: number
}

// What the items of an expression set, gnulib's parser_control. The calendar
// fields start as the current moment's, so an item that leaves one alone
// keeps it; the counters are how many items of each kind were seen.
interface Parsed {
  year: number
  yearDigits: number
  month: number
  day: number
  hour: number
  minutes: number
  seconds: number
  ns: number
  meridian: number
  rel: Rel
  relsSeen: boolean
  dayOrdinal: number
  dayNumber: number
  timeZone: number
  localOffset: number | null
  datesSeen: number
  daysSeen: number
  timesSeen: number
  zonesSeen: number
  localZonesSeen: number
  dstsSeen: number
  jZonesSeen: number
}

function token(kind: string, value = 0, extra: Partial<Token> = {}): Token {
  return { kind, value, digits: 0, ns: 0, negative: false, offset: null, ...extra }
}

function noRel(): Rel {
  return { year: 0, month: 0, day: 0, hour: 0, minutes: 0, seconds: 0, ns: 0 }
}

/**
 * The zone abbreviations the reading zone itself uses, gnulib's
 * local_time_zone_table: the current one, and the first different offset's in
 * the next three quarters, each with the offset it names. An abbreviation
 * naming both offsets names neither.
 */
function localZones(zone: Zone, now: Date): Map<string, number | null> {
  const table = new Map<string, number | null>()
  if (zone === LOCAL_ZONE) return table
  const first = zone.parts(now)
  table.set(first.abbrev, first.offsetSec)
  for (const quarter of [1, 2, 3]) {
    const probe = zone.parts(new Date(now.getTime() + quarter * 90 * 86_400_000))
    if (probe.offsetSec === first.offsetSec) continue
    if (probe.abbrev === first.abbrev) table.set(first.abbrev, null)
    else table.set(probe.abbrev, probe.offsetSec)
    break
  }
  return table
}

function zoneToken(word: string, local: Map<string, number | null>): Token | null {
  const universal = UNIVERSAL_ZONES[word]
  if (universal !== undefined) return token('ZONE', universal)
  if (local.has(word)) return token('LOCAL_ZONE', 0, { offset: local.get(word) ?? null })
  const zone = ZONES[word]
  return zone === undefined ? null : token(zone[0], zone[1])
}

/** A word as gnulib's lookup_word classifies it, null for one it does not know. */
function wordToken(text: string, local: Map<string, number | null>): Token | null {
  const word = text.toUpperCase()
  const meridian = MERIDIANS[word]
  if (meridian !== undefined) return token('MERIDIAN', meridian)
  const abbrev = word.length === 3 || (word.length === 4 && word[3] === '.')
  for (const [name, kind, value] of MONTHS_AND_DAYS) {
    if (abbrev ? name.slice(0, 3) === word.slice(0, 3) : name === word) return token(kind, value)
  }
  const zone = zoneToken(word, local)
  if (zone !== null) return zone
  if (word === 'DST') return token('DST')
  for (const unit of [word, word.endsWith('S') ? word.slice(0, -1) : null]) {
    const found = unit === null ? undefined : TIME_UNITS[unit]
    if (found !== undefined) return token(found[0], found[1])
  }
  const relative = RELATIVE_WORDS[word]
  if (relative !== undefined) return token(relative[0], relative[1])
  if (word.length === 1) {
    if (word === 'J' || word === 'T') return token(word)
    const military = MILITARY[word]
    if (military !== undefined) return token('ZONE', military)
  }
  if (word.includes('.')) return zoneToken(word.replaceAll('.', ''), local)
  return null
}

function isLetter(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z]$/.test(char)
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char !== '' && DIGITS.includes(char)
}

/**
 * gnulib's yylex over the whole expression, null at a word it does not know or
 * a number past 64 bits. A sign binds to the number after it, `.` or `,` makes
 * a decimal of up to nine fraction digits, and a parenthesized comment is
 * skipped.
 */
function lex(text: string, local: Map<string, number | null>): Token[] | null {
  const tokens: Token[] = []
  let at = 0
  const end = text.length
  for (;;) {
    while (at < end && SPACES.includes(text[at] ?? '')) at += 1
    if (at >= end) return tokens
    const char = text[at] ?? ''
    if (isDigit(char) || char === '+' || char === '-') {
      let sign = 0
      let p = at
      if (char === '+' || char === '-') {
        sign = char === '-' ? -1 : 1
        p += 1
        while (p < end && SPACES.includes(text[p] ?? '')) p += 1
        if (!isDigit(text[p])) {
          at = p
          continue
        }
      }
      const first = p
      while (isDigit(text[p])) p += 1
      const value = Number(text.slice(first, p))
      if (value > Number.MAX_SAFE_INTEGER) return null
      if ((text[p] === '.' || text[p] === ',') && isDigit(text[p + 1])) {
        let q = p + 1
        while (isDigit(text[q])) q += 1
        const fraction = text.slice(p + 1, q)
        let ns = Number(fraction.slice(0, 9).padEnd(9, '0'))
        if (sign < 0 && /[1-9]/.test(fraction.slice(9))) ns += 1
        let seconds = sign < 0 ? -value : value
        if (sign < 0 && ns !== 0) {
          seconds -= 1
          ns = BILLION - ns
        }
        tokens.push(token(sign !== 0 ? 'SDECIMAL' : 'UDECIMAL', seconds, { ns }))
        at = q
        continue
      }
      tokens.push(
        token(sign !== 0 ? 'SNUMBER' : 'UNUMBER', sign < 0 ? -value : value, {
          digits: p - first,
          negative: sign < 0,
        }),
      )
      at = p
      continue
    }
    if (isLetter(char)) {
      let p = at
      while (isLetter(text[p]) || text[p] === '.') p += 1
      const word = wordToken(text.slice(at, p), local)
      if (word === null) return null
      tokens.push(word)
      at = p
      continue
    }
    if (char === '(') {
      let depth = 0
      while (at < end) {
        if (text[at] === '(') depth += 1
        else if (text[at] === ')') depth -= 1
        at += 1
        if (depth === 0) break
      }
      if (depth !== 0) return tokens
      continue
    }
    tokens.push(token(char))
    at += 1
  }
}

function kindAt(tokens: readonly Token[], at: number): string {
  return tokens[at]?.kind ?? ''
}

function at(tokens: readonly Token[], index: number): Token {
  return tokens[index] ?? token('')
}

/** A relative unit times a count, gnulib's relunit. */
function unitRel(unit: Token, count: number): Rel {
  const rel = noRel()
  rel[UNITS.get(unit.kind) ?? 'seconds'] = count * unit.value
  return rel
}

/** Add a relative item into the running sum, gnulib's apply_relative_time. */
function apply(parsed: Parsed, rel: Rel, factor: number): void {
  const total = parsed.rel
  total.year += factor * rel.year
  total.month += factor * rel.month
  total.day += factor * rel.day
  total.hour += factor * rel.hour
  total.minutes += factor * rel.minutes
  total.seconds += factor * rel.seconds
  total.ns += factor * rel.ns
  parsed.relsSeen = true
}

/** A relative unit at `index` with its count, and where it ends. */
function relunit(tokens: readonly Token[], index: number): [Rel, number] | null {
  const head = at(tokens, index)
  const after = kindAt(tokens, index + 1)
  if (['ORDINAL', 'UNUMBER', 'SNUMBER'].includes(head.kind) && UNITS.has(after)) {
    return [unitRel(at(tokens, index + 1), head.value), index + 2]
  }
  if ((head.kind === 'UDECIMAL' || head.kind === 'SDECIMAL') && after === 'SEC_UNIT') {
    return [{ ...noRel(), seconds: head.value, ns: head.ns }, index + 2]
  }
  if (UNITS.has(head.kind)) return [unitRel(head, 1), index + 1]
  return null
}

/** `relunit [ago|hence]`: add one relative item. */
function relItem(parsed: Parsed, tokens: readonly Token[], index: number): number | null {
  const found = relunit(tokens, index)
  if (found === null) return null
  const [rel, next] = found
  let after = next
  let factor = 1
  if (kindAt(tokens, after) === 'AGO') {
    factor = at(tokens, after).value
    after += 1
  }
  apply(parsed, rel, factor)
  return after
}

/**
 * The numeric zone a signed number at `index` starts, in seconds east, and
 * where it ends: gnulib's time_zone_hhmm, one or two digits of hours or more of
 * hours and minutes, a `:MM` adding minutes, at most 24 hours either way.
 */
function zoneHhmm(tokens: readonly Token[], index: number): [number, number] | null {
  const number = at(tokens, index)
  let minutes = -1
  let after = index + 1
  if (kindAt(tokens, after) === ':') {
    if (kindAt(tokens, after + 1) !== 'UNUMBER') return null
    minutes = at(tokens, after + 1).value
    after += 2
  }
  let value = number.value
  if (number.digits <= 2 && minutes < 0) value *= 100
  let total: number
  if (minutes < 0) {
    const size = Math.abs(value)
    total = (Math.floor(size / 100) * 60 + (size % 100)) * (value < 0 ? -1 : 1)
  } else {
    total = value * 60 + (number.negative ? -minutes : minutes)
  }
  if (total < -24 * 60 || total > 24 * 60) return null
  return [total * 60, after]
}

/** An optional numeric zone after a time of day. */
function zoneOffset(parsed: Parsed, tokens: readonly Token[], index: number): number | null {
  if (kindAt(tokens, index) !== 'SNUMBER') return index
  const found = zoneHhmm(tokens, index)
  if (found === null) return null
  parsed.timeZone = found[0]
  parsed.zonesSeen += 1
  return found[1]
}

function setTime(
  parsed: Parsed,
  hour: number,
  minutes: number,
  seconds: number,
  ns: number,
  meridian: number,
): void {
  parsed.hour = hour
  parsed.minutes = minutes
  parsed.seconds = seconds
  parsed.ns = ns
  parsed.meridian = meridian
  parsed.timesSeen += 1
}

/**
 * `H:MM[:SS[.frac]]` with a meridian, or an ISO time with an optional numeric
 * zone; after a date's `T` only the ISO form.
 */
function clock(
  parsed: Parsed,
  tokens: readonly Token[],
  index: number,
  iso: boolean,
): number | null {
  if (kindAt(tokens, index + 2) !== 'UNUMBER') return null
  const hour = at(tokens, index).value
  const minutes = at(tokens, index + 2).value
  let seconds = 0
  let ns = 0
  let after = index + 3
  if (kindAt(tokens, after) === ':') {
    const kind = kindAt(tokens, after + 1)
    if (kind !== 'UNUMBER' && kind !== 'UDECIMAL') return null
    seconds = at(tokens, after + 1).value
    ns = at(tokens, after + 1).ns
    after += 2
  }
  if (!iso && kindAt(tokens, after) === 'MERIDIAN') {
    setTime(parsed, hour, minutes, seconds, ns, at(tokens, after).value)
    return after + 1
  }
  setTime(parsed, hour, minutes, seconds, ns, MER24)
  return zoneOffset(parsed, tokens, after)
}

/** The time after a date's `T`: an hour with a numeric zone, or a clock. */
function isoTime(parsed: Parsed, tokens: readonly Token[], index: number): number | null {
  if (kindAt(tokens, index) !== 'UNUMBER') return null
  if (kindAt(tokens, index + 1) === ':') return clock(parsed, tokens, index, true)
  if (kindAt(tokens, index + 1) !== 'SNUMBER') return null
  setTime(parsed, at(tokens, index).value, 0, 0, 0, MER24)
  return zoneOffset(parsed, tokens, index + 1)
}

/**
 * A bare number, gnulib's digits_to_date_time: the year of a date that has
 * none yet, a `YYYYMMDD` date past four digits, else `HH` or `HHMM`.
 */
function digitsItem(parsed: Parsed, number: Token): void {
  if (
    parsed.datesSeen > 0 &&
    parsed.yearDigits === 0 &&
    !parsed.relsSeen &&
    (parsed.timesSeen > 0 || number.digits > 2)
  ) {
    parsed.year = number.value
    parsed.yearDigits = number.digits
  } else if (number.digits > 4) {
    parsed.datesSeen += 1
    parsed.day = number.value % 100
    parsed.month = Math.floor(number.value / 100) % 100
    parsed.year = Math.floor(number.value / 10000)
    parsed.yearDigits = number.digits - 4
  } else if (number.digits <= 2) {
    setTime(parsed, number.value, 0, 0, 0, MER24)
  } else {
    setTime(parsed, Math.floor(number.value / 100), number.value % 100, 0, 0, MER24)
  }
}

/**
 * An item that opens with an unsigned number, resolved by the token after it as
 * gnulib's LALR(1) parser resolves it; with none that fits, a bare number.
 */
function numberItem(parsed: Parsed, tokens: readonly Token[], index: number): number | null {
  const number = at(tokens, index)
  const after = kindAt(tokens, index + 1)
  if (after === 'MERIDIAN') {
    setTime(parsed, number.value, 0, 0, 0, at(tokens, index + 1).value)
    return index + 2
  }
  if (after === ':') return clock(parsed, tokens, index, false)
  if (after === '/') {
    if (kindAt(tokens, index + 2) !== 'UNUMBER') return null
    const second = at(tokens, index + 2)
    parsed.datesSeen += 1
    if (kindAt(tokens, index + 3) !== '/') {
      parsed.month = number.value
      parsed.day = second.value
      return index + 3
    }
    if (kindAt(tokens, index + 4) !== 'UNUMBER') return null
    const third = at(tokens, index + 4)
    if (number.digits >= 4) {
      parsed.year = number.value
      parsed.yearDigits = number.digits
      parsed.month = second.value
      parsed.day = third.value
    } else {
      parsed.month = number.value
      parsed.day = second.value
      parsed.year = third.value
      parsed.yearDigits = third.digits
    }
    return index + 5
  }
  if (after === 'SNUMBER') {
    const following = kindAt(tokens, index + 2)
    if (following === 'SNUMBER') {
      parsed.year = number.value
      parsed.yearDigits = number.digits
      parsed.month = -at(tokens, index + 1).value
      parsed.day = -at(tokens, index + 2).value
      parsed.datesSeen += 1
      if (kindAt(tokens, index + 3) === 'T') return isoTime(parsed, tokens, index + 4)
      return index + 3
    }
    if (UNITS.has(following)) {
      digitsItem(parsed, number)
      apply(parsed, unitRel(at(tokens, index + 2), at(tokens, index + 1).value), 1)
      return index + 3
    }
    setTime(parsed, number.value, 0, 0, 0, MER24)
    return zoneOffset(parsed, tokens, index + 1)
  }
  if (after === 'MONTH') {
    parsed.day = number.value
    parsed.month = at(tokens, index + 1).value
    parsed.datesSeen += 1
    const following = kindAt(tokens, index + 2)
    if (following === 'SNUMBER') {
      parsed.year = -at(tokens, index + 2).value
      parsed.yearDigits = at(tokens, index + 2).digits
      return index + 3
    }
    if (following === 'UNUMBER') {
      parsed.year = at(tokens, index + 2).value
      parsed.yearDigits = at(tokens, index + 2).digits
      return index + 3
    }
    return index + 2
  }
  if (after === 'DAY') {
    parsed.dayOrdinal = number.value
    parsed.dayNumber = at(tokens, index + 1).value
    parsed.daysSeen += 1
    return index + 2
  }
  if (UNITS.has(after)) return relItem(parsed, tokens, index)
  digitsItem(parsed, number)
  return index + 1
}

/** One item of gnulib's grammar at `index`; where it ends, or null when none starts there. */
function item(parsed: Parsed, tokens: readonly Token[], index: number): number | null {
  const head = at(tokens, index)
  const kind = head.kind
  const after = kindAt(tokens, index + 1)
  if (kind === 'UNUMBER') return numberItem(parsed, tokens, index)
  if (['SNUMBER', 'UDECIMAL', 'SDECIMAL'].includes(kind) || UNITS.has(kind)) {
    return relItem(parsed, tokens, index)
  }
  if (kind === 'ORDINAL') {
    if (after === 'DAY') {
      parsed.dayOrdinal = head.value
      parsed.dayNumber = at(tokens, index + 1).value
      parsed.daysSeen += 1
      return index + 2
    }
    return relItem(parsed, tokens, index)
  }
  if (kind === 'DAY_SHIFT') {
    apply(parsed, { ...noRel(), day: head.value }, 1)
    return index + 1
  }
  if (kind === 'MONTH') {
    parsed.month = head.value
    parsed.datesSeen += 1
    if (after === 'SNUMBER') {
      if (kindAt(tokens, index + 2) !== 'SNUMBER') return null
      parsed.day = -at(tokens, index + 1).value
      parsed.year = -at(tokens, index + 2).value
      parsed.yearDigits = at(tokens, index + 2).digits
      return index + 3
    }
    if (after !== 'UNUMBER') return null
    parsed.day = at(tokens, index + 1).value
    if (kindAt(tokens, index + 2) !== ',') return index + 2
    if (kindAt(tokens, index + 3) !== 'UNUMBER') return null
    parsed.year = at(tokens, index + 3).value
    parsed.yearDigits = at(tokens, index + 3).digits
    return index + 4
  }
  if (kind === 'DAY') {
    parsed.dayOrdinal = 0
    parsed.dayNumber = head.value
    parsed.daysSeen += 1
    return after === ',' ? index + 2 : index + 1
  }
  if (kind === 'ZONE' || kind === 'T') {
    const zone = kind === 'T' ? -7 * HOUR : head.value
    parsed.timeZone = zone
    parsed.zonesSeen += 1
    if (after === 'SNUMBER' && UNITS.has(kindAt(tokens, index + 2))) {
      apply(parsed, unitRel(at(tokens, index + 2), at(tokens, index + 1).value), 1)
      return index + 3
    }
    if (kind === 'T') return index + 1
    if (after === 'DST') {
      parsed.timeZone = zone + HOUR
      return index + 2
    }
    if (after !== 'SNUMBER') return index + 1
    const found = zoneHhmm(tokens, index + 1)
    if (found === null) return null
    parsed.timeZone += found[0]
    return found[1]
  }
  if (kind === 'DAYZONE') {
    parsed.timeZone = head.value + HOUR
    parsed.zonesSeen += 1
    return index + 1
  }
  if (kind === 'LOCAL_ZONE') {
    parsed.localZonesSeen += 1
    parsed.localOffset = head.offset
    if (after === 'DST') {
      parsed.dstsSeen += 1
      parsed.localOffset = head.offset === null ? null : head.offset + HOUR
      return index + 2
    }
    return index + 1
  }
  if (kind === 'J') {
    parsed.jZonesSeen += 1
    return index + 1
  }
  return null
}

/** An hour on the 24-hour clock, -1 when the meridian refuses it. */
function toHour(hour: number, meridian: number): number {
  if (meridian === MER24) return hour >= 0 && hour < 24 ? hour : -1
  if (!(hour > 0 && hour <= 12)) return -1
  return (hour % 12) + (meridian === PM ? 12 : 0)
}

/**
 * The reading of a wall clock that carries a local abbreviation's offset, null
 * when the zone does not show the wall clock under it (`CET` on a summer date
 * in Europe/Berlin), as mktime refuses a tm_isdst that does not hold.
 */
function localReading(zone: Zone, p: WallParts, offset: number): Date | null {
  const reading = zone.fromWall(p, offset)
  const shown = zone.parts(reading)
  const kept =
    shown.offsetSec === offset &&
    utcFromWall({ ...shown, ms: 0 }).getTime() === utcFromWall({ ...p, ms: 0 }).getTime()
  return kept ? reading : null
}

/**
 * A wall clock as mktime reads it under an explicit tm_isdst: the reading at
 * that offset, or the wall clock taken at the offset where the zone does not
 * show it under it, which is how mktime extrapolates a tm_isdst the date does
 * not observe.
 */
function held(zone: Zone, p: WallParts, offset: number): Date {
  return localReading(zone, p, offset) ?? new Date(utcFromWall(p).getTime() - offset * 1000)
}

/** The wall clock `zone` shows for an instant, without milliseconds. */
function wallOf(zone: Zone, dt: Date): WallParts {
  const p = zone.parts(dt)
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    ms: 0,
  }
}

/**
 * Days from the wall clock `p` to the weekday the items name. A bare weekday
 * is the next one on or after `p`; `next` or a count past it skips that many
 * more weeks, counting `p` itself only when it is not already that weekday;
 * `last` goes back.
 */
function weekdayShift(parsed: Parsed, p: WallParts): number {
  const weekday = utcFromWall(p).getUTCDay()
  const ordinal =
    parsed.dayOrdinal - (parsed.dayOrdinal > 0 && weekday !== parsed.dayNumber ? 1 : 0)
  return ordinal * 7 + ((parsed.dayNumber - weekday + 7) % 7)
}

/** A wall clock from fields that may overflow, normalized as mktime carries them. */
function normalized(p: WallParts): WallParts {
  const d = utcFromWall(p)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    ms: 0,
  }
}

/**
 * The moment the parsed items name, gnulib's parse_datetime body: the fields
 * placed in the zone as mktime places them, a weekday moved to, then the summed
 * relative days moved on the calendar once and the relative seconds added on
 * the timeline.
 */
function resolve(parsed: Parsed, zone: Zone, now: Date): Date | null {
  if (
    1 <
    (parsed.timesSeen |
      parsed.datesSeen |
      parsed.daysSeen |
      parsed.dstsSeen |
      (parsed.jZonesSeen + parsed.localZonesSeen + parsed.zonesSeen))
  ) {
    return null
  }
  let year = parsed.year
  if (parsed.yearDigits === 2 && year >= 0) year += year < 69 ? 2000 : 1900
  const absolute = parsed.datesSeen > 0 || parsed.daysSeen > 0 || parsed.timesSeen > 0
  let hour = 0
  let minute = 0
  let second = 0
  let ns = 0
  if (parsed.timesSeen > 0 || (parsed.relsSeen && !absolute)) {
    hour = toHour(parsed.hour, parsed.meridian)
    minute = parsed.minutes
    second = parsed.seconds
    ns = parsed.ns
  }
  if (
    year < 1 ||
    year > 9999 ||
    parsed.month < 1 ||
    parsed.month > 12 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    parsed.day < 1 ||
    parsed.day > daysInMonth(year, parsed.month - 1)
  ) {
    return null
  }
  const wall: WallParts = {
    year,
    month: parsed.month - 1,
    day: parsed.day,
    hour,
    minute,
    second,
    ms: 0,
  }
  const rel = parsed.rel
  const moves = rel.year !== 0 || rel.month !== 0 || rel.day !== 0
  let epochMs: number
  if (parsed.zonesSeen > 0) {
    let p = wall
    if (parsed.daysSeen > 0 && parsed.datesSeen === 0) {
      p = normalized({ ...p, day: p.day + weekdayShift(parsed, p) })
    }
    if (moves) {
      p = normalized({
        ...wall,
        year: p.year + rel.year,
        month: p.month + rel.month,
        day: p.day + rel.day,
      })
    }
    epochMs = utcFromWall(p).getTime() - parsed.timeZone * 1000
  } else {
    // What gnulib hands mktime as tm_isdst for the calendar move: -1 (null
    // here) after a date, weekday or time, else an explicit one, the local
    // abbreviation's or the current moment's, which mktime holds to even
    // where the moved date does not observe it.
    const hint =
      parsed.localZonesSeen > 0 ? parsed.localOffset : absolute ? null : zone.parts(now).offsetSec
    let placed: Date | null
    if (parsed.localZonesSeen > 0 && parsed.localOffset !== null) {
      placed = localReading(zone, wall, parsed.localOffset)
    } else if (absolute || hint === null) {
      placed = placeWall(zone, wall)
    } else {
      placed = held(zone, wall, hint)
    }
    if (placed === null) return null
    if (parsed.daysSeen > 0 && parsed.datesSeen === 0) {
      const shown = wallOf(zone, placed)
      placed = zone.fromWall(
        { ...shown, day: shown.day + weekdayShift(parsed, shown) },
        zone.parts(placed).offsetSec,
      )
    }
    if (moves) {
      const shown = wallOf(zone, placed)
      const moved = normalized({
        ...wall,
        year: shown.year + rel.year,
        month: shown.month + rel.month,
        day: shown.day + rel.day,
      })
      placed =
        hint === null ? zone.fromWall(moved, zone.parts(placed).offsetSec) : held(zone, moved, hint)
    }
    epochMs = placed.getTime()
  }
  const totalNs = ns + rel.ns
  const seconds =
    epochMs / 1000 +
    rel.hour * HOUR +
    rel.minutes * 60 +
    rel.seconds +
    Math.floor(totalNs / BILLION)
  if (seconds < FIRST_SECOND || seconds > LAST_SECOND) return null
  const result = new Date(
    seconds * 1000 + Math.floor((((totalNs % BILLION) + BILLION) % BILLION) / 1_000_000),
  )
  const shownYear = new Date(
    result.getTime() + zone.parts(result).offsetSec * 1000,
  ).getUTCFullYear()
  if (shownYear < 1 || shownYear > 9999) return null
  return result
}

/**
 * A leading `TZ="..."`: the zone it names and the text after it, with `\` and
 * `"` escaped by a backslash inside the quotes.
 */
function tzPrefix(text: string): [string, string] | null {
  if (!text.startsWith('TZ="')) return null
  let name = ''
  let index = 4
  while (index < text.length) {
    const char = text[index] ?? ''
    const next = text[index + 1]
    if (char === '\\' && (next === '\\' || next === '"')) {
      name += next
      index += 2
      continue
    }
    if (char === '"') return [name, text.slice(index + 1)]
    name += char
    index += 1
  }
  return null
}

function trimSpaces(text: string, start: boolean, end: boolean): string {
  let first = 0
  let last = text.length
  while (start && first < last && SPACES.includes(text[first] ?? '')) first += 1
  while (end && last > first && SPACES.includes(text[last - 1] ?? '')) last -= 1
  return text.slice(first, last)
}

// Parse a GNU `date -d` expression, null when GNU says `invalid date`. A port
// of gnulib's parse-datetime grammar as coreutils 9.7 builds it; one
// divergence: a moment outside years 1-9999 is not a date, the range a Date
// holds.
export function parseDateExpr(text: string, zone: Zone, now?: Date): Date | null {
  let raw = trimSpaces(text, true, false)
  let reading = zone
  const prefixed = tzPrefix(raw)
  if (prefixed !== null) {
    reading = resolveTz(prefixed[0])
    raw = prefixed[1]
  }
  raw = trimSpaces(raw, true, true)
  if (raw.startsWith('@')) {
    // gnulib's epoch grammar (findutils 4.10): blanks, a sign, a decimal
    // count of seconds and a fraction with digits on both sides; `@0x1`,
    // `@1e2`, `@1.` and `@.5` are not dates, however readily Number()
    // would take them.
    if (!EPOCH_RE.test(raw)) return null
    return new Date(Number(raw.slice(1)) * 1000)
  }
  const current = now ?? new Date()
  const tokens = lex(raw, localZones(reading, current))
  if (tokens === null) return null
  const fields = reading.parts(current)
  const parsed: Parsed = {
    year: fields.year,
    yearDigits: 0,
    month: fields.month + 1,
    day: fields.day,
    hour: fields.hour,
    minutes: fields.minute,
    seconds: fields.second,
    ns: (current.getTime() % 1000) * 1_000_000,
    meridian: MER24,
    rel: noRel(),
    relsSeen: false,
    dayOrdinal: 0,
    dayNumber: 0,
    timeZone: 0,
    localOffset: null,
    datesSeen: 0,
    daysSeen: 0,
    timesSeen: 0,
    zonesSeen: 0,
    localZonesSeen: 0,
    dstsSeen: 0,
    jZonesSeen: 0,
  }
  let index = 0
  while (index < tokens.length) {
    const next = item(parsed, tokens, index)
    if (next === null) return null
    index = next
  }
  return resolve(parsed, reading, current)
}

// POSIX `MMDDhhmm[[CC]YY][.ss]`, the clock a bare `date` operand sets.
const POSIX_TIME_RE = /^([0-9]{8}|[0-9]{10}|[0-9]{12})(?:\.([0-9]{2}))?$/

// gnulib's posixtime with date's syntax bits, measured on coreutils 9.7: no
// year is this year, a two-digit one is 2000-2068 up to 68 and 1969-1999 from
// 69, and `.ss` takes exactly two digits. A field out of range (`1301000024`,
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
