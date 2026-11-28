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
import { DiscordGuild, GUILD, MEMBER_SEARCH, MEMBERS } from '../../../tests/core/discord/guild.ts'
import { listMembers, searchMembers } from './members.ts'

let origin = ''
let guild: DiscordGuild

beforeAll(async () => {
  origin = await serve('discord')
})

beforeEach(async () => {
  guild = new DiscordGuild(origin)
  await guild.reset()
})

afterEach(async () => {
  await guild.close()
})

function names(members: { user?: { username?: string } }[]): (string | undefined)[] {
  return members.map((m) => m.user?.username)
}

describe('listMembers', () => {
  it('GETs /guilds/<id>/members with default page size', async () => {
    const out = await listMembers(guild.accessor(), GUILD)
    const [params] = await guild.run.params('GET', MEMBERS)
    expect([params?.after, params?.limit]).toEqual(['0', '1000'])
    expect(names(out)).toEqual(['alice', 'bob', 'mirage-bot'])
  })

  it('honors custom page size', async () => {
    await listMembers(guild.accessor(), GUILD, 50)
    expect((await guild.run.params('GET', MEMBERS))[0]?.limit).toBe('50')
  })

  it('returns empty array on non-array response', async () => {
    await guild.run.answerNext('GET', MEMBERS, 200, null)
    expect(await listMembers(guild.accessor(), GUILD)).toEqual([])
  })
})

describe('searchMembers', () => {
  it('GETs /guilds/<id>/members/search with query and limit', async () => {
    const out = await searchMembers(guild.accessor(), GUILD, 'ali')
    expect(await guild.run.params('GET', MEMBER_SEARCH)).toEqual([{ query: 'ali', limit: '100' }])
    expect(names(out)).toEqual(['alice'])
  })

  it('honors custom limit', async () => {
    await searchMembers(guild.accessor(), GUILD, 'bob', 25)
    expect(await guild.run.params('GET', MEMBER_SEARCH)).toEqual([{ query: 'bob', limit: '25' }])
  })

  it('returns empty array on non-array response', async () => {
    await guild.run.answerNext('GET', MEMBER_SEARCH, 200, null)
    expect(await searchMembers(guild.accessor(), GUILD, 'x')).toEqual([])
  })
})

// Twin of test_list_members_pages_no_further_than_stop_at.
it('pages members no further than stopAt', async () => {
  const out = await listMembers(guild.accessor(), GUILD, 1, 1)
  expect(names(out)).toEqual(['alice'])
  expect(await guild.count(MEMBERS)).toBe(1)
})
