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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { API, EVENTS, HK, makeAccessor, spec } from './_test_util.ts'

vi.mock('./client.ts', async () => (await import('./_test_util.ts')).CLIENT)

const { read, readMany } = await import('./read.ts')

const WEEK = '/primary/2026-08-10--2026-08-16'
const PHD = 'aaaa1__0900-1030_PhD_Defense.gcal.json'
const DATED_PHD = 'aaaa1__2026-08-11_0900-1030_PhD_Defense.gcal.json'

let index: RAMIndexCacheStore

beforeEach(() => {
  API.reset()
  index = new RAMIndexCacheStore()
})

function parsed(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

describe('gcal read', () => {
  it.each([
    [1, `/primary/2026-08-11/${PHD}`],
    [7, `${WEEK}/${DATED_PHD}`],
    [30, `/primary/2026-08-09--2026-09-07/${DATED_PHD}`],
  ])('serves the unmodified API payload on a %i-day mount', async (size, path) => {
    // The names are a view; the payload, original offsets included, is what
    // an absolute-instant comparison is made against.
    expect(parsed(await read(makeAccessor({ bucket_days: size }), spec(path), index))).toEqual(
      EVENTS[0],
    )
    // Only the day the name is on is queried, whatever the bucket's size.
    expect(API.listed).toEqual([
      ['integ@example.com', '2026-08-11T00:00:00+08:00', '2026-08-12T00:00:00+08:00'],
    ])
  })

  // The reader calendar lives in Los Angeles, but every calendar is bucketed
  // mount-wide so each 2026-08-11 is the same window.
  it.each([
    [
      '/primary/calendar.json',
      { id: 'integ@example.com', accessRole: 'owner', primary: true, bucketTimeZone: HK },
    ],
    [
      '/Engineering__team@group.calendar.google.com/calendar.json',
      { calendarTimeZone: 'America/Los_Angeles', bucketTimeZone: HK },
    ],
  ])('renders %s with the role and bucket zone', async (path, fields) => {
    expect(parsed(await read(makeAccessor(), spec(path), index))).toMatchObject(fields)
  })

  it('reports a directory read as absence, the mount root as EISDIR', async () => {
    // A probed directory shape is no proof the node exists; the mount root,
    // which exists by construction, is the one EISDIR.
    await expect(read(makeAccessor(), spec('/primary'), index)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(read(makeAccessor(), spec('/'), index)).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  // A name carries its day exactly on a multi-day mount, and only a day of
  // its own bucket.
  it.each([
    [1, '/nope/calendar.json'],
    [1, '/primary/2026-08-11/zzzz9__0000-0100_Nope.gcal.json'],
    [1, '/primary/2026-08-11/notes.txt'],
    [1, `/primary/2026-08-11/${DATED_PHD}`],
    [7, `${WEEK}/${PHD}`],
    [7, `${WEEK}/aaaa1__2026-08-18_0900-1030_PhD_Defense.gcal.json`],
    [7, `/primary/2026-08-11/${PHD}`],
  ])('is ENOENT on a %i-day mount for %s', async (size, path) => {
    await expect(read(makeAccessor({ bucket_days: size }), spec(path), index)).rejects.toThrow()
  })
})

// Twin of test_a_batch_lists_each_day_once.
it('lists each day of a batch once', async () => {
  const day = '/primary/2026-08-11'
  const paths = [
    `${day}/${PHD}`,
    `${day}/bbbb2__1500-1600_Committee_Meeting.gcal.json`,
    `${day}/zzzz9__0000-0100_Nope.gcal.json`,
    '/primary/calendar.json',
  ]
  const answers = await readMany(
    makeAccessor(),
    paths.map((path) => spec(path)),
    1 << 20,
  )
  expect(new Map([...answers].map(([path, body]) => [path, parsed(body)]))).toEqual(
    new Map([
      [paths[0], EVENTS[0]],
      [paths[1], EVENTS[1]],
    ]),
  )
  expect(API.listed).toHaveLength(1)
  // An event past the limit is left out for its own read.
  const [small] = [...answers].sort(([, a], [, b]) => a.byteLength - b.byteLength)
  if (small === undefined) throw new Error('two events answered')
  const capped = await readMany(
    makeAccessor(),
    paths.map((path) => spec(path)),
    small[1].byteLength,
  )
  expect([...capped.keys()]).toEqual([small[0]])
})
