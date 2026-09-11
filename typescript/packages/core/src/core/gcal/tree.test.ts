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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GCalAccessor } from '../../accessor/gcal.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { ContentType, FileType, type JsonValue, PathSpec } from '../../types.ts'
import { TokenManager } from '../google/client.ts'
import { eventSpan } from './day.ts'

const HK = 'Asia/Hong_Kong'

const PRIMARY = {
  id: 'integ@example.com',
  summary: 'Integ User',
  timeZone: HK,
  accessRole: 'owner',
  primary: true,
}
const TEAM = {
  id: 'team@group.calendar.google.com',
  summary: 'Engineering',
  timeZone: 'America/Los_Angeles',
  accessRole: 'reader',
}
const SHARED = {
  id: 'busy@group.calendar.google.com',
  summary: 'Exec',
  timeZone: HK,
  accessRole: 'freeBusyReader',
}

function timed(id: string, summary: string, start: string, end: string): Record<string, JsonValue> {
  return {
    id,
    status: 'confirmed',
    summary,
    start: { dateTime: start },
    end: { dateTime: end },
    updated: '2026-08-01T00:00:00.000Z',
  }
}

function allDay(
  id: string,
  summary: string,
  start: string,
  end: string,
): Record<string, JsonValue> {
  return {
    id,
    status: 'confirmed',
    summary,
    start: { date: start },
    end: { date: end },
    updated: '2026-08-01T00:00:00.000Z',
  }
}

const EVENTS: Record<string, JsonValue>[] = [
  timed('aaaa1', 'PhD Defense', '2026-08-11T09:00:00+08:00', '2026-08-11T10:30:00+08:00'),
  timed('bbbb2', 'Committee Meeting', '2026-08-11T15:00:00+08:00', '2026-08-11T16:00:00+08:00'),
  timed('cccc3', 'Conference', '2026-08-10T09:00:00+08:00', '2026-08-13T17:00:00+08:00'),
  allDay('dddd4', 'Public Holiday', '2026-08-11', '2026-08-12'),
  timed('eeee5', 'Last Year', '2025-01-05T09:00:00+08:00', '2025-01-05T10:00:00+08:00'),
]

const listed: [string, string, string][] = []
const deleted: [string, string][] = []

vi.mock('./client.ts', () => ({
  listCalendars: (_tm: unknown, minAccessRole?: string) => {
    const all = [PRIMARY, TEAM, SHARED]
    if (minAccessRole === undefined || minAccessRole === '') return Promise.resolve(all)
    return Promise.resolve(all.filter((c) => c.accessRole === minAccessRole))
  },
  listEvents: (
    _tm: unknown,
    calendarId: string,
    timeMin: string,
    timeMax: string,
    timeZone?: string,
  ) => {
    listed.push([calendarId, timeMin, timeMax])
    const lo = Date.parse(timeMin)
    const hi = Date.parse(timeMax)
    const freeBusy = calendarId === SHARED.id
    const out: Record<string, JsonValue>[] = []
    for (const event of EVENTS) {
      const span = eventSpan(event, timeZone ?? HK)
      if (span === null) continue
      // timeMin bounds the END and timeMax the START, both exclusive.
      if (span[1] <= lo || span[0] >= hi) continue
      if (freeBusy) {
        // What Google actually returns for a freeBusyReader role:
        // availability with no summary, description or location.
        const rest: Record<string, JsonValue> = {}
        for (const [k, v] of Object.entries(event)) {
          if (k !== 'summary' && k !== 'description' && k !== 'location') rest[k] = v
        }
        out.push(rest)
        continue
      }
      out.push(event)
    }
    return Promise.resolve(out)
  },
  deleteEvent: (_tm: unknown, calendarId: string, eventId: string) => {
    deleted.push([calendarId, eventId])
    return Promise.resolve()
  },
}))

const { readdir, bucketZone, calendarIndex } = await import('./readdir.ts')
const { stat } = await import('./stat.ts')
const { read } = await import('./read.ts')
const { unlink } = await import('./unlink.ts')

