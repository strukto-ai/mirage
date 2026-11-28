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
import { DiscordGuild } from '../../../tests/core/discord/guild.ts'
import { runDiscord } from '../../../tests/workspace/fixtures/chat_fixture.ts'

// general's 2024-01-15: hello, then files.
const CHAT = '/mnt/discord/My Server__111/channels/general__211/2024-01-15/chat.jsonl'

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

describe('discord jq', () => {
  it('extracts .content from each jsonl message', async () => {
    const out = await runDiscord(guild.accessor(), `jq -r .content "${CHAT}"`)
    expect(out.stdout.split('\n').filter((s) => s !== '')).toEqual(['hello', 'files'])
  })
})
