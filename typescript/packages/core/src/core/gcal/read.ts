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
import { parseEventFilename } from '../../vfs/gcal/event_entry.ts'
import type { JsonValue, PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { makeRead } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { compactJsonBytes } from '../render/json.ts'
import { listEvents } from './client.ts'
import { dayBounds } from './day.ts'
import {
  bucketZone,
  type CalendarEntryRow,
  calendarIndex,
  calendarPayload,
  scopedBucket,
} from './readdir.ts'
import { detectScope } from './scope.ts'

async function readCalendarJson(
  accessor: GCalAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const calendars = await calendarIndex(accessor)
  const entry = calendars.get(match.slots.calendar ?? '')
  if (entry === undefined) throw enoent(path.virtual)
  return calendarPayload(entry, bucketZone(accessor, calendars))
}

/**
 * The calendar id, day and event id an event file names. Only the day the
 * name is on is listed for it, so a read in a multi-day bucket costs what one
 * in a day directory does. Mirrors Python's `_event_of`.
 */
function eventOf(
  accessor: GCalAccessor,
  calendars: Map<string, CalendarEntryRow>,
  match: ScopeMatch,
  path: PathSpec,
): [string, string, string] {
  const calId = calendars.get(match.slots.calendar ?? '')?.id
  if (typeof calId !== 'string') throw enoent(path.virtual)
  const days = scopedBucket(
    accessor,
    match.slots.bucket ?? '',
    bucketZone(accessor, calendars),
    path.virtual,
  )
  const [eventId, named] = parseEventFilename(match.slots.event ?? '')
  // A name carries its day exactly when the mount's buckets span several.
  if ((named !== null) !== accessor.config.bucketDays > 1) throw enoent(path.virtual)
  const day = named ?? days[0] ?? ''
  if (!days.includes(day)) throw enoent(path.virtual)
  return [calId, day, eventId]
}

/** The events one local day of a calendar holds. Mirrors Python's `_day_events`. */
async function dayEvents(
  accessor: GCalAccessor,
  calId: string,
  day: string,
  tz: string,
): Promise<Record<string, JsonValue>[]> {
  const [timeMin, timeMax] = dayBounds(day, tz)
  return listEvents(accessor.tokenManager, calId, timeMin, timeMax, tz, accessor.timeRange)
}

/**
 * Read one event's raw API payload.
 *
 * The event file holds the events.list item unmodified: the directory name
 * and the HHMM segment are a view, while the payload is the truth an
 * absolute-instant comparison has to be made against.
 */
async function readEvent(
  accessor: GCalAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const calendars = await calendarIndex(accessor)
  const [calId, day, eventId] = eventOf(accessor, calendars, match, path)
  for (const event of await dayEvents(accessor, calId, day, bucketZone(accessor, calendars))) {
    if (event.id === eventId) return compactJsonBytes(event)
  }
  throw enoent(path.virtual)
}

/**
 * Read several event files, listing each day they name once. A day's listing
 * answers every event asked of it, so a batch of one day's events costs what
 * one read does. A path that is not an event file, or names an event its day
 * does not hold, is left out for its own read to answer. Mirrors Python's
 * `read_many`.
 */
export async function readMany(
  accessor: GCalAccessor,
  paths: readonly PathSpec[],
): Promise<Map<string, Uint8Array>> {
  const calendars = await calendarIndex(accessor)
  const tz = bucketZone(accessor, calendars)
  const days = new Map<string, [string, string, Map<string, string>]>()
  for (const path of paths) {
    const match = detectScope(path)
    if (match.kind !== 'event') continue
    let named: [string, string, string]
    try {
      named = eventOf(accessor, calendars, match, path)
    } catch (err) {
      console.debug(`readMany leaves out ${path.virtual}: ${String(err)}`)
      continue
    }
    const [calId, day, eventId] = named
    const key = JSON.stringify([calId, day])
    const events = days.get(key) ?? [calId, day, new Map<string, string>()]
    events[2].set(eventId, path.virtual)
    days.set(key, events)
  }
  const answers = new Map<string, Uint8Array>()
  for (const [calId, day, events] of days.values()) {
    for (const event of await dayEvents(accessor, calId, day, tz)) {
      const virtual = typeof event.id === 'string' ? events.get(event.id) : undefined
      if (virtual !== undefined) answers.set(virtual, compactJsonBytes(event))
    }
  }
  return answers
}

export const read = makeRead<GCalAccessor>(detectScope, {
  calendar_json: readCalendarJson,
  event: readEvent,
})
