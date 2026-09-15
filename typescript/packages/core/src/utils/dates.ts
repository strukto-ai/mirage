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

import { LOCAL_ZONE, UTC_ZONE, type WallParts, type Zone } from './timezone.ts'

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

const UNIT_SECONDS: Record<string, number> = {
  sec: 1,
  second: 1,
  min: 60,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
}
const CALENDAR_UNITS = new Set(['month', 'year'])
const NUMBER_UNIT_RE = /^([+-]?\d+)([a-z]+)$/
const NUMBER_RE = /^[+-]?\d+$/
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|z|[+-]\d{2}:?\d{2})?$/

function dateUnit(word: string): string | null {
  const unit = word !== 's' && word.endsWith('s') ? word.slice(0, -1) : word
  if (unit in UNIT_SECONDS || CALENDAR_UNITS.has(unit)) return unit
  return null
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

function addMonthsGnu(dt: Date, count: number, zone: Zone): Date {
  const p = zone.parts(dt)
  const total = p.month + count
  let year = p.year + Math.floor(total / 12)
  let month = ((total % 12) + 12) % 12
  // GNU normalizes an overflowing day-of-month through mktime rather than
  // clamping: Jan 31 + 1 month is Mar 3, not Feb 28.
  let day = p.day
  const days = daysInMonth(year, month)
  if (day > days) {
    day -= days
    month += 1
    if (month === 12) {
      month = 0
      year += 1
    }
  }
  return zone.fromWall({ ...p, year, month, day }, p.offsetSec)
}

// Displace a moment by `count` units, as gnulib does: months and years
// move the calendar (addMonthsGnu); days and weeks move the calendar too,
// keeping the wall clock across a DST change; hours, minutes and seconds
// are exact, so they are added on the UTC timeline (`2025-03-29 12:00 CET
// 24 hours` is `13:00 CEST`). A moved wall clock is read as mktime reads
// it with the base's tm_isdst, which gnulib hands it: the hour repeated
// when DST ends keeps the base's side of the change, and the hour skipped
// when it starts lands past the gap (`2025-03-29 02:30 CET 1 day` and
// `2025-03-31 02:30 CEST 1 day ago` are both `03:30 CEST`).
function shiftDate(dt: Date, unit: string, count: number, zone: Zone): Date {
  if (unit === 'month') return addMonthsGnu(dt, count, zone)
  if (unit === 'year') return addMonthsGnu(dt, 12 * count, zone)
  if (unit === 'day' || unit === 'week') {
    const p = zone.parts(dt)
    return zone.fromWall({ ...p, day: p.day + count * (unit === 'week' ? 7 : 1) }, p.offsetSec)
  }
  return new Date(dt.getTime() + (UNIT_SECONDS[unit] ?? 0) * count * 1000)
}

function parseIsoWords(text: string, zone: Zone): Date | null {
  const m = ISO_RE.exec(text)
  if (m === null) return null
  const year = Number(m[1])
  const month = Number(m[2]) - 1
  const day = Number(m[3])
  const hour = m[4] !== undefined ? Number(m[4]) : 0
  const minute = m[5] !== undefined ? Number(m[5]) : 0
  const second = m[6] !== undefined ? Number(m[6]) : 0
  if (
    year < 1 ||
    month < 0 ||
    month > 11 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null
  // Truncate, never round: `.9999` must stay inside its own second, as
  // it does for `new Date(iso)` and for Python's microsecond field.
  const ms = m[7] !== undefined ? Number(`${m[7]}000`.slice(0, 3)) : 0
  const suffix = m[8]
  if (suffix !== undefined) {
    let offsetMin = 0
    if (suffix !== 'Z' && suffix !== 'z') {
      const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(suffix)
      if (zm === null) return null
      const zoneHours = Number(zm[2])
      const zoneMinutes = Number(zm[3])
      // A zone past 23:59 is refused, as Python's datetime refuses it
      // (an offset there is strictly inside a day) and as GNU refuses
      // `+99:99`. gnulib alone takes exactly +-24:00 and folds a minute
      // field past 59 into hours; that corner is where the two hosts
      // part from GNU, and they part the same way.
      if (zoneHours > 23 || zoneMinutes > 59) return null
      offsetMin = (zm[1] === '-' ? -1 : 1) * (zoneHours * 60 + zoneMinutes)
    }
    const wall = UTC_ZONE.fromWall({ year, month, day, hour, minute, second, ms })
    return new Date(wall.getTime() - offsetMin * 60_000)
  }
  return placeWall(zone, { year, month, day, hour, minute, second, ms })
}

function applyRelative(base: Date, words: string[], zone: Zone): Date | null {
  let result = base
  // What `ago` would negate: the state before the last displacement plus
  // that displacement. Re-applying from the checkpoint (rather than
  // subtracting twice) keeps month normalization exact.
  let checkpoint: [Date, string, number] | null = null
  let i = 0
  while (i < words.length) {
    let word = (words[i] ?? '').toLowerCase()
    if (word === 'now' || word === 'today') {
      checkpoint = null
      i += 1
      continue
    }
    if (word === 'yesterday' || word === 'tomorrow') {
      const days = word === 'yesterday' ? -1 : 1
      checkpoint = [result, 'day', days]
      result = shiftDate(result, 'day', days, zone)
      i += 1
      continue
    }
    if (word === 'last' || word === 'next') {
      const unit = i + 1 < words.length ? dateUnit((words[i + 1] ?? '').toLowerCase()) : null
      if (unit === null) return null
      const count = word === 'last' ? -1 : 1
      checkpoint = [result, unit, count]
      result = shiftDate(result, unit, count, zone)
      i += 2
      continue
    }
    if (word === 'ago') {
      if (checkpoint === null) return null
      const [before, unit, count] = checkpoint
      result = shiftDate(before, unit, -count, zone)
      checkpoint = null
      i += 1
      continue
    }
    let sign = 1
    if (word === '+' || word === '-') {
      sign = word === '-' ? -1 : 1
      i += 1
      if (i >= words.length) return null
      word = (words[i] ?? '').toLowerCase()
    }
    const combined = NUMBER_UNIT_RE.exec(word)
    if (combined !== null) {
      const unit = dateUnit(combined[2] ?? '')
      if (unit === null) return null
      const count = Number(combined[1]) * sign
      checkpoint = [result, unit, count]
      result = shiftDate(result, unit, count, zone)
      i += 1
      continue
    }
    if (NUMBER_RE.test(word)) {
      const unit = i + 1 < words.length ? dateUnit((words[i + 1] ?? '').toLowerCase()) : null
      if (unit === null) return null
      const count = Number(word) * sign
      checkpoint = [result, unit, count]
      result = shiftDate(result, unit, count, zone)
      i += 2
      continue
    }
    const unit = dateUnit(word)
    if (unit !== null) {
      checkpoint = [result, unit, sign]
      result = shiftDate(result, unit, sign, zone)
      i += 1
      continue
    }
    return null
  }
  return result
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

// Parse a GNU `date -d` expression, or null when it is invalid. Covers the
// forms agents actually type: ISO 8601 dates and datetimes (with or without
// zone), `@epoch`, and gnulib's relative grammar (`24 hours ago`,
// `yesterday`, `next month`, `-2 weeks`, an ISO date followed by
// displacements). A null return is the caller's cue for GNU's
// `date: invalid date '...'` refusal, never a NaN render. The zone is the
// one the expression is read in: UTC under `-u`, the zone TZ names, or
// the host's (LOCAL_ZONE). Mirrors the Python parse_date_expr.
const EPOCH_RE = /^@\s*[+-]?\d+(?:\.\d+)?$/

export function parseDateExpr(text: string, zone: Zone, now?: Date): Date | null {
  const raw = text.trim()
  if (raw === '') return null
  if (raw.startsWith('@')) {
    // gnulib's epoch grammar (findutils 4.10): blanks, a sign, a decimal
    // count of seconds and a fraction with digits on both sides; `@0x1`,
    // `@1e2`, `@1.` and `@.5` are not dates, however readily Number()
    // would take them.
    if (!EPOCH_RE.test(raw)) return null
    return new Date(Number(raw.slice(1)) * 1000)
  }
  const whole = parseIsoWords(raw, zone)
  if (whole !== null) return whole
  const words = raw.split(/\s+/)
  let base = now ?? new Date()
  let index = 0
  for (const take of [2, 1]) {
    if (words.length < take) continue
    const prefix = parseIsoWords(words.slice(0, take).join(' '), zone)
    if (prefix === null) continue
    base = prefix
    index = take
    break
  }
  return applyRelative(base, words.slice(index), zone)
}
