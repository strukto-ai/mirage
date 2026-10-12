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
import { isFsError } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { recordQueries } from '../../utils/record_search.ts'
import { CALENDAR_FILE } from '../../vfs/gcal/event_entry.ts'
import { GoogleApiError } from '../google/client.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { ROOT } from '../hierarchy/scope.ts'
import { parseTime } from '../time_range.ts'
import { PAGE_LIMIT, listEvents } from './client.ts'
import { dayBounds } from './day.ts'
import { bucketZone, calendarIndex, normalize, readdir, scopedBucket } from './readdir.ts'
import { detectScope } from './scope.ts'

// The bucket directories under `scope`; null for a scope inside a bucket or a
// calendar's file.
async function buckets(
  accessor: GCalAccessor,
  scope: PathSpec,
  index: IndexCacheStore | undefined,
): Promise<PathSpec[] | null> {
  const match = detectScope(normalize(scope)[1])
  if (match.kind === 'bucket') return [scope]
  const base = scope.mountPath.replace(/\/+$/, '')
  let calendars: PathSpec[]
  if (match.kind === ROOT) {
    calendars = (await readdir(accessor, scope, index)).map((name) =>
      mountedPath(scope, `${base}/${name.split('/').at(-1) ?? name}`),
    )
  } else if (match.kind === 'calendar') {
    calendars = [scope]
  } else {
    return null
  }
  const found: PathSpec[] = []
  for (const calendar of calendars) {
    const parent = calendar.mountPath.replace(/\/+$/, '')
    for (const listed of await readdir(accessor, calendar, index)) {
      const leaf = listed.split('/').at(-1) ?? listed
      if (leaf !== CALENDAR_FILE) found.push(mountedPath(calendar, `${parent}/${leaf}`))
    }
  }
  return found
}

/**
 * The event files under `under` whose event holds every word of `text` where
 * Calendar's search finds it or where the listing kept it.
 *
 * Calendar searches an event's summary, description, location and people by
 * word, so each word is asked on its own over the walked buckets' time
 * window, and an event is read when each word is either found there or held
 * by the text the listing kept (`unsearchedText`): the event's other fields,
 * and the words of those three the search may split otherwise. The text goes
 * through `recordQueries` for its escapes. Null when the text cannot be
 * searched, a scope lies inside a bucket, a search fails or runs past
 * `MAX_PAGES` pages, or nothing is found. Mirrors Python's
 * `files_containing`.
 */
export async function filesContaining(
  accessor: GCalAccessor,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const queries = recordQueries(text, new Set(), true)
  if (queries === null) return null
  const asked = queries.map((query) => query.toLowerCase().split(/\s+/).filter(Boolean))
  const found: PathSpec[] = []
  try {
    const calendars = await calendarIndex(accessor)
    const tz = bucketZone(accessor, calendars)
    const walked = new Map<string, PathSpec[]>()
    for (const scope of under) {
      const listed = await buckets(accessor, scope, index)
      if (listed === null) return null
      for (const bucket of listed) {
        const name = detectScope(normalize(bucket)[1]).slots.calendar ?? ''
        walked.set(name, [...(walked.get(name) ?? []), bucket])
      }
    }
    for (const [name, listed] of walked) {
      const calId = calendars.get(name)?.id
      if (typeof calId !== 'string') return null
      const spans = listed.map((bucket) => {
        const slot = detectScope(normalize(bucket)[1]).slots.bucket ?? ''
        const days = scopedBucket(accessor, slot, tz, bucket.virtual)
        return dayBounds(days[0] ?? '', tz, days.length)
      })
      const [timeMin] = spans.reduce((a, b) => (parseTime(b[0]) < parseTime(a[0]) ? b : a))
      const [, timeMax] = spans.reduce((a, b) => (parseTime(b[1]) > parseTime(a[1]) ? b : a))
      const named = new Map<string, Set<string>>()
      for (const word of [...new Set(asked.flat())].sort(compareCodePoints)) {
        const events = await listEvents(
          accessor.tokenManager,
          calId,
          timeMin,
          timeMax,
          tz,
          accessor.timeRange,
          word,
        )
        named.set(
          word,
          new Set(events.map((event) => event.id).filter((id) => typeof id === 'string')),
        )
      }
      for (const bucket of listed) {
        const parent = bucket.mountPath.replace(/\/+$/, '')
        for (const child of await readdir(accessor, bucket, index)) {
          const path = mountedPath(bucket, `${parent}/${child.split('/').at(-1) ?? child}`)
          const entry = await resolveEntry(readdir, accessor, path, index)
          if (entry === null) return null
          const kept = entry.extra.unsearched
          if (typeof kept !== 'string') return null
          const held = asked.some((words) =>
            words.every((word) => named.get(word)?.has(entry.id) === true || kept.includes(word)),
          )
          if (held) found.push(path)
        }
      }
    }
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails and a
    // DOMException when its timeout aborts it; a body that is not JSON
    // rejects with a SyntaxError
    const failed =
      isFsError(err) ||
      err instanceof GoogleApiError ||
      err instanceof TypeError ||
      err instanceof DOMException ||
      err instanceof SyntaxError ||
      (err instanceof Error && err.message === PAGE_LIMIT)
    if (!failed) throw err
    console.warn(`calendar search failed (${String(err)}); reading every file`)
    return null
  }
  return found.length > 0 ? found : null
}