function spec(virtual: string, pattern?: string): PathSpec {
  const directory =
    pattern !== undefined ? virtual.slice(0, virtual.lastIndexOf('/')) || '/' : virtual
  return new PathSpec({
    virtual,
    directory,
    resourcePath: virtual.replace(/^\//, ''),
    ...(pattern !== undefined ? { pattern } : {}),
  })
}

function lastListed(): [string, string, string] {
  const last = listed[listed.length - 1]
  if (last === undefined) throw new Error('no events.list call was made')
  return last
}

function names(paths: string[]): string[] {
  return paths.map((p) => p.slice(p.lastIndexOf('/') + 1))
}

function makeAccessor(overrides: Record<string, string> = {}): GCalAccessor {
  const config = {
    clientId: 'cid',
    refreshToken: 'rt',
    today: '2026-08-11',
    ...overrides,
  }
  return new GCalAccessor({ tokenManager: new TokenManager(config), config })
}

let accessor: GCalAccessor
let index: RAMIndexCacheStore

beforeEach(() => {
  accessor = makeAccessor()
  index = new RAMIndexCacheStore()
  listed.length = 0
  deleted.length = 0
})

describe('gcal readdir', () => {
  it('lists one directory per calendar at the root', async () => {
    expect(names(await readdir(accessor, spec('/'), index))).toEqual([
      'Engineering__team@group.calendar.google.com',
      'Exec__busy@group.calendar.google.com',
      'primary',
    ])
  })

  it('keeps the primary alias and carries the id on the others', async () => {
    const calendars = await calendarIndex(accessor)
    expect(calendars.get('primary')?.id).toBe('integ@example.com')
    expect(calendars.get('Engineering__team@group.calendar.google.com')?.id).toBe(
      'team@group.calendar.google.com',
    )
  })

  it('defaults the bucket zone to the primary calendar', async () => {
    // Not the reader calendar's America/Los_Angeles: one zone mount-wide.
    expect(bucketZone(accessor, await calendarIndex(accessor))).toBe(HK)
  })

  it('honours an explicit bucket zone override', async () => {
    const pinned = makeAccessor({ timeZone: 'Europe/Berlin' })
    expect(bucketZone(pinned, await calendarIndex(pinned))).toBe('Europe/Berlin')
  })

  it('lists only days holding events', async () => {
    expect(names(await readdir(accessor, spec('/primary'), index))).toEqual([
      'calendar.json',
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
    ])
  })

  it('omits days outside the window', async () => {
    // 2025-01-05 exists but sits far outside the -30/+90 day window.
    expect(names(await readdir(accessor, spec('/primary'), index))).not.toContain('2025-01-05')
  })

  it('escapes the default window with a date glob', async () => {
    const out = names(await readdir(accessor, spec('/primary/2025-01-*', '2025-01-*'), index))
    expect(out).toContain('2025-01-05')
    const last = lastListed()
    expect(last[1].startsWith('2025-01-01')).toBe(true)
    expect(last[2].startsWith('2025-02-01')).toBe(true)
  })

  it('lists one file per overlapping event', async () => {
    expect(names(await readdir(accessor, spec('/primary/2026-08-11'), index))).toEqual([
      'aaaa1__0900-1030_PhD_Defense.gcal.json',
      'bbbb2__1500-1600_Committee_Meeting.gcal.json',
      'cccc3__0000-2400_Conference.gcal.json',
      'dddd4__0000-2400_Public_Holiday.gcal.json',
    ])
  })

  it('shows a multi-day event under every day it covers', async () => {
    const cases: [string, string][] = [
      ['2026-08-10', '0900-2400'],
      ['2026-08-11', '0000-2400'],
      ['2026-08-12', '0000-2400'],
      ['2026-08-13', '0000-1700'],
    ]
    for (const [day, hhmm] of cases) {
      const out = names(await readdir(accessor, spec(`/primary/${day}`), index))
      expect(out).toContain(`cccc3__${hhmm}_Conference.gcal.json`)
    }
  })

  it('does not leak an all-day event past its exclusive end', async () => {
    const out = names(await readdir(accessor, spec('/primary/2026-08-12'), index))
    expect(out.some((n) => n.includes('Public_Holiday'))).toBe(false)
  })

  it('lists a day with no events as empty', async () => {
    expect(await readdir(accessor, spec('/primary/2027-03-04'), index)).toEqual([])
  })

  it('renders a free/busy calendar without titles', async () => {
    const out = names(
      await readdir(accessor, spec('/Exec__busy@group.calendar.google.com/2026-08-11'), index),
    )
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((n) => n.endsWith('_busy.gcal.json'))).toBe(true)
  })

  it('is ENOENT for an unknown calendar, a bad date and too deep a path', async () => {
    await expect(readdir(accessor, spec('/nope'), index)).rejects.toThrow()
    await expect(readdir(accessor, spec('/primary/not-a-date'), index)).rejects.toThrow()
    await expect(readdir(accessor, spec('/primary/2026-02-30'), index)).rejects.toThrow()
    await expect(readdir(accessor, spec('/primary/2026-08-11/x/y'), index)).rejects.toThrow()
  })

  it('centres the window in the bucket zone', async () => {
    await readdir(accessor, spec('/primary'), index)
    const last = lastListed()
    expect(last[1].endsWith('+08:00')).toBe(true)
    expect(last[2].endsWith('+08:00')).toBe(true)
  })
})

