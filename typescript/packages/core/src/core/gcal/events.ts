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

import type { GCalAccessor } from '../../accessor/gcal.ts'
import { Delta, FileChangeKind, type JsonValue, type PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { compareCodePoints, sortedJson } from '../../utils/sort.ts'
import { CALENDAR_FILE, eventTitle, makeEventFilename } from '../../vfs/gcal/event_entry.ts'
import type { DeltaHook } from '../../events/base.ts'
import { changesBetween, changesUnder } from '../../events/delta.ts'
import { textField } from '../../events/payload.ts'
import { ROOT } from '../hierarchy/scope.ts'
import { listed } from './client.ts'
import { bucketName, bucketStart, clampedHhmm, dayBounds, daysCovered, eventSpan } from './day.ts'
import {
  bucketZone,
  calendarIndex,
  calendarPayload,
  FREE_BUSY_ROLE,
  scopedBucket,
} from './readdir.ts'
import { detectScope } from './scope.ts'
import { parseTime } from '../time_range.ts'

/** Each event's files and `updated` stamp, by event id. */
type Known = Map<string, [string[], string | null]>

/** One calendar's sync state: where its last sync ended, and its events. */
type CalendarState = [string | null, Known]

/**
 * The files an event is: one per day it covers that the mount's scope holds,
 * named as the bucket listing names it. A bucket whose listing leaves the
 * event out (it falls outside the mount's time range) holds none of it.
 * Mirrors Python's `event_paths`.
 */
export function eventPaths(
  accessor: GCalAccessor,
  base: string,
  event: Record<string, JsonValue>,
  tz: string,
  freeBusy: boolean,
): string[] {
  const eventId = textField(event, 'id')
  const span = eventSpan(event, tz)
  if (eventId === null || eventId === '' || span === null) return []
  const size = accessor.config.bucketDays
  const scope = accessor.timeRange
  const title = eventTitle(textField(event, 'summary'), freeBusy)
  const paths: string[] = []
  for (const day of daysCovered(span, tz)) {
    const bucket = bucketName(bucketStart(day, size), size)
    let inScope: string[]
    try {
      inScope = scopedBucket(accessor, bucket, tz, base)
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err
      console.debug(`gcal events skip ${base}/${bucket}: ${String(err)}`)
      continue
    }
    const [lo, hi] = dayBounds(inScope[0] ?? day, tz, inScope.length)
    if (
      inScope.includes(day) &&
      (!scope.bounded || listed(span, ...scope.clip(parseTime(lo), parseTime(hi))))
    ) {
      const name = makeEventFilename(
        eventId,
        clampedHhmm(span, day, tz),
        title,
        size > 1 ? day : null,
      )
      paths.push(`${base}/${bucket}/${name}`)
    }
  }
  return paths
}

/**
 * Checkpointed delta over Calendar's incremental sync. Each calendar's
 * checkpoint holds its sync token and, by event id, the files the event is and
 * its `updated` stamp. An event names no file itself (its files follow from its
 * start, its title and the days it covers), so the files it was are what the
 * checkpoint remembers: an event moved or renamed is its old files leaving and
 * its new ones appearing, and a deleted one comes back `cancelled`, which
 * leaves every file it was. A token Calendar no longer honors (410) is answered
 * by listing the calendar whole and comparing each event's stamp, so nothing is
 * lost or reported twice. A calendar added to or removed from the account is
 * its directory appearing or leaving, and its own details changed are its
 * calendar.json, which the checkpoint keeps as it was rendered. The checkpoint
 * also keeps the zone days are bucketed in: when it moves, every event's files
 * may move, so each calendar is synced whole again. Mirrors Python's
 * GCalDeltaHook.
 */
export class GCalDeltaHook implements DeltaHook {
  constructor(private readonly accessor: GCalAccessor) {}

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const calendars = await calendarIndex(this.accessor)
    const tz = bucketZone(this.accessor, calendars)
    const prefix = mountPrefixOf(root.virtual, root.vfsPath)
    const match = detectScope(root)
    const wanted = match.kind === ROOT ? null : (match.slots.calendar ?? null)
    const decoded = decode(checkpoint)
    const [zone, previous, shown] = decoded ?? [null, null, new Map<string, string>()]
    const states = new Map<string, CalendarState>()
    const details = new Map<string, string>()
    const changes: [FileChangeKind, string][] = []
    for (const [name, entry] of [...calendars].sort(([a], [b]) => compareCodePoints(a, b))) {
      const calId = entry.id
      if ((wanted !== null && name !== wanted) || typeof calId !== 'string') continue
      const base = `${prefix}/${name}`
      const freeBusy = entry.accessRole === FREE_BUSY_ROLE
      let last = previous?.get(name) ?? null
      const shownNow = new TextDecoder().decode(calendarPayload(entry, tz))
      details.set(name, shownNow)
      if (previous !== null && last === null) changes.push([FileChangeKind.CREATE, base])
      else if (last !== null && shown.get(name) !== shownNow) {
        changes.push([FileChangeKind.UPDATE, `${base}/${CALENDAR_FILE}`])
      }
      if (last !== null && zone !== tz) last = [null, last[1]]
      states.set(
        name,
        await this.sync(calId, base, tz, freeBusy, last, last !== null ? changes : []),
      )
    }
    if (previous === null) {
      return new Delta({ changes: [], checkpoint: encode(tz, states, details) })
    }
    for (const name of [...previous.keys()].sort(compareCodePoints)) {
      if (!states.has(name) && (wanted === null || name === wanted)) {
        changes.push([FileChangeKind.DELETE, `${prefix}/${name}`])
      }
    }
    return new Delta({
      changes: changesUnder(root, changes, new Date()),
      checkpoint: encode(tz, states, details),
    })
  }

  /**
   * One calendar's events since its last sync, recorded as changes to its
   * files, and its state after them. Mirrors Python's `_sync`.
   */
  private async sync(
    calId: string,
    base: string,
    tz: string,
    freeBusy: boolean,
    last: CalendarState | null,
    changes: [FileChangeKind, string][],
  ): Promise<CalendarState> {
    const calendar = this.accessor.calendar
    const token = last?.[0] ?? null
    const known: Known = new Map(last?.[1] ?? [])
    let whole = token === null
    let events: Record<string, JsonValue>[]
    let next: string | null
    try {
      ;[events, next] = await calendar.syncEvents(calId, token, tz)
    } catch (err) {
      if ((err as { status?: unknown }).status !== 410) throw err
      console.debug(`gcal sync token for ${calId} expired: ${String(err)}`)
      whole = true
      ;[events, next] = await calendar.syncEvents(calId, null, tz)
    }
    const seen = new Set<string>()
    for (const event of events) {
      const eventId = textField(event, 'id')
      if (eventId === null) continue
      seen.add(eventId)
      const [before, stamp] = known.get(eventId) ?? [[], null]
      const after =
        event.status === 'cancelled' ? [] : eventPaths(this.accessor, base, event, tz, freeBusy)
      const updated = textField(event, 'updated')
      const same = known.has(eventId) && stamp === updated
      changes.push(...changesBetween(before, after, () => !same))
      if (after.length > 0) known.set(eventId, [after, updated])
      else known.delete(eventId)
    }
    if (whole) {
      for (const eventId of [...known.keys()].sort(compareCodePoints)) {
        if (seen.has(eventId)) continue
        changes.push(...changesBetween(known.get(eventId)?.[0] ?? [], [], () => false))
        known.delete(eventId)
      }
    }
    return [next, known]
  }
}

