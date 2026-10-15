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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat } from '../hierarchy/stat.ts'
import { calendarIndex, bucketZone, scopedBucket } from './readdir.ts'
import { detectScope } from './scope.ts'

/**
 * Stat a bucket directory, which resolves whether or not it is listed.
 *
 * A bucket on the mount's grid under a calendar that exists is a directory
 * whether or not it holds an event: the range query over it is positive
 * proof of what is there, so an event-free bucket (or one outside the
 * default listing window) is an empty directory rather than a miss.
 */
async function statBucket(
  accessor: GCalAccessor,
  match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
): Promise<FileStat> {
  const calendars = await calendarIndex(accessor)
  scopedBucket(accessor, match.slots.bucket ?? '', bucketZone(accessor, calendars), path.virtual)
  if (entry !== null) return entry
  if (!calendars.has(match.slots.calendar ?? '')) throw enoent(path.virtual)
  return new FileStat({ name: match.slots.bucket ?? '', type: FileType.DIRECTORY })
}

export const stat = makeStat(detectScope, { overrides: { bucket: statBucket } })
