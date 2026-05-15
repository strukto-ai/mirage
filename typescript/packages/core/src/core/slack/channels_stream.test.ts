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
import { listChannels, listChannelsStream, listDmsStream } from './channels.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: (call: number) => SlackResponse) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder(this.calls.length))
  }
}

describe('listChannelsStream', () => {
  it('yields one page per round-trip', async () => {
    const pages: SlackResponse[] = [
      {
        ok: true,
        channels: [{ id: 'C1', name: 'general' }],
        response_metadata: { next_cursor: 'c2' },
      },
      {
        ok: true,
        channels: [{ id: 'C2', name: 'eng' }],
        response_metadata: { next_cursor: '' },
      },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const collected: { id: string; name?: string }[][] = []
    for await (const page of listChannelsStream(new SlackAccessor(t))) {
      collected.push(page)
    }
    expect(collected).toEqual([[{ id: 'C1', name: 'general' }], [{ id: 'C2', name: 'eng' }]])
    expect(t.calls).toHaveLength(2)
    expect(t.calls[0]?.params).toMatchObject({
      types: 'public_channel,private_channel',
      limit: '200',
      exclude_archived: 'true',
    })
  })

  it('caller can break early without further calls', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: { next_cursor: 'c2' },
    }))
    for await (const _page of listChannelsStream(new SlackAccessor(t))) {
      void _page
      break
    }
    expect(t.calls).toHaveLength(1)
  })
})

describe('listChannels (eager wrapper)', () => {
  it('flattens all pages', async () => {
    const pages: SlackResponse[] = [
      {
        ok: true,
        channels: [
          { id: 'C1', name: 'a' },
          { id: 'C2', name: 'b' },
        ],
        response_metadata: { next_cursor: 'cur' },
      },
      {
        ok: true,
        channels: [{ id: 'C3', name: 'c' }],
        response_metadata: { next_cursor: '' },
      },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const out = await listChannels(new SlackAccessor(t))
    expect(out.map((c) => c.id)).toEqual(['C1', 'C2', 'C3'])
  })
})

describe('listDmsStream', () => {
  it('uses types=im,mpim', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      channels: [],
      response_metadata: { next_cursor: '' },
    }))
    for await (const _page of listDmsStream(new SlackAccessor(t))) {
      void _page
    }
    expect(t.calls[0]?.params?.types).toBe('im,mpim')
  })
})
