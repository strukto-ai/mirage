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

describe('slack cat', () => {
  it('concatenates multiple jsonl files in order (regression: previously only read the first)', async () => {
    // FakeSlackTransport returns deterministic messages per call. We map each
    // day's `oldest` (00:00 UTC) to a distinct message so we can assert order.
    const day1Oldest = (Date.UTC(2024, 0, 1) / 1000).toFixed(6)
    const day2Oldest = (Date.UTC(2024, 0, 2) / 1000).toFixed(6)
    const day3Oldest = (Date.UTC(2024, 0, 3) / 1000).toFixed(6)
    const transport = new FakeSlackTransport((endpoint, params) => {
      if (endpoint === 'conversations.history') {
        const oldest = params?.oldest
        if (oldest === day1Oldest)
          return { ok: true, messages: [{ ts: '1704067201.000000', text: 'day1' }] }
        if (oldest === day2Oldest)
          return { ok: true, messages: [{ ts: '1704153602.000000', text: 'day2' }] }
        if (oldest === day3Oldest)
          return { ok: true, messages: [{ ts: '1704240003.000000', text: 'day3' }] }
        return { ok: true, messages: [] }
      }
      return { ok: true }
    })
    const dates = ['2024-01-01', '2024-01-02', '2024-01-03']
    const paths = dates.map((date) => `/mnt/slack/channels/general__C1/${date}/chat.jsonl`)
    const out = await runSlack(transport, `cat ${paths.join(' ')}`, dates)
    const lines = out.stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ts: '1704067201.000000', text: 'day1' })
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ ts: '1704153602.000000', text: 'day2' })
    expect(JSON.parse(lines[2] ?? '')).toMatchObject({ ts: '1704240003.000000', text: 'day3' })
  })
})