describe('gcal stat', () => {
  it('reports directories and event files', async () => {
    expect((await stat(accessor, spec('/'), index)).type).toBe(FileType.DIRECTORY)
    expect((await stat(accessor, spec('/primary'), index)).type).toBe(FileType.DIRECTORY)
    expect((await stat(accessor, spec('/primary/2026-08-11'), index)).type).toBe(FileType.DIRECTORY)
    const row = await stat(
      accessor,
      spec('/primary/2026-08-11/aaaa1__0900-1030_PhD_Defense.gcal.json'),
      index,
    )
    expect(row.content).toBe(ContentType.JSON)
    expect(row.extra.event_id).toBe('aaaa1')
    expect(row.size).toBeGreaterThan(0)
  })

  it('resolves an event-free day as an empty directory', async () => {
    // The range query over that day is positive proof of what is there, so
    // an empty day is an empty directory rather than ENOENT.
    const row = await stat(accessor, spec('/primary/2027-03-04'), index)
    expect(row.type).toBe(FileType.DIRECTORY)
  })

  it('is ENOENT for an impossible date or an unknown calendar', async () => {
    await expect(stat(accessor, spec('/primary/2026-02-30'), index)).rejects.toThrow()
    await expect(stat(accessor, spec('/nope/2027-03-04'), index)).rejects.toThrow()
  })
})

describe('gcal read', () => {
  it('renders calendar.json with the mount-wide bucket zone', async () => {
    const body = JSON.parse(
      new TextDecoder().decode(await read(accessor, spec('/primary/calendar.json'), index)),
    ) as Record<string, unknown>
    expect(body.id).toBe('integ@example.com')
    expect(body.accessRole).toBe('owner')
    expect(body.bucketTimeZone).toBe(HK)
  })

  it('serves the unmodified API payload for an event', async () => {
    const body = JSON.parse(
      new TextDecoder().decode(
        await read(
          accessor,
          spec('/primary/2026-08-11/aaaa1__0900-1030_PhD_Defense.gcal.json'),
          index,
        ),
      ),
    ) as Record<string, unknown>
    expect(body.id).toBe('aaaa1')
    expect(body.summary).toBe('PhD Defense')
    expect(body.start).toEqual({ dateTime: '2026-08-11T09:00:00+08:00' })
  })
})

describe('gcal unlink', () => {
  it('deletes the event the path names', async () => {
    await unlink(
      accessor,
      spec('/primary/2026-08-11/aaaa1__0900-1030_PhD_Defense.gcal.json'),
      index,
    )
    expect(deleted).toEqual([['integ@example.com', 'aaaa1']])
  })

  it('refuses a calendar the account cannot write', async () => {
    await expect(
      unlink(
        accessor,
        spec(
          '/Engineering__team@group.calendar.google.com/2026-08-11/aaaa1__0900-1030_X.gcal.json',
        ),
        index,
      ),
    ).rejects.toThrow()
    expect(deleted).toEqual([])
  })
})
