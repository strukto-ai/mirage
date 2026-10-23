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

import { beforeEach, describe, expect, it } from 'vitest'
import type { GCalAccessor } from '../../accessor/gcal.ts'
import type { Workspace } from '../../workspace/workspace/workspace.ts'
import { MountMode, type DirListing, type PathSpec } from '../../types.ts'
import {
  API,
  HK,
  installCalendar,
  makeAccessor,
  names,
  spec,
} from '../../../tests/core/gcal/_test_util.ts'

const {
  readdir: gcalReaddir,
  bucketZone,
  calendarIndex,
  unsearchedText,
} = await import('./readdir.ts')
const { GCalVFS } = await import('../../vfs/gcal/gcal.ts')
const { Workspace: MountWorkspace } = await import('../../workspace/workspace/workspace.ts')
const MOUNTS = new WeakMap<GCalAccessor, Workspace>()

// The one mount a test asks an accessor through, at /m, so the listings one
// call keeps answer the next, as they do for a command.
function mounted(accessor: GCalAccessor): Workspace {
  let ws = MOUNTS.get(accessor)
  if (ws === undefined) {
    const vfs = Object.assign(new GCalVFS(accessor.config), { accessor })
    ws = new MountWorkspace({ '/m/': vfs }, { mode: MountMode.WRITE })
    MOUNTS.set(accessor, ws)
  }
  return ws
}

// The mounted spelling of a path below the mount.
function at(path: PathSpec): string {
  return path.virtual === '/' ? '/m' : `/m${path.virtual}`
}

async function readdir(accessor: GCalAccessor, path: PathSpec): Promise<string[]> {
  const listed = (await mounted(accessor).dispatch('readdir', at(path))) as string[]
  return listed.map((child) => child.slice('/m'.length))
}

const WEEK = '/primary/2026-08-10--2026-08-16'

beforeEach(() => {
  API.reset()
  installCalendar()
})

