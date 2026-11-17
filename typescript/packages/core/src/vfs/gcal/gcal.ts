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

import { GCalAccessor } from '../../accessor/gcal.ts'
import { bucketName, bucketStart } from '../../core/gcal/day.ts'
import { buildDeltaHook } from '../../core/gcal/events.ts'
import { read as gcalRead, readMany as gcalReadMany } from '../../core/gcal/read.ts'
import { readdir as gcalReaddir } from '../../core/gcal/readdir.ts'
import { filesContaining as gcalFilesContaining } from '../../core/gcal/search.ts'
import { stat as gcalStat } from '../../core/gcal/stat.ts'
import { unlink as gcalUnlink } from '../../core/gcal/unlink.ts'
import { TokenManager } from '../../core/google/client.ts'
import type { DeltaHook } from '../../events/base.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { VFSName, type DirListing } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { RedactedSchema } from '../secrets.ts'
import type { ConfigState, Handed } from '../types.ts'
import { GCalConfig } from './config.ts'

export const VFS_MD = `\`\`\`text
{prefix}
  primary/
    calendar.json
    {bucket}/
      <eventId>__{day}0900-1030_Team_Standup.gcal.json
  Engineering__team@group.calendar.google.com/
    {bucket}/
      ...
\`\`\`

- Calendars are \`primary\` and \`<Name>__<calendarId>\`; \`calendar.json\`
  holds the calendar's \`accessRole\` and \`bucketTimeZone\`, the zone every
  bucket is cut in.
{layout}
- \`cat\` an event for the raw Calendar API JSON (attendees, description,
  location, start and end with offsets).
- A listing runs through today +90 days unless \`end_time\` is set; a date
  glob such as \`2027-03-*\` reaches past that.
- On a \`write\` path, \`rm\` an event file deletes it for every attendee.
  Other changes go through the \`gws calendar\` CLI, with explicit offsets
  or a \`timeZone\`.`

export const DAY_VFS_MD = `- A bucket is one local day. A file is
  \`<eventId>__<HHMM-HHMM>_<Title>.gcal.json\`, times clamped to the day; a
  multi-day event appears under each day.`

export const BUCKET_VFS_MD = `- A bucket is {days} local days on a fixed grid (7-day buckets run Monday
  to Sunday). A file is
  \`<eventId>__<YYYY-MM-DD>_<HHMM-HHMM>_<Title>.gcal.json\`, one per day the
  event covers, times clamped to that day.`

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
  override readonly searchNeedsWalkLimit: boolean = true
  // Calendar's search answers for events; calendar.json is always read.
  override readonly searchable: readonly string[] = ['*/*/*.gcal.json']
  readonly config: GCalConfig
  override readonly accessor: GCalAccessor

  // A config built by hand skips the schema, so its default is applied here.
  constructor(options: Omit<GCalConfig, 'bucketDays'> & Partial<Pick<GCalConfig, 'bucketDays'>>) {
    super()
    const config: GCalConfig = { ...options, bucketDays: options.bucketDays ?? 1 }
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GCalAccessor({
      tokenManager: tm,
      config,
      capped: () => this.walkLimit >= 0,
    })
    this.vfsMd = treeVfsMd(config.bucketDays) + this.accessor.timeRange.vfsMd()
  }

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return gcalReaddir(this.accessor, path)
  }

  override async read(path: PathSpec): Promise<Uint8Array> {
    return gcalRead(this.accessor, path)
  }

  override readMany(paths: PathSpec[], limit: number): Promise<Map<string, Uint8Array>> {
    return gcalReadMany(this.accessor, paths, limit)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
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

  override getState(): Promise<ConfigState<RedactedSchema<typeof GCalConfig>>> {
    return Promise.resolve(this.configState(GCalConfig, this.config))
  }
}
