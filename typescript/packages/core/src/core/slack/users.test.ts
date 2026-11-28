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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { SlackWorkspace, USER, USERS } from '../../../tests/core/slack/workspace.ts'
import { getUserProfile, listUsers, searchUsers } from './users.ts'

let origin = ''
let workspace: SlackWorkspace

beforeAll(async () => {
  origin = await serve('slack')
})

beforeEach(async () => {
  workspace = new SlackWorkspace(origin)
  await workspace.reset()
})

afterEach(async () => {
  await workspace.close()
})

function ids(users: { id?: string }[]): (string | undefined)[] {
  return users.map((u) => u.id)
}

describe('listUsers', () => {
  it('calls users.list with limit=200 by default', async () => {
    await listUsers(workspace.accessor())
    expect((await workspace.run.params('GET', USERS))[0]).toMatchObject({ limit: '200' })
  })

  it('filters out deleted, bots, and USLACKBOT', async () => {
    // The workspace also holds a bot, a deactivated user and Slackbot.
    expect(ids(await listUsers(workspace.accessor()))).toEqual(['U1', 'U2'])
  })

  it('returns empty when members missing', async () => {
    await workspace.run.answerNext('GET', USERS, 200, { ok: true })
    expect(await listUsers(workspace.accessor())).toEqual([])
  })

  it('respects custom limit', async () => {
    await listUsers(workspace.accessor(), { limit: 50 })
    expect((await workspace.run.params('GET', USERS))[0]).toMatchObject({ limit: '50' })
  })

  it('paginates via response_metadata.next_cursor across pages', async () => {
    await workspace.firstPage(USERS, 1)
    expect(ids(await listUsers(workspace.accessor()))).toEqual(['U1', 'U2'])
    const asked = await workspace.run.params('GET', USERS)
    expect(asked).toHaveLength(2)
    expect(asked[1]?.cursor).not.toBe('')
  })

  it('stops paginating when next_cursor is empty / missing', async () => {
    await listUsers(workspace.accessor())
    expect(await workspace.count(USERS)).toBe(1)
  })
})

describe('getUserProfile', () => {
  it('calls users.info with the user id', async () => {
    const out = await getUserProfile(workspace.accessor(), 'U1')
    expect(await workspace.run.params('GET', USER)).toEqual([{ user: 'U1' }])
    expect([out.id, out.name]).toEqual(['U1', 'ana'])
  })

  it('returns empty object when user missing in response', async () => {
    await workspace.run.answerNext('GET', USER, 200, { ok: true })
    expect(await getUserProfile(workspace.accessor(), 'U1')).toEqual({})
  })
})

describe('searchUsers', () => {
  it('matches case-insensitive on name', async () => {
    expect(ids(await searchUsers(workspace.accessor(), 'ANA'))).toEqual(['U1'])
  })

  it('matches on real_name', async () => {
    expect(ids(await searchUsers(workspace.accessor(), 'ito'))).toEqual(['U2'])
  })

  it('matches on profile.email', async () => {
    expect(ids(await searchUsers(workspace.accessor(), 'ben@example.com'))).toEqual(['U2'])
  })

  it('respects deleted/bot/USLACKBOT filter (transitively via listUsers)', async () => {
    // bot-helper is the bot's name.
    expect(await searchUsers(workspace.accessor(), 'bot')).toEqual([])
  })
})

// Twin of test_list_users_pages_no_further_than_stop_at.
it('pages users no further than stopAt', async () => {
  await workspace.firstPage(USERS, 1)
  const users = await listUsers(workspace.accessor(), { stopAt: 1 })
  expect(users.map((u) => u.name)).toEqual(['ana'])
  expect(await workspace.count(USERS)).toBe(1)
})
