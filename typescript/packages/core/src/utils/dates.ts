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
import { LOCAL_ZONE, posixTransitions, resolveTz, type Zone } from './timezone.ts'
import { systemDate } from './clock.ts'

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

const WALL = z.tuple([
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
])
const REQUEST = z.object({
  op: z.literal('date'),
  zone: z.string().nullable(),
  instant: z.number().int().optional(),
  year: z.number().int().optional(),
  wall: WALL.optional(),
})
const PLACEMENT = z
  .object({
    epoch: z.number().int(),
    nanos: z.number().int().nonnegative().max(999999999),
    wall: WALL.nullable(),
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
  if (request.wall !== undefined) {
    const [year, month, day, hour, minute, second] = request.wall
    return (
      selected.fromWall({ year, month: month - 1, day, hour, minute, second, ms: 0 }).getTime() /
      1000
    )
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
    local: zone === LOCAL_ZONE,
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

/** Parse a date operand, yielding between shared-core steps. */
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

/** Parse a bare date operand, MMDDhhmm[[CC]YY][.ss]. */
export function parsePosixTime(text: string, zone: Zone, now?: Date): Date | null {
  try {
    return dateResult(text, 'posix', zone, now)
  } catch (err) {
    if (err instanceof RangeError) return null
    throw err
  }
}