describe('gcal readdir', () => {
  it('lists one directory per calendar at the root', async () => {
    expect(names(await readdir(makeAccessor(), spec('/')))).toEqual([
      'Engineering__team@group.calendar.google.com',
      'Exec__busy@group.calendar.google.com',
      'primary',
    ])
  })

  it('keeps the primary alias and carries the id on the others', async () => {
    const calendars = await calendarIndex(makeAccessor())
    expect(calendars.get('primary')?.id).toBe('integ@example.com')
    expect(calendars.get('Engineering__team@group.calendar.google.com')?.id).toBe(
      'team@group.calendar.google.com',
    )
  })

  // Not the reader calendar's America/Los_Angeles: one zone mount-wide.
  it.each([
    [{}, HK],
    [{ time_zone: 'Europe/Berlin' }, 'Europe/Berlin'],
  ])('buckets %j in %s', async (overrides, tz) => {
    const accessor = makeAccessor(overrides)
    expect(bucketZone(accessor, await calendarIndex(accessor))).toBe(tz)
  })

  // All past events count, so last year's bucket is listed too.
  it.each([
    [1, ['2025-01-05', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']],
    [7, ['2024-12-30--2025-01-05', '2026-08-10--2026-08-16']],
    [30, ['2024-12-17--2025-01-15', '2026-08-09--2026-09-07']],
  ])('lists every %i-day bucket holding events', async (size, buckets) => {
    const out = await readdir(makeAccessor({ bucket_days: size }), spec('/primary'))
    expect(names(out)).toEqual(['calendar.json', ...buckets])
  })

  it('centres the window in the bucket zone', async () => {
    await readdir(makeAccessor(), spec('/primary'))
    expect(API.listed.at(-1)?.slice(1)).toEqual([null, '2026-11-09T16:00:00.000Z'])
  })

  it.each([
    [1, '2025-01-*', '2025-01-05', ['2024-12-31T16:00:00.000Z', '2025-01-31T16:00:00.000Z']],
    // Widened to whole weeks: January 1st falls in the week of Dec 30.
    [
      7,
      '2025-01-*',
      '2024-12-30--2025-01-05',
      ['2024-12-29T16:00:00.000Z', '2025-02-02T16:00:00.000Z'],
    ],
    [
      7,
      '2024-12-30--2025-01-05*',
      '2024-12-30--2025-01-05',
      ['2024-12-29T16:00:00.000Z', '2025-01-05T16:00:00.000Z'],
    ],
  ])('moves a %i-day window to the glob %s', async (size, glob, bucket, window) => {
    const accessor = makeAccessor({ bucket_days: size })
    // The backend's own listing for the glob word: the span it asks for,
    // before a shell matches names against it.
    const out = (await gcalReaddir(accessor, spec(`/primary/${glob}`, glob))) as DirListing
    expect(out.partial).toBe(true)
    expect(out.entries.map((row) => row.name)).toContain(bucket)
    expect(API.listed.at(-1)?.slice(1)).toEqual(window)
  })

  it('lists one file per overlapping event in a day', async () => {
    expect(names(await readdir(makeAccessor(), spec('/primary/2026-08-11')))).toEqual([
      'aaaa1__0900-1030_PhD_Defense.gcal.json',
      'bbbb2__1500-1600_Committee_Meeting.gcal.json',
      'cccc3__0000-2400_Conference.gcal.json',
      'dddd4__0000-2400_Public_Holiday.gcal.json',
    ])
  })

  it.each([
    ['2026-08-10', '0900-2400'],
    ['2026-08-11', '0000-2400'],
    ['2026-08-12', '0000-2400'],
    ['2026-08-13', '0000-1700'],
  ])('shows a multi-day event under %s as %s', async (day, hhmm) => {
    const out = names(await readdir(makeAccessor(), spec(`/primary/${day}`)))
    expect(out).toContain(`cccc3__${hhmm}_Conference.gcal.json`)
    // The all-day holiday's end date is exclusive: it stops at Aug 11.
    expect(out.some((n) => n.includes('Public_Holiday'))).toBe(day === '2026-08-11')
  })

  it('lists a week of days in one query', async () => {
    expect(names(await readdir(makeAccessor({ bucket_days: 7 }), spec(WEEK)))).toEqual([
      'aaaa1__2026-08-11_0900-1030_PhD_Defense.gcal.json',
      'bbbb2__2026-08-11_1500-1600_Committee_Meeting.gcal.json',
      'cccc3__2026-08-10_0900-2400_Conference.gcal.json',
      'cccc3__2026-08-11_0000-2400_Conference.gcal.json',
      'cccc3__2026-08-12_0000-2400_Conference.gcal.json',
      'cccc3__2026-08-13_0000-1700_Conference.gcal.json',
      'dddd4__2026-08-11_0000-2400_Public_Holiday.gcal.json',
    ])
    expect(API.listed).toEqual([
      ['integ@example.com', '2026-08-10T00:00:00+08:00', '2026-08-17T00:00:00+08:00'],
    ])
  })

  it('lists only the days of a scoped week inside the scope', async () => {
    const scoped = makeAccessor({ bucket_days: 7, start_time: '2026-08-12T00:00:00+08:00' })
    expect(names(await readdir(scoped, spec(WEEK)))).toEqual([
      'cccc3__2026-08-12_0000-2400_Conference.gcal.json',
      'cccc3__2026-08-13_0000-1700_Conference.gcal.json',
    ])
  })

  it.each([
    [1, '/primary/2027-03-04'],
    [7, '/primary/2027-03-01--2027-03-07'],
  ])('lists a %i-day bucket with no events as empty', async (size, path) => {
    expect(await readdir(makeAccessor({ bucket_days: size }), spec(path))).toEqual([])
  })

  it('renders a free/busy calendar without titles', async () => {
    const out = names(
      await readdir(makeAccessor(), spec('/Exec__busy@group.calendar.google.com/2026-08-11')),
    )
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((n) => n.endsWith('_busy.gcal.json'))).toBe(true)
  })

  // Each bucket has one spelling per mount: a span on a day mount, a bare day
  // or an off-grid span on a week mount name nothing.
  it.each([
    [{}, '/nope'],
    [{}, '/primary/not-a-date'],
    [{}, '/primary/2026-02-30'],
    [{}, '/primary/2026-08-11/x/y'],
    [{}, WEEK],
    [{ bucket_days: 7 }, '/primary/2026-08-11'],
    [{ bucket_days: 7 }, '/primary/2026-08-11--2026-08-17'],
    [{ bucket_days: 7, end_time: '2026-08-10T00:00:00+08:00' }, WEEK],
  ])('is ENOENT under %j for %s', async (overrides, path) => {
    await expect(readdir(makeAccessor(overrides), spec(path))).rejects.toThrow()
  })

  it('filters the calendar list by min_access_role', async () => {
    const owner = makeAccessor({ min_access_role: 'owner' })
    expect(names(await readdir(owner, spec('/')))).toEqual(['primary'])
  })
})

// Twin of test_unsearched_text_keeps_all_but_the_plain_words_the_search_reads.
it('keeps all but the plain words the search reads', () => {
  const kept = unsearchedText({
    id: 'x1',
    summary: 'Weekly sync-up',
    description: '<b>Agenda</b> notes, (draft)',
    status: 'confirmed',
  })
  expect(kept).toBe(
    '{"id":"x1","summary":"","description":"","status":"confirmed"} sync-up <b>agenda</b>',
  )
})
