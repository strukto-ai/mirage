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

import { beforeEach, expect, it } from 'vitest'
import { FileChangeKind } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import {
  API,
  EVENTS,
  event,
  HK,
  installCalendar,
  makeAccessor,
  PRIMARY,
  spec,
} from '../../../tests/core/gcal/_test_util.ts'

/** Calendar's incremental sync, scripted by the token it is asked from. */
const syncs = {
  answers: new Map<string | null, unknown>(),
  asked: [] as (string | null)[],
}

beforeEach(() => {
  installCalendar()
  API.syncs = (calendarId: string, token: string | null) => {
    expect(calendarId).toBe(PRIMARY.id)
    syncs.asked.push(token)
    const answer = syncs.answers.get(token)
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer as [Record<string, JsonValue>[], string | null])
  }
})

const { buildDeltaHook, eventPaths } = await import('./events.ts')

const DAY = '/primary/2026-08-11'
const MOVED: Record<string, JsonValue> = {
  ...event('aaaa1', 'PhD Defense', '2026-08-11T10:00:00+08:00', '2026-08-11T11:30:00+08:00'),
  updated: '2026-08-02T00:00:00.000Z',
}
const NEW = event('ffff6', 'Retro', '2026-08-12T09:00:00+08:00', '2026-08-12T10:00:00+08:00')

function gone(): Error {
  return Object.assign(new Error('gone'), { status: 410 })
}

// Twin of test_events_follow_each_event_s_files.
it("follows each event's files", async () => {
  syncs.answers.set(null, [[EVENTS[0], EVENTS[1]], 't1'])
  syncs.answers.set('t1', [[MOVED, { id: 'bbbb2', status: 'cancelled' }, NEW], 't2'])
  syncs.answers.set('t2', gone())
  const hook = buildDeltaHook(makeAccessor())
  const root = spec('/primary')
  const baseline = await hook.pull(root, null)
  expect(baseline.changes).toEqual([])
  const moved = await hook.pull(root, baseline.checkpoint)
  expect(moved.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
    [FileChangeKind.DELETE, `${DAY}/aaaa1__0900-1030_PhD_Defense.gcal.json`],
    [FileChangeKind.CREATE, `${DAY}/aaaa1__1000-1130_PhD_Defense.gcal.json`],
    [FileChangeKind.DELETE, `${DAY}/bbbb2__1500-1600_Committee_Meeting.gcal.json`],
    [FileChangeKind.CREATE, '/primary/2026-08-12/ffff6__0900-1000_Retro.gcal.json'],
  ])
  // A token Calendar dropped is answered by the whole calendar, where only an
  // event whose stamp moved since is reported.
  syncs.answers.set(null, [[MOVED, { ...NEW, updated: '2026-08-03T00:00:00.000Z' }], 't3'])
  const expired = await hook.pull(root, moved.checkpoint)
  expect(expired.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
    [FileChangeKind.UPDATE, '/primary/2026-08-12/ffff6__0900-1000_Retro.gcal.json'],
  ])
  expect(syncs.asked).toEqual([null, 't1', 't2', null])
})

// Twin of test_an_event_outside_the_time_range_is_no_file: the listing of its
// day leaves it out, so its changes name nothing.
it('names no file for an event outside the time range', () => {
  const accessor = makeAccessor({
    startTime: '2026-08-12T12:00:00+08:00',
    endTime: '2026-08-12T18:00:00+08:00',
  })
  const inside = event('eeee5', 'Lunch', '2026-08-12T13:00:00+08:00', '2026-08-12T14:00:00+08:00')
  expect(eventPaths(accessor, '/primary', NEW, HK, false)).toEqual([])
  expect(eventPaths(accessor, '/primary', inside, HK, false)).toEqual([
    '/primary/2026-08-12/eeee5__1300-1400_Lunch.gcal.json',
  ])
})

// Twin of test_events_follow_a_calendar_s_details_and_zone.
it("follows a calendar's details and zone", async () => {
  syncs.answers = new Map<string | null, unknown>([
    [null, [[EVENTS[0]], 't1']],
    ['t1', [[], 't2']],
  ])
  syncs.asked = []
  API.calendars = [PRIMARY]
  try {
    const hook = buildDeltaHook(makeAccessor())
    const root = spec('/primary')
    const baseline = await hook.pull(root, null)
    // Its own details are its calendar.json, which no event names.
    API.calendars = [{ ...PRIMARY, summary: 'Renamed' }]
    const renamed = await hook.pull(root, baseline.checkpoint)
    expect(renamed.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      [FileChangeKind.UPDATE, '/primary/calendar.json'],
    ])
    // A new zone moves the day an event falls on: it is synced whole.
    API.calendars = [{ ...PRIMARY, summary: 'Renamed', timeZone: 'America/Los_Angeles' }]
    syncs.answers.set(null, [[EVENTS[0]], 't3'])
    const moved = await hook.pull(root, renamed.checkpoint)
    expect(syncs.asked.at(-1)).toBeNull()
    expect(moved.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      [FileChangeKind.UPDATE, '/primary/calendar.json'],
      [FileChangeKind.DELETE, `${DAY}/aaaa1__0900-1030_PhD_Defense.gcal.json`],
      [FileChangeKind.CREATE, '/primary/2026-08-10/aaaa1__1800-1930_PhD_Defense.gcal.json'],
    ])
  } finally {
    API.reset()
  }
})
