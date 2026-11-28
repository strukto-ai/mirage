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
import { ALICE, DAY, DiscordGuild, GENERAL, MESSAGES } from '../../../tests/core/discord/guild.ts'
import { DISCORD_EPOCH, fetchRecentMessages, getHistoryJsonl, snowflakeAt } from './history.ts'

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

describe('snowflakeAt', () => {
  it('matches the (ms - epoch) << 22 formula', () => {
    const ms = Date.UTC(2026, 3, 25)
    expect(snowflakeAt(ms / 1000)).toBe((BigInt(ms) - DISCORD_EPOCH) << 22n)
  })
})

function contents(out: Uint8Array): string[] {
  return new TextDecoder()
    .decode(out)
    .trimEnd()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { content: string }).content)
}

describe('getHistoryJsonl', () => {
  it('paginates until a short batch is returned', async () => {
    // A day of 101 messages: a full page of 100, newest first, then one.
    const start = Date.UTC(2024, 0, 20)
    await guild.addMessages(
      GENERAL,
      ALICE,
      Array.from({ length: 101 }, (_, i): [Date, string] => [
        new Date(start + i * 1000),
        `msg${String(i)}`,
      ]),
    )
    const out = await getHistoryJsonl(guild.accessor(), GENERAL, '2024-01-20')
    const asked = await guild.run.params('GET', MESSAGES)
    expect(asked).toHaveLength(2)
    expect(asked[0]?.limit).toBe('100')
    // Discord answers newest-first, so the cursor for the next page is the
    // newest id of the first.
    expect(asked[1]?.after).toBe(String(snowflakeAt((start + 99 * 1000) / 1000)))
    const text = new TextDecoder().decode(out)
    expect(text.trimEnd().split('\n')).toHaveLength(101)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('filters out messages whose id is past the end-of-day snowflake', async () => {
    // morning is general's next day.
    const out = contents(await getHistoryJsonl(guild.accessor(), GENERAL, DAY))
    expect(out).toContain('hello')
    expect(out).not.toContain('morning')
  })

  it('returns empty Uint8Array when there are no messages', async () => {
    const out = await getHistoryJsonl(guild.accessor(), GENERAL, '2024-01-10')
    expect(out).toBeInstanceOf(Uint8Array)
    expect(out.length).toBe(0)
  })

  it('sorts messages ascending by snowflake id across pages', async () => {
    expect(contents(await getHistoryJsonl(guild.accessor(), GENERAL, DAY))).toEqual([
      'hello',
      'files',
    ])
  })

  it('breaks when the response is null', async () => {
    await guild.run.answerNext('GET', MESSAGES, 200, null)
    const out = await getHistoryJsonl(guild.accessor(), GENERAL, DAY)
    expect(out.length).toBe(0)
  })
})

describe('fetchRecentMessages', () => {
  it('fetches one page and sorts oldest-first', async () => {
    const messages = await fetchRecentMessages(guild.accessor(), GENERAL, 3)
    expect(messages.map((m) => m.content)).toEqual(['hello', 'files', 'morning'])
    expect(await guild.count(MESSAGES)).toBe(1)
  })
})
