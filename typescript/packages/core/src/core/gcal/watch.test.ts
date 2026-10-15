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

import { expect, it, vi } from 'vitest'
import { FileChangeKind } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import { EVENTS, event, makeAccessor, PRIMARY, spec } from './_test_util.ts'

const syncs = vi.hoisted(() => ({
  answers: new Map<string | null, unknown>(),
  asked: [] as (string | null)[],
}))

vi.mock('./client.ts', async () => ({
  ...(await import('./_test_util.ts')).CLIENT,
  syncEvents: (_tm: unknown, calendarId: string, token: string | null) => {
    expect(calendarId).toBe(PRIMARY.id)
    syncs.asked.push(token)
    const answer = syncs.answers.get(token)
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  },
}))

const { buildDeltaHook } = await import('./watch.ts')

const DAY = '/primary/2026-08-11'
const MOVED: Record<string, JsonValue> = {
  ...event('aaaa1', 'PhD Defense', '2026-08-11T10:00:00+08:00', '2026-08-11T11:30:00+08:00'),
  updated: '2026-08-02T00:00:00.000Z',
}
const NEW = event('ffff6', 'Retro', '2026-08-12T09:00:00+08:00', '2026-08-12T10:00:00+08:00')

function gone(): Error {
  return Object.assign(new Error('gone'), { status: 410 })
}

// Twin of test_a_watch_follows_each_event_s_files.
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
