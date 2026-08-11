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
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { validDay } from './day.ts'
import { CALENDAR_JSON, EVENT, calendarIndex, normalize, readdir } from './readdir.ts'

/**
 * Stat one node of the calendar tree.
 *
 * A well-formed day directory resolves whether or not it holds an event:
 * the range query over that day is positive proof of what is there, so an
 * event-free day is an empty directory rather than a miss. Only a malformed
 * date, or one under a calendar that does not exist, is ENOENT.
 */
export async function stat(
  accessor: GCalAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const [prefix, key, virtualKey] = normalize(path)
  if (key === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })

  let entry = index !== undefined ? (await index.get(virtualKey)).entry : null
  if (entry === null || entry === undefined) {
    const parentVirtual = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    try {
      await readdir(
        accessor,
        new PathSpec({
          virtual: parentVirtual,
          directory: parentVirtual,
          resourcePath: mountKey(parentVirtual, prefix),
        }),
        index,
      )
    } catch {
      // A parent that cannot be listed just leaves the miss below to
      // decide; the calendar probe there is the authority.
      entry = null
    }
    entry = index !== undefined ? (await index.get(virtualKey)).entry : null
  }

  if (entry === null || entry === undefined) {
    const parts = key.split('/')
    if (parts.length === 2 && validDay(parts[1] as string)) {
      // Outside the default window, or a day with nothing on it. Ask the
      // calendar list rather than the index: the index only knows the
      // calendar once the ROOT has been listed, which a stat of a day two
      // levels down never triggers.
      const calendars = await calendarIndex(accessor)
      if (!calendars.has(parts[0] as string)) throw enoent(path.virtual)
      return new FileStat({ name: parts[1] as string, type: FileType.DIRECTORY })
    }
    throw enoent(path.virtual)
  }

  if (entry.resourceType === EVENT || entry.resourceType === CALENDAR_JSON) {
    return new FileStat({
      name: entry.vfsName,
      type: FileType.JSON,
      modified: entry.remoteTime,
      size: entry.size,
      extra: { event_id: entry.id, ...entry.extra },
    })
  }
  return new FileStat({ name: entry.vfsName, type: FileType.DIRECTORY })
}
