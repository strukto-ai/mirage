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

import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { FileChangeKind } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { EVENTS, GoogleAccount } from '../../../tests/fixtures/google_account.ts'
import { HK, makeAccessor, seed, spec } from '../../../tests/fixtures/gcal_seed.ts'

const { buildDeltaHook, eventPaths } = await import('./events.ts')

const DAY = '/primary/2026-08-11'
const RETRO = '/primary/2026-08-12/ffff6__0900-1000_Retro.gcal.json'

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(() => {
  account = new GoogleAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

/** An events.list item. */
function event(id: string, summary: string, start: string, end: string): Record<string, JsonValue> {
  return { id, status: 'confirmed', summary, start: { dateTime: start }, end: { dateTime: end } }
}

/** The sync token each events request was asked from, null for a whole listing. */
async function syncTokens(): Promise<(string | null)[]> {
  return (await account.run.params('GET', EVENTS)).map((p) => p.syncToken ?? null)
}

// Twin of test_events_follow_each_event_s_files.
it("follows each event's files", async () => {
  await seed(account)
  await account.run.recordRequests()
  const hook = buildDeltaHook(makeAccessor(account))
  const root = spec('/primary')
  const first = await account.syncToken()
  const baseline = await hook.pull(root, null)
  expect(baseline.changes).toEqual([])
  await account.changeEvent('aaaa1', {
    start: { dateTime: '2026-08-11T10:00:00+08:00' },
    end: { dateTime: '2026-08-11T11:30:00+08:00' },
  })
  await account.deleteEvent('bbbb2')
  await account.event('Retro', '2026-08-12T09:00:00+08:00', '2026-08-12T10:00:00+08:00', {
    eventId: 'ffff6',
  })
  const second = await account.syncToken()
  const moved = await hook.pull(root, baseline.checkpoint)
  expect(moved.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
    [FileChangeKind.DELETE, `${DAY}/aaaa1__0900-1030_PhD_Defense.gcal.json`],
    [FileChangeKind.CREATE, `${DAY}/aaaa1__1000-1130_PhD_Defense.gcal.json`],
    [FileChangeKind.DELETE, `${DAY}/bbbb2__1500-1600_Committee_Meeting.gcal.json`],
    [FileChangeKind.CREATE, RETRO],
  ])
  // A token Calendar dropped is answered by the whole calendar, where only an
  // event whose stamp moved since is reported.
  await account.changeEvent('ffff6', { description: 'Bring notes' })
  await account.refuse(
    'GET',
    EVENTS,
    410,
    'Sync token is no longer valid, a full sync is required.',
    { reason: 'fullSyncRequired' },
  )
  const expired = await hook.pull(root, moved.checkpoint)
  expect(expired.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
    [FileChangeKind.UPDATE, RETRO],
  ])
  expect(await syncTokens()).toEqual([null, first, second, null])
})

// Twin of test_an_event_outside_the_time_range_is_no_file: the listing of its
// day leaves it out, so its changes name nothing.
it('names no file for an event outside the time range', () => {
  const accessor = makeAccessor(account, {
    startTime: '2026-08-12T12:00:00+08:00',
    endTime: '2026-08-12T18:00:00+08:00',
  })
  const outside = event('ffff6', 'Retro', '2026-08-12T09:00:00+08:00', '2026-08-12T10:00:00+08:00')
  const inside = event('eeee5', 'Lunch', '2026-08-12T13:00:00+08:00', '2026-08-12T14:00:00+08:00')
  expect(eventPaths(accessor, '/primary', outside, HK, false)).toEqual([])
  expect(eventPaths(accessor, '/primary', inside, HK, false)).toEqual([
    '/primary/2026-08-12/eeee5__1300-1400_Lunch.gcal.json',
  ])
})

// Twin of test_events_follow_a_calendar_s_details_and_zone.
it("follows a calendar's details and zone", async () => {
  // The primary calendar alone, holding one event.
  await account.reset()
  await account.event('PhD Defense', '2026-08-11T09:00:00+08:00', '2026-08-11T10:30:00+08:00', {
    eventId: 'aaaa1',
  })
  await account.run.recordRequests()
  const hook = buildDeltaHook(makeAccessor(account))
  const root = spec('/primary')
  const baseline = await hook.pull(root, null)
  // Its own details are its calendar.json, which no event names.
  await account.changeCalendar({ summary: 'Renamed' })
  const renamed = await hook.pull(root, baseline.checkpoint)
  expect(renamed.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
    [FileChangeKind.UPDATE, '/primary/calendar.json'],
  ])
  // A new zone moves the day an event falls on: it is synced whole.
  await account.changeCalendar({ timeZone: 'America/Los_Angeles' })
  const moved = await hook.pull(root, renamed.checkpoint)
  expect((await syncTokens()).at(-1)).toBeNull()
  expect(moved.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
    [FileChangeKind.UPDATE, '/primary/calendar.json'],
    [FileChangeKind.DELETE, `${DAY}/aaaa1__0900-1030_PhD_Defense.gcal.json`],
    [FileChangeKind.CREATE, '/primary/2026-08-10/aaaa1__1800-1930_PhD_Defense.gcal.json'],
  ])
})
