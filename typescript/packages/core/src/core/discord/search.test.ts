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
import { ALICE, DiscordGuild, GENERAL, GUILD, SEARCH } from '../../../tests/core/discord/guild.ts'
import { searchGuild } from './search.ts'

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

async function thirty(): Promise<void> {
  // More hits than one search page holds.
  const start = Date.UTC(2024, 0, 20)
  await guild.addMessages(
    GENERAL,
    ALICE,
    Array.from({ length: 30 }, (_, i): [Date, string] => [
      new Date(start + i * 60_000),
      `msg${String(i)}`,
    ]),
  )
}

describe('searchGuild', () => {
  it('paginates until total is reached and sorts ascending', async () => {
    await thirty()
    const out = await searchGuild(guild.accessor(), GUILD, 'msg')
    const asked = await guild.run.params('GET', SEARCH)
    expect(asked).toEqual([
      { content: 'msg', offset: '0' },
      { content: 'msg', offset: '25' },
    ])
    expect(out.map((m) => m.content)).toEqual(
      Array.from({ length: 30 }, (_, i) => `msg${String(i)}`),
    )
  })

  it('forwards channel_id when provided', async () => {
    await searchGuild(guild.accessor(), GUILD, 'q', GENERAL)
    expect(await guild.run.params('GET', SEARCH)).toEqual([
      { content: 'q', offset: '0', channel_id: GENERAL },
    ])
  })

  it('omits channel_id when undefined or empty', async () => {
    await searchGuild(guild.accessor(), GUILD, 'q', '')
    expect(await guild.run.params('GET', SEARCH)).toEqual([{ content: 'q', offset: '0' }])
  })

  it('stops when limit is reached and slices the result', async () => {
    await thirty()
    const out = await searchGuild(guild.accessor(), GUILD, 'msg', undefined, 2)
    expect(out).toHaveLength(2)
    expect(await guild.count(SEARCH)).toBe(1)
  })

  it('breaks gracefully on non-dict response', async () => {
    await guild.run.answerNext('GET', SEARCH, 200, null)
    expect(await searchGuild(guild.accessor(), GUILD, 'q')).toEqual([])
  })

  it('breaks gracefully on array response', async () => {
    await guild.run.answerNext('GET', SEARCH, 200, [])
    expect(await searchGuild(guild.accessor(), GUILD, 'q')).toEqual([])
  })

  it('breaks when messages array is empty', async () => {
    await guild.run.answerNext('GET', SEARCH, 200, { total_results: 999, messages: [] })
    expect(await searchGuild(guild.accessor(), GUILD, 'q')).toEqual([])
    expect(await guild.count(SEARCH)).toBe(1)
  })
})
