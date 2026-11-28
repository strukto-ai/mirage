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
import {
  DiscordGuild,
  GENERAL,
  GUILD,
  MEMBERS,
  MESSAGES,
} from '../../../tests/core/discord/guild.ts'
import { afterIdPages } from './paginate.ts'

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

async function drain(
  iter: AsyncIterableIterator<Record<string, unknown>[]>,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  for await (const page of iter) items.push(...page)
  return items
}

describe('afterIdPages', () => {
  it('advances with the newest id on a newest-first endpoint', async () => {
    // Discord answers GET /channels/{id}/messages newest-first, so the cursor
    // is the first item; taking the last one re-requests the same window. Two
    // a page: files and hello, then morning.
    const items = await drain(
      afterIdPages<Record<string, unknown>>(guild.accessor(), {
        endpoint: `/channels/${GENERAL}/messages`,
        lastIdFn: (m) => (m as { id: string }).id,
        pageSize: 2,
        newestFirst: true,
      }),
    )
    expect(items.map((m) => m.content)).toEqual(['files', 'hello', 'morning'])
    const afters = (await guild.run.params('GET', MESSAGES)).map((p) => p.after)
    expect(afters).toEqual(['0', String(items[0]?.id)])
  })

  it('advances with the last id by default', async () => {
    // Members and guilds come back ascending, so the newest id is the last.
    const items = await drain(
      afterIdPages<Record<string, unknown>>(guild.accessor(), {
        endpoint: `/guilds/${GUILD}/members`,
        lastIdFn: (m) => (m as { user: { id: string } }).user.id,
        pageSize: 2,
      }),
    )
    expect(items.map((m) => (m.user as { id: string }).id)).toEqual(['311', '312', '911'])
    expect((await guild.run.params('GET', MEMBERS)).map((p) => p.after)).toEqual(['0', '312'])
  })
})
