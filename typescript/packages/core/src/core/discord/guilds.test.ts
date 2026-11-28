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
import { DiscordGuild, GUILD, GUILDS } from '../../../tests/core/discord/guild.ts'
import { listGuilds } from './guilds.ts'

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

describe('listGuilds', () => {
  it('GETs /users/@me/guilds and returns the array', async () => {
    const out = await listGuilds(guild.accessor())
    const [params] = await guild.run.params('GET', GUILDS)
    expect([params?.after, params?.limit]).toEqual(['0', '200'])
    expect(out.map((g) => [g.id, g.name])).toEqual([[GUILD, 'My Server']])
  })

  it('returns empty array when response is not an array', async () => {
    await guild.run.answerNext('GET', GUILDS, 200, null)
    expect(await listGuilds(guild.accessor())).toEqual([])
  })
})
