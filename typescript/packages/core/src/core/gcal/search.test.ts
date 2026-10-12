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

import { beforeEach, expect, it, vi } from 'vitest'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { JsonValue } from '../../types.ts'
import { API, CLIENT, PRIMARY, event, makeAccessor, spec } from './_test_util.ts'

vi.mock('./client.ts', async () => (await import('./_test_util.ts')).CLIENT)

const { filesContaining } = await import('./search.ts')
const { PAGE_LIMIT } = await import('./client.ts')

const DAY = '2026-08-11'

function day(id: string, summary: string, fields: Record<string, JsonValue> = {}) {
  return { ...event(id, summary, `${DAY}T09:00:00+08:00`, `${DAY}T10:00:00+08:00`), ...fields }
}

const EVENTS = [
  day('aaaa1', 'PhD Defense'),
  day('bbbb2', 'Weekly sync-up', { description: 'Q&amp;A after' }),
  day('cccc3', 'Lunch', { location: 'Room 4' }),
]

async function ids(
  text: string,
  under = '/',
  config: Record<string, unknown> = {},
): Promise<string[] | null> {
  const accessor = makeAccessor({ contentSearch: true, ...config })
  const out = await filesContaining(accessor, text, [spec(under)], new RAMIndexCacheStore())
  if (out === null) return null
  return out.map((p) => (p.virtual.split('/').at(-1) ?? '').split('__')[0] ?? '').sort()
}

beforeEach(() => {
  API.reset()
  API.calendars = [PRIMARY]
  API.events = EVENTS
})

// Twins of python/tests/core/gcal/test_search.py. Calendar's search names
// the events whose own words hold the text; the rest of an event's file (ids,
// status, times) is the listing's to check.
it('names events by search and checks the rest against the listing', async () => {
  expect(await ids('defense')).toEqual(['aaaa1'])
  expect(API.asked).toContainEqual(['integ@example.com', 'defense'])
  expect(await ids('confirmed')).toEqual(['aaaa1', 'bbbb2', 'cccc3'])
})

// A word the search may split otherwise (hyphenated, an entity) is kept by the
// listing, and each word of a phrase is found in either place.
it('keeps a word the search may split otherwise in the listing', async () => {
  expect(await ids('sync')).toEqual(['bbbb2'])
  expect(await ids('amp')).toEqual(['bbbb2'])
  expect(await ids('Weekly sync')).toEqual(['bbbb2'])
  expect(await ids('room')).toEqual(['cccc3'])
})

it('answers for a bucket scope and a multi-day mount', async () => {
  expect(await ids('lunch', `/primary/${DAY}`)).toEqual(['cccc3'])
  expect(await ids('lunch', '/', { bucketDays: 7 })).toEqual(['cccc3'])
})

it.each([
  // Nothing found, a digit, and a scope inside a bucket.
  ['nowhere', '/'],
  ['room4', '/'],
  ['lunch', `/primary/${DAY}/cccc3.gcal.json`],
])('reads every file for %j under %j', async (text, under) => {
  expect(await ids(text, under)).toBeNull()
})

it('reads every file when the listing kept no text', async () => {
  const out = await filesContaining(makeAccessor(), 'lunch', [spec('/')], new RAMIndexCacheStore())
  expect(out).toBeNull()
})

it.each([new TypeError('fetch failed'), new Error(PAGE_LIMIT)])(
  'reads every file when a search fails with %s',
  async (error) => {
    const listEvents = vi
      .spyOn(CLIENT, 'listEvents')
      .mockImplementation((_tm, calendarId, timeMin, timeMax, timeZone, scope, query) =>
        query === undefined
          ? Promise.resolve(API.listEvents(calendarId, timeMin, timeMax, timeZone, scope))
          : Promise.reject(error),
      )
    try {
      expect(await ids('lunch')).toBeNull()
    } finally {
      listEvents.mockRestore()
    }
  },
)
