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
import { FakeSlackTransport, runSlack } from './_test_util.ts'

describe('slack jq', () => {
  it('extracts .text from each jsonl message', async () => {
    const transport = new FakeSlackTransport((endpoint) => {
      if (endpoint === 'conversations.history') {
        return {
          ok: true,
          messages: [
            { ts: '1704067201.000000', text: 'hello' },
            { ts: '1704067202.000000', text: 'world' },
          ],
        }
      }
      return { ok: true }
    })
    const out = await runSlack(
      transport,
      'jq -r .text /mnt/slack/channels/general__C1/2024-01-01/chat.jsonl',
      ['2024-01-01'],
    )
    const lines = out.stdout.split('\n').filter((s) => s !== '')
    expect(lines).toEqual(['hello', 'world'])
  })
})
