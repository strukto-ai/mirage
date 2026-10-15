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

import { describe, expect, it } from 'vitest'
import { FakeDiscordTransport, runDiscord } from './_test_util.ts'

const CHAT = '/mnt/discord/My Server__G1/channels/general__C1/2016-04-30/chat.jsonl'

describe('discord wc', () => {
  it('supports -l flag (line count)', async () => {
    const transport = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/channels/C1/messages') {
        return [
          { id: '175928847299117056', content: 'a' },
          { id: '175928847299117057', content: 'b' },
        ]
      }
      return null
    })
    const out = await runDiscord(transport, `wc -l "${CHAT}"`, ['2016-04-30'])
    expect(out.stdout).toBe(`2 ${CHAT}\n`)
  })
})
