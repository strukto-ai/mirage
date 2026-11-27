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

import { z } from 'zod'
import type { util } from 'zod'
import { YieldBudget } from '../io/yield_budget.ts'
import { openStreamSync } from '../rs/stream.ts'
import { byteView, encodeText, decodeText } from '../shell/bytes.ts'
import { concat } from './bytes.ts'
import { posixTransitions, resolveTz, type Zone } from './timezone.ts'
import { systemDate } from './clock.ts'
import { RACY_WINDOW_NS } from './constants.ts'

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
  return toIsoZ(systemDate())
}

/**
 * Now in nanoseconds since the epoch, or `last + 1` when the clock has not
 * moved past `last`.
 *
 * A store Mirage keeps stamps each write with this, past the stamp it gave
 * the write before, so no two writes to it share a time. A clock that stands
 * still (a Durable Object's stops for a whole request) or one too coarse to
 * part two writes would otherwise give a rewrite the time its file already
 * had, and a reader that compares times would take the file for unchanged.
 * Mirrors Python's `stamp_after`.
 *
 * @param last the stamp the store gave its previous write, 0n for none
 */
export function stampAfter(last: bigint): bigint {
  const now = BigInt(systemDate().getTime()) * 1_000_000n
  return now > last ? now : last + 1n
}

/**
 * The host's wall clock in nanoseconds: the clock a file's times are judged
 * against, not the workspace's. Mirrors Python's `wall_ns`.
 */
export function wallNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n
}

/**
 * Whether an entry last changed at `changedNs` is old enough that a second
 * change could not have kept its time.
 *
 * A clock ticks coarser than the changes it dates, so two writes inside one
 * tick share a time, and a fingerprint built from it would not move. git calls
 * such an entry racy and reads it rather than trust its stat; a backend whose
 * fingerprint is a time gives none until the entry is `window` old. Mirrors
 * Python's `settled`.
 *
 * @param changedNs when the entry last changed, in nanoseconds
 * @param nowNs the wall clock, read before the entry's stat
 * @param window how old it must be: `REMOTE_RACY_WINDOW_NS` for a time
 *   another host's clock gave
 */
export function settled(changedNs: bigint, nowNs: bigint, window = RACY_WINDOW_NS): boolean {
  return nowNs - changedNs >= window
}

/**
 * A stamp as ISO text in UTC, to the nanosecond. Mirrors Python's
 * `stamp_iso`.
 *
 * @param ns nanoseconds since the epoch, as `stampAfter` gives
 */
export function stampIso(ns: bigint): string {
  const seconds = ns / 1_000_000_000n
  const fraction = (ns % 1_000_000_000n).toString().padStart(9, '0')
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19)
  return `${whole}.${fraction}Z`
}

// An ISO 8601 date-time as backends spell one: a date, an optional time
// with optional seconds and fraction, and an optional offset.
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * An instant as RFC 3339 text in UTC to the millisecond, as the HTTP API
 * reports every time: `2026-11-11T07:24:14.062Z`. Rounds as Python's
 * `ms_to_rfc3339` does, so both hosts spell it alike.
 */
export function msToRfc3339(ms: number): string {
  return new Date(Math.floor(ms + 0.5)).toISOString()
}

/**
 * A backend's date-time text as RFC 3339 in UTC to the millisecond, or null
 * when it is not an ISO 8601 date-time. A time with no offset is read as
 * UTC, digits past the millisecond are dropped, and only this one grammar is
 * read, so both hosts agree on every input. Mirrors Python's `rfc3339_of`.
 */
export function rfc3339Of(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text === '') return null
  const m = DATE_TIME.exec(text)
  if (m === null) return null
  const field = (i: number): number => Number(m[i] ?? 0)
  const fields = [field(1), field(2), field(3), field(4), field(5), field(6)] as const
  const whole = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5])
  const back = new Date(whole)
  // Date.UTC rolls an out-of-range field over; Python's datetime refuses it.
  if (
    back.getUTCFullYear() !== fields[0] ||
    back.getUTCMonth() !== fields[1] - 1 ||
    back.getUTCDate() !== fields[2] ||
    back.getUTCHours() !== fields[3] ||
    back.getUTCMinutes() !== fields[4] ||
    back.getUTCSeconds() !== fields[5]
  ) {
    return null
  }
  let ms = whole + Number((m[7] ?? '').slice(0, 3).padEnd(3, '0'))
  const offset = m[8]
  if (offset !== undefined && offset !== 'Z') {
    const hours = Number(offset.slice(1, 3))
    const minutes = Number(offset.slice(-2))
    if (hours > 23 || minutes > 59) return null
    ms -= (offset.startsWith('-') ? -1 : 1) * (hours * 60 + minutes) * 60_000
  }
  const year = new Date(ms).getUTCFullYear()
  if (year < 1000 || year > 9999) return null
  return msToRfc3339(ms)
}

// Truncated to whole seconds, matching Python epoch_to_iso.
export function epochToIso(seconds: number): string {
  return new Date(Math.floor(seconds) * 1000).toISOString().replace('.000Z', 'Z')
}

/** The wall clock an instant reads in `zone`, counted in seconds as an
 * epoch is: the time a DOS stamp stores. Mirrors Python's `local_seconds`. */
export function localSeconds(epoch: number, zone: Zone): number {
  return epoch + zone.parts(new Date(epoch * 1000)).offsetSec
}

/** The instant whose wall clock in `zone` reads `seconds`, counted as an
 * epoch is: a DOS stamp read back. Mirrors Python's `epoch_of_local`. */
