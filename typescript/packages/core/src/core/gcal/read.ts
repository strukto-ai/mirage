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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { CALENDAR_FILE, parseEventFilename } from '../../resource/gcal/event_entry.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { dayBounds } from './day.ts'
import { listEvents } from './client.ts'
import { bucketZone, calendarIndex, calendarPayload, normalize } from './readdir.ts'

const ENC = new TextEncoder()

/**
 * Read one calendar.json or one event's raw API payload.
 *
 * The event file holds the events.list item unmodified: the directory name
 * and the HHMM segment are a view, while the payload is the truth an
 * absolute-instant comparison has to be made against.
 */
export async function read(
  accessor: GCalAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const [, key] = normalize(path)
  const parts = key === '' ? [] : key.split('/')
  const [calName = '', day = '', file = ''] = parts
  if (parts.length < 2) throw eisdir(path.virtual)

  const calendars = await calendarIndex(accessor)
  const entry = calendars.get(calName)
  if (entry === undefined) throw enoent(path.virtual)
  const tz = bucketZone(accessor, calendars)

  if (parts.length === 2 && day === CALENDAR_FILE) return calendarPayload(entry, tz)
  if (parts.length !== 3) throw enoent(path.virtual)

  const calId = entry.id
  if (typeof calId !== 'string') throw enoent(path.virtual)
  const [eventId] = parseEventFilename(file)
  const [timeMin, timeMax] = dayBounds(day, tz)
  for (const event of await listEvents(accessor.tokenManager, calId, timeMin, timeMax, tz)) {
    if (event.id === eventId) return ENC.encode(JSON.stringify(event))
  }
  throw enoent(path.virtual)
}
