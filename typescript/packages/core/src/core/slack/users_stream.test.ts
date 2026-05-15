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
import { listUsersStream } from './users.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: (call: number) => SlackResponse) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder(this.calls.length))
  }
}

describe('listUsersStream', () => {
  it('filters bots/deleted/USLACKBOT per page before yielding', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      members: [
        { id: 'U1', name: 'alice' },
        { id: 'U2', name: 'bot', is_bot: true },
        { id: 'USLACKBOT', name: 'slackbot' },
        { id: 'U3', name: 'gone', deleted: true },
      ],
      response_metadata: { next_cursor: '' },
    }))
    const collected: { id: string }[][] = []
    for await (const page of listUsersStream(new SlackAccessor(t))) {
      collected.push(page as { id: string }[])
    }
    expect(collected).toEqual([[{ id: 'U1', name: 'alice' }]])
  })

  it('walks all pages', async () => {
    const pages: SlackResponse[] = [
      {
        ok: true,
        members: [{ id: 'U1', name: 'alice' }],
        response_metadata: { next_cursor: 'c2' },
      },
      {
        ok: true,
        members: [{ id: 'U2', name: 'bob' }],
        response_metadata: { next_cursor: '' },
      },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const ids: string[] = []
    for await (const page of listUsersStream(new SlackAccessor(t))) {
      for (const u of page) ids.push((u as { id: string }).id)
    }
    expect(ids).toEqual(['U1', 'U2'])
    expect(t.calls).toHaveLength(2)
  })
})