export function epochOfLocal(seconds: number, zone: Zone): number {
  const wall = new Date(seconds * 1000)
  const at = zone.fromWall({
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth(),
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
    ms: 0,
  })
  return Math.floor(at.getTime() / 1000)
}

// Inverse of epochToIso; a naive stamp (no Z/offset, e.g. a `touch -t`
// overlay time) is read as UTC so this matches the Python isoToEpoch. JS
// interprets an offset-less date-time as local, so append Z when absent.
// Truncated to whole seconds to mirror epochToIso.
export function isoToEpoch(iso: string): number {
  const text = /(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`
  return Math.floor(Date.parse(text) / 1000)
}

/** A stat's modification time in epoch seconds, null where it holds no date. */
export function statEpoch(modified: string | null): number | null {
  if (modified === null || modified === '') return null
  const epoch = isoToEpoch(modified)
  return Number.isNaN(epoch) ? null : epoch
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

const REQUEST = z.object({
  op: z.literal('date'),
  zone: z.string().nullable(),
  instant: z.number().int().optional(),
  year: z.number().int().optional(),
})
const PLACEMENT = z
  .object({
    epoch: z.number().int(),
    nanos: z.number().int().nonnegative().max(999999999),
  })
  .nullable()

function dateRequest(
  header: Record<string, util.JSONType>,
  zone: Zone,
  zones: Map<string, Zone>,
): util.JSONType {
  const request = REQUEST.parse(header)
  let selected = zone
  if (request.zone !== null) {
    const known = zones.get(request.zone)
    selected = known ?? resolveTz(request.zone)
    zones.set(request.zone, selected)
  }
  if (request.year !== undefined) return posixTransitions(selected, request.year) ?? []
  if (request.instant === undefined) throw new TypeError('missing date instant')
  const shown = selected.parts(new Date(request.instant * 1000))
  return { offset: shown.offsetSec, name: shown.abbrev }
}

/** The answer to a date stream asking the time, in seconds and nanoseconds. Mirrors Python's clock_reply. */
export function clockReply(): Uint8Array {
  const ms = systemDate().getTime()
  const seconds = Math.floor(ms / 1000)
  return encodeText(JSON.stringify([seconds, (ms - seconds * 1000) * 1000000]))
}

/** The answer to one of a date stream's zone questions. Mirrors Python's date_reply. */
export function dateReply(
  header: Record<string, util.JSONType>,
  zone: Zone,
  zones: Map<string, Zone>,
): [Record<string, util.JSONType>, Uint8Array] {
  try {
    return [{}, encodeText(JSON.stringify(dateRequest(header, zone, zones)))]
  } catch (err) {
    if (!(err instanceof RangeError)) throw err
    return [{ error: 'invalid date' }, new Uint8Array()]
  }
}

function* dateSteps(
  text: string,
  mode: 'expr' | 'posix',
  zone: Zone,
  now?: Date,
): Generator<Uint8Array> {
  const ms = (now ?? systemDate()).getTime()
  if (!Number.isFinite(ms)) {
    yield encodeText('null')
    return
  }
  const current = Math.floor(ms / 1000)
  const engine = openStreamSync('date', {
    text: byteView(text),
    mode,
    now: current,
    nanos: (ms - current * 1000) * 1000000,
  })
  const zones = new Map<string, Zone>()
  try {
    for (;;) {
      while (engine.busy()) yield engine.drain()
      const taken = engine.request()
      if (taken === null) break
      const [reply, data] = dateReply(taken[0], zone, zones)
      yield engine.respond(reply, data)
    }
  } finally {
    engine.close()
  }
}

function datePlaced(out: readonly Uint8Array[], zone: Zone): Date | null {
  const result = PLACEMENT.parse(JSON.parse(decodeText(concat(out))))
  if (result === null) return null
  const date = new Date(result.epoch * 1000 + Math.floor(result.nanos / 1000000))
  const year = zone.parts(date).year
  return year < 1 || year > 9999 ? null : date
}

function dateResult(text: string, mode: 'expr' | 'posix', zone: Zone, now?: Date): Date | null {
  return datePlaced([...dateSteps(text, mode, zone, now)], zone)
}

async function dateAsync(
  text: string,
  mode: 'expr' | 'posix',
  zone: Zone,
  now?: Date,
  signal?: AbortSignal,
): Promise<Date | null> {
  try {
    const budget = new YieldBudget(signal)
    const out: Uint8Array[] = []
    for (const piece of dateSteps(text, mode, zone, now)) {
      await budget.run()
      out.push(piece)
    }
    return datePlaced(out, zone)
  } catch (err) {
    if (err instanceof RangeError) return null
    throw err
  }
}

/** Parse a date expression, yielding between shared-core steps. */
export function parseDateExprAsync(
  text: string,
  zone: Zone,
  now?: Date,
  signal?: AbortSignal,
): Promise<Date | null> {
  return dateAsync(text, 'expr', zone, now, signal)
}

/** Parse a bare date operand, MMDDhhmm[[CC]YY][.ss], yielding between shared-core steps. */
export function parsePosixTimeAsync(
  text: string,
  zone: Zone,
  now?: Date,
  signal?: AbortSignal,
): Promise<Date | null> {
  return dateAsync(text, 'posix', zone, now, signal)
}

/** Parse a free-form date expression, with time-zone facts supplied by the host. */
export function parseDateExpr(text: string, zone: Zone, now?: Date): Date | null {
  try {
    return dateResult(text, 'expr', zone, now)
  } catch (err) {
    if (err instanceof RangeError) return null
    throw err
  }
}
