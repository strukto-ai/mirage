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
import type { JsonValue } from '../../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import { MAX_RETRIES } from '../google/constants.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import {
  EVENTS,
  GoogleAccount,
  PRIMARY,
  UNTIL_CLEARED,
} from '../../../tests/fixtures/google_account.ts'
import { makeAccessor, spec } from '../../../tests/fixtures/gcal_seed.ts'

const { filesContaining } = await import('./search.ts')

const DAY = '2026-08-11'
const NOTHING = { kind: 'calendar#events', items: [] }

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

// The primary calendar holding three events on DAY, its requests recorded
// from here.
beforeEach(async () => {
  account = new GoogleAccount(origin)
  const [start, end] = [`${DAY}T09:00:00+08:00`, `${DAY}T10:00:00+08:00`]
  await account.reset()
  await account.event('PhD Defense', start, end, { eventId: 'aaaa1' })
  await account.event('Weekly sync-up', start, end, {
    eventId: 'bbbb2',
    fields: { description: 'Q&amp;A after' },
  })
  await account.event('Lunch', start, end, { eventId: 'cccc3', fields: { location: 'Room 4' } })
  await account.run.recordRequests()
})

afterEach(async () => {
  await account.run.close()
})

async function ids(
  text: string,
  under = '/',
  config: Record<string, JsonValue> = {},
  clock?: ManualClock,
): Promise<string[] | null> {
  const accessor = makeAccessor(account, config, () => true, clock)
  const out = await filesContaining(accessor, text, [spec(under)])
  if (out === null) return null
  return out.map((p) => (p.virtual.split('/').at(-1) ?? '').split('__')[0] ?? '').sort()
}

/** The query string the last search for `word` was sent with. */
async function searchQuery(word: string): Promise<string> {
  const asked = (await account.asked('GET', EVENTS))
    .map((r) => r.query)
    .filter((query) => new URLSearchParams(query).get('q') === word)
  const last = asked.at(-1)
  if (last === undefined) throw new Error(`no search for ${word}`)
  return last
}

/** How many requests each answer armed on the fake has served. */
async function served(): Promise<number[]> {
  const listed = await account.run.call<{ plans: { served: number }[] }>('GET', '/_kit/faults')
  return listed.plans.map((plan) => plan.served)
}

// Twins of python/tests/core/gcal/test_search.py. Calendar's search names
// the events whose own words hold the text; the rest of an event's file (ids,
// status, times) is the listing's to check.
it('names events by search and checks the rest against the listing', async () => {
  expect(await ids('defense')).toEqual(['aaaa1'])
  expect(await account.calendarLog()).toContainEqual(['search', PRIMARY, 'defense'])
  expect(await ids('confirmed')).toEqual(['aaaa1', 'bbbb2', 'cccc3'])
})

// A word the search may split otherwise (hyphenated, an entity) is kept by the
// listing, and each word of a phrase is found in either place. The fake's
// search finds both words, so each is searched once as it is, and then with
// the search finding nothing for it, as Calendar's may.
it('keeps a word the search may split otherwise in the listing', async () => {
  expect(await ids('sync')).toEqual(['bbbb2'])
  expect(await ids('amp')).toEqual(['bbbb2'])
  for (const word of ['sync', 'amp']) {
    const query = await searchQuery(word)
    await account.run.answerNext('GET', EVENTS, 200, NOTHING, UNTIL_CLEARED, undefined, query)
  }
  expect(await ids('sync')).toEqual(['bbbb2'])
  expect(await ids('amp')).toEqual(['bbbb2'])
  expect(await ids('Weekly sync')).toEqual(['bbbb2'])
  expect(await ids('room')).toEqual(['cccc3'])
  expect(await served()).toEqual([2, 1])
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
  const accessor = makeAccessor(account, {}, () => false)
  const out = await filesContaining(accessor, 'lunch', [spec('/')])
  expect(out).toBeNull()
})

it('reads every file when the search connection drops', async () => {
  // The connection drops on the search and on each retry of it; the
  // listings are served.
  expect(await ids('lunch')).toEqual(['cccc3'])
  const query = await searchQuery('lunch')
  await account.run.answerNext('GET', EVENTS, null, undefined, UNTIL_CLEARED, undefined, query)
  expect(await ids('lunch', '/', {}, new ManualClock())).toBeNull()
  expect(await served()).toEqual([1 + MAX_RETRIES])
})

it('reads every file when the search runs past the page cap', async () => {
  // Each page of the search names a next one, so it runs past the cap.
  expect(await ids('lunch')).toEqual(['cccc3'])
  const query = await searchQuery('lunch')
  const page = { ...NOTHING, nextPageToken: '1' }
  for (const asked of [query, `${query}&pageToken=1`]) {
    await account.run.answerNext('GET', EVENTS, 200, page, UNTIL_CLEARED, undefined, asked)
  }
  expect(await ids('lunch')).toBeNull()
  expect(await served()).toEqual([1, 49])
})

// A read fetches the event as it is now, and so does the search: each bucket
// is listed again rather than served from the walk's listing.
it('finds a text changed since the listing', async () => {
  const accessor = makeAccessor(account)
  const search = async (text: string) => {
    const out = await filesContaining(accessor, text, [spec('/')])
    return out === null
      ? null
      : out.map((p) => (p.virtual.split('/').at(-1) ?? '').split('__')[0] ?? '')
  }
  expect(await search('tentative')).toBeNull()
  await account.changeEvent('aaaa1', { status: 'tentative' })
  expect(await search('tentative')).toEqual(['aaaa1'])
})
