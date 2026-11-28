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
import { DAY, DiscordGuild, GENERAL, PINS } from '../../../tests/core/discord/guild.ts'
import { listPins } from './pins.ts'

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

describe('listPins', () => {
  it('pages back from the oldest pin seen', async () => {
    const [hello, files] = await guild.day(GENERAL, DAY)
    for (const message of [hello, files]) {
      await guild.run.call('PUT', `/api/v10/channels/${GENERAL}/messages/pins/${message?.id ?? ''}`)
    }
    // Discord's own first page holds the newer pin and says there is more.
    const own = await guild.run.call<{ items: Record<string, unknown>[] }>(
      'GET',
      `/api/v10/channels/${GENERAL}/messages/pins?limit=50`,
    )
    const newest = own.items[0] ?? {}
    await guild.run.answerNext('GET', PINS, 200, { items: [newest], has_more: true } as never)

    const pins = await listPins(guild.accessor(), GENERAL)

    expect(pins.map((pin) => (pin.message as { content: string }).content)).toEqual([
      'files',
      'hello',
    ])
    const asked = await guild.run.params('GET', PINS)
    expect(asked.map((p) => p.before)).toEqual([undefined, String(newest.pinned_at)])
  })
})
