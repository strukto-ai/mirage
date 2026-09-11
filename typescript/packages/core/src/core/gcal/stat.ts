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
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat } from '../hierarchy/stat.ts'
import { calendarIndex, readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

function dirStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({ name: entry.vfsName, type: FileType.DIRECTORY })
}

function fileStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: ContentType.JSON,
    modified: entry.remoteTime,
    size: entry.size,
    extra: { event_id: entry.id, ...entry.extra },
  })
}

/**
 * Stat a day directory, which resolves whether or not it is listed.
 *
 * A well-formed day under a calendar that exists is a directory whether or
 * not it holds an event: the range query over that day is positive proof of
 * what is there, so an event-free day (or one outside the default listing
 * window) is an empty directory rather than a miss.
 */
async function statDay(
  accessor: GCalAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry !== null) return new FileStat({ name: entry.vfsName, type: FileType.DIRECTORY })
  // Ask the calendar list rather than the index: the index only knows the
  // calendar once the ROOT has been listed, which a stat of a day two
  // levels down never triggers.
  const calendars = await calendarIndex(accessor)
  if (!calendars.has(match.slots.calendar ?? '')) throw enoent(path.virtual)
  return new FileStat({ name: match.slots.day ?? '', type: FileType.DIRECTORY })
}

export const stat = makeStat(detectScope, readdir, {
  entryStats: {
    calendar: dirStat,
    calendar_json: fileStat,
    event: fileStat,
  },
  overrides: { day: statDay },
})
