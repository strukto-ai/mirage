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
import { SlackAccessor } from '../../accessor/slack.ts'
import type { SlackResponse, SlackTransport } from './_client.ts'
import { fetchMessagesForDay, streamMessagesForDay, streamThreadReplies } from './history.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: (call: number) => SlackResponse) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder(this.calls.length))
  }
}

describe('streamMessagesForDay', () => {
  it('paginates conversations.history for the channel/day', async () => {
    const pages: SlackResponse[] = [
      {
        ok: true,
        messages: [{ ts: '1.0' }, { ts: '2.0' }],
        response_metadata: { next_cursor: 'cur' },
      },
      {
        ok: true,
        messages: [{ ts: '3.0' }],
        response_metadata: { next_cursor: '' },
      },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const result: { ts: string }[][] = []
    for await (const page of streamMessagesForDay(new SlackAccessor(t), 'C1', '2026-04-04')) {
      result.push(page as { ts: string }[])
    }
    expect(result.flat().map((m) => m.ts)).toEqual(['1.0', '2.0', '3.0'])
    expect(t.calls[0]?.endpoint).toBe('conversations.history')
    expect(t.calls[0]?.params).toMatchObject({
      channel: 'C1',
      inclusive: 'true',
      limit: '200',
    })
  })
})

describe('fetchMessagesForDay (eager + sort)', () => {
  it('sorts by ts ascending across pages', async () => {
    const pages: SlackResponse[] = [
      {
        ok: true,
        messages: [{ ts: '3.0' }, { ts: '1.0' }],
        response_metadata: { next_cursor: 'cur' },
      },
      {
        ok: true,
        messages: [{ ts: '2.0' }],
        response_metadata: { next_cursor: '' },
      },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const msgs = await fetchMessagesForDay(new SlackAccessor(t), 'C1', '2026-04-04')
    expect(msgs.map((m) => m.ts)).toEqual(['1.0', '2.0', '3.0'])
  })
})

describe('streamThreadReplies', () => {
  it('paginates conversations.replies', async () => {
    const pages: SlackResponse[] = [
      { ok: true, messages: [{ ts: '1.0' }], response_metadata: { next_cursor: 'c' } },
      { ok: true, messages: [{ ts: '1.5' }], response_metadata: { next_cursor: '' } },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const ts: string[] = []
    for await (const page of streamThreadReplies(new SlackAccessor(t), 'C1', '1.0')) {
      for (const m of page) ts.push((m as { ts: string }).ts)
    }
    expect(ts).toEqual(['1.0', '1.5'])
    expect(t.calls[0]?.endpoint).toBe('conversations.replies')
    expect(t.calls[0]?.params).toMatchObject({ channel: 'C1', ts: '1.0' })
  })
})
