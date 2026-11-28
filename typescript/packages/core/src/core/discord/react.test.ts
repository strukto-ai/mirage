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
import { DAY, DiscordGuild, GENERAL } from '../../../tests/core/discord/guild.ts'
import { addReaction } from './react.ts'

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

async function reacted(): Promise<string[]> {
  const hello = (await guild.day(GENERAL, DAY))[0]?.id ?? ''
  const message = await guild.message(GENERAL, hello)
  return ((message.reactions ?? []) as { emoji: { name: string } }[]).map((r) => r.emoji.name)
}

describe('addReaction', () => {
  it('PUTs to the reaction endpoint with URL-encoded emoji', async () => {
    const hello = (await guild.day(GENERAL, DAY))[0]?.id ?? ''
    await addReaction(guild.accessor(), GENERAL, hello, '\u{1F44D}')
    expect(await guild.run.requests()).toEqual([
      `PUT /api/v10/channels/${GENERAL}/messages/${hello}/reactions/%F0%9F%91%8D/@me`,
    ])
    expect(await reacted()).toEqual(['\u{1F44D}'])
  })

  it('encodes ASCII emoji shortcode-style strings', async () => {
    const hello = (await guild.day(GENERAL, DAY))[0]?.id ?? ''
    await addReaction(guild.accessor(), GENERAL, hello, 'name:123')
    expect(await guild.run.requests()).toEqual([
      `PUT /api/v10/channels/${GENERAL}/messages/${hello}/reactions/name%3A123/@me`,
    ])
  })
})
