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
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { makeRead } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { compactJsonBytes } from '../render/json.ts'
import { listEvents } from './client.ts'
import { dayBounds } from './day.ts'
import { bucketZone, calendarIndex, calendarPayload, scopedBucket } from './readdir.ts'
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
 * Read one event's raw API payload.
 *
 * The event file holds the events.list item unmodified: the directory name
 * and the HHMM segment are a view, while the payload is the truth an
 * absolute-instant comparison has to be made against. Only the day the name
 * is on is queried, so a read in a multi-day bucket costs what one in a day
 * directory does.
 */
async function readEvent(
  accessor: GCalAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  const calendars = await calendarIndex(accessor)
  const entry = calendars.get(match.slots.calendar ?? '')
  if (entry === undefined) throw enoent(path.virtual)
  const tz = bucketZone(accessor, calendars)
  const calId = entry.id
  if (typeof calId !== 'string') throw enoent(path.virtual)
  const days = scopedBucket(accessor, match.slots.bucket ?? '', tz, path.virtual)
  const [eventId, named] = parseEventFilename(match.slots.event ?? '')
  // A name carries its day exactly when the mount's buckets span several.
  if ((named !== null) !== accessor.config.bucketDays > 1) throw enoent(path.virtual)
  const day = named ?? days[0] ?? ''
  if (!days.includes(day)) throw enoent(path.virtual)
  const [timeMin, timeMax] = dayBounds(day, tz)
  for (const event of await listEvents(
    accessor.tokenManager,
    calId,
    timeMin,
    timeMax,
    tz,
    accessor.timeRange,
  )) {
    if (event.id === eventId) return compactJsonBytes(event)
  }
  throw enoent(path.virtual)
}

export const read = makeRead<GCalAccessor>(detectScope, {
  calendar_json: readCalendarJson,
  event: readEvent,
})