function encode(
  zone: string,
  states: ReadonlyMap<string, CalendarState>,
  details: ReadonlyMap<string, string>,
): string {
  const calendars: Record<string, JsonValue> = {}
  for (const [name, [token, known]] of states) {
    const events: Record<string, JsonValue> = {}
    for (const [eventId, [paths, updated]] of known) events[eventId] = { paths, updated }
    calendars[name] = { details: details.get(name) ?? '', events, token }
  }
  return sortedJson({ gcal: { calendars, zone } })
}

/**
 * The bucket zone, each calendar's state and each calendar's calendar.json a
 * checkpoint holds, null for a baseline. Mirrors Python's `_decode`.
 */
function decode(
  checkpoint: string | null,
): [string | null, Map<string, CalendarState>, Map<string, string>] | null {
  if (checkpoint === null) return null
  const data = JSON.parse(checkpoint) as { gcal?: { zone?: unknown; calendars?: unknown } }
  const state = data.gcal
  if (state === undefined) return null
  const out = new Map<string, CalendarState>()
  const details = new Map<string, string>()
  for (const [name, raw] of Object.entries((state.calendars ?? {}) as Record<string, unknown>)) {
    const row = raw as {
      token?: unknown
      details?: unknown
      events?: Record<string, { paths?: unknown; updated?: unknown }>
    }
    const known: Known = new Map()
    for (const [eventId, event] of Object.entries(row.events ?? {})) {
      const paths = Array.isArray(event.paths) ? event.paths.map(String) : []
      known.set(eventId, [paths, typeof event.updated === 'string' ? event.updated : null])
    }
    details.set(name, typeof row.details === 'string' ? row.details : '')
    out.set(name, [typeof row.token === 'string' ? row.token : null, known])
  }
  return [typeof state.zone === 'string' ? state.zone : null, out, details]
}

/** Build the Calendar delta hook (`GCalDeltaHook`). Mirrors Python's `build_delta_hook`. */
export function buildDeltaHook(accessor: GCalAccessor): DeltaHook {
  return new GCalDeltaHook(accessor)
}
