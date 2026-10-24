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

import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'
import { GCalAccessor } from '../../accessor/gcal.ts'

import { bucketName, bucketStart } from '../../core/gcal/day.ts'
import { TokenManager } from '../../core/google/client.ts'
import { type DirListing, VFSName } from '../../types.ts'

import { redactGCalConfig, type GCalConfig, type GCalConfigRedacted } from './config.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as gcalReaddir } from '../../core/gcal/readdir.ts'
import { filesContaining as gcalFilesContaining } from '../../core/gcal/search.ts'
import { read as gcalRead, readMany as gcalReadMany } from '../../core/gcal/read.ts'
import { stat as gcalStat } from '../../core/gcal/stat.ts'
import { unlink as gcalUnlink } from '../../core/gcal/unlink.ts'
import { buildDeltaHook } from '../../core/gcal/events.ts'
import type { DeltaHook } from '../../events/base.ts'

export const VFS_MD = `Google Calendar is mounted as one directory per calendar, one
directory per date bucket, and one JSON file per event.

    /<mount>/primary/calendar.json
    /<mount>/primary/{bucket}/<eventId>__{day}0900-1030_Team_Standup.gcal.json
    /<mount>/Engineering__team@group.calendar.google.com/{bucket}/...

Reading the tree:

- \`ls <mount>/\` lists the calendars. The primary one is always spelled
  \`primary\`; every other directory ends in \`__<calendarId>\`.
- \`ls <mount>/primary/\` lists buckets with events from all available history
  through today +90 days unless end_time is configured. start_time/end_time
  restrict this mount, including direct paths, date globs and event reads.
  A date glob such as \`ls <mount>/primary/2027-03-*\` selects its own
  listing range within that scope, beyond the default future horizon.
{layout}
- \`cat\` an event for the unmodified Calendar API payload, including
  attendees, description, location and the original start/end with offsets.
- \`calendar.json\` carries the calendar's accessRole and, in
  \`bucketTimeZone\`, the zone the buckets are cut in. That zone is
  mount-wide, so every calendar's \`{bucket}/\` covers the same hours.
- On a calendar shared as free/busy only, Google returns no titles at all,
  so events render as \`busy\`.

Acting on it:

- \`rm\` an event file to delete that event for every attendee.
- Everything else goes through the \`gws calendar\` CLI, which takes the ids
  the tree renders.
- A written event must carry an explicit UTC offset or timeZone; an
  ambiguous local time is not interpreted for you.
`

export const DAY_VFS_MD = `- A bucket is one local day, named by its date. A well-formed date inside
  the configured scope is a directory even when it holds no events. Dates
  outside the scope are absent.
- A file name is \`<eventId>__<HHMM-HHMM>_<Title>.gcal.json\`. The times are
  clamped to that day, so an event running through it reads \`0000-2400\`.
  A multi-day event appears under every day it covers.`

export const BUCKET_VFS_MD = `- A bucket is {days} local days, named by its first and last day on a
  fixed grid where 7-day buckets run Monday to Sunday. A bucket on the grid
  inside the configured scope is a directory even when it holds no events;
  a bare date, a span off the grid and a bucket outside the scope are
  absent. A glob matches the name, so \`2027-03-*\` finds the buckets that
  open in March.
- A file name is \`<eventId>__<YYYY-MM-DD>_<HHMM-HHMM>_<Title>.gcal.json\`,
  dated with its day. The times are clamped to that day, so an event
  running through it reads \`0000-2400\`. A multi-day event appears once for
  each day of the bucket it covers.`

const EXAMPLE_DAY = '2026-08-11'

/** The VFS.md text for a mount's tree, its examples named on that grid. */
function treeVfsMd(size: number): string {
  const layout = size === 1 ? DAY_VFS_MD : BUCKET_VFS_MD
  const bucket = bucketName(bucketStart(EXAMPLE_DAY, size), size)
  const day = size === 1 ? '' : `${EXAMPLE_DAY}_`
  return VFS_MD.replaceAll('{layout}', layout)
    .replaceAll('{days}', String(size))
    .replaceAll('{bucket}', bucket)
    .replaceAll('{day}', day)
}

export interface GCalVFSState {
  type: string
  config: GCalConfigRedacted
}

export class GCalVFS extends BaseVFS {
  override readonly handed = {
    stat: ['entry'],
    unlink: ['entry'],
  } as const

  override readonly name: string = VFSName.GCAL
  override readonly cachesReads: boolean = true
  // Shorter than the other Google mounts: a calendar is edited by other
  // people and a day-long index would keep serving a schedule that has
  // already moved.
  override readonly indexTtl: number = 300
  override vfsMd: string
  override readonly wholeWordSearch: boolean = true
  // Calendar's search answers for events; calendar.json is always read.
  override readonly searchable: readonly string[] = ['*/*/*.gcal.json']
  readonly config: GCalConfig
  override readonly accessor: GCalAccessor

  override readonly walkLimit: number

  constructor(config: GCalConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit
    const tm = new TokenManager(config)
    this.accessor = new GCalAccessor({ tokenManager: tm, config })
    this.vfsMd = treeVfsMd(config.bucketDays) + this.accessor.timeRange.vfsMd()
  }

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return gcalReaddir(this.accessor, path)
  }

  override async read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await gcalRead(this.accessor, path)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override readMany(paths: PathSpec[], limit: number): Promise<Map<string, Uint8Array>> {
    return gcalReadMany(this.accessor, paths, limit)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  /**
   * Whether this VFS answers `name`; with no walk limit it reads every
   * file rather than ask the service's search.
   */
  override supports(name: string): boolean {
    if (name === 'files_containing' && this.fullScanLimit < 0) return false
    return super.supports(name)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.walkLimit < 0) return Promise.resolve(null)
    return gcalFilesContaining(this.accessor, text, [path])
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return gcalStat(this.accessor, path, handed?.entry)
  }

  override unlink(path: PathSpec, handed?: Handed): Promise<void> {
    return gcalUnlink(this.accessor, path, handed?.entry)
  }

  override getState(): Promise<GCalVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGCalConfig(this.config),
    })
  }
}
