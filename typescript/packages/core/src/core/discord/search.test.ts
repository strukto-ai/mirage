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
import { DiscordAccessor } from '../../accessor/discord.ts'
import type { DiscordMethod, DiscordResponse, DiscordTransport } from './_client.ts'
import { formatGrepResults, searchGuild } from './search.ts'

interface RecordedCall {
  method: DiscordMethod
  endpoint: string
  params?: Record<string, string | number>
  body?: Record<string, unknown>
}

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: RecordedCall[] = []
  constructor(
    private readonly responder: (
      n: number,
      params?: Record<string, string | number>,
    ) => DiscordResponse,
  ) {}
  call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<DiscordResponse> {
    this.calls.push({
      method,
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.responder(this.calls.length, params))
  }
}

describe('searchGuild', () => {
  it('paginates until total is reached and sorts ascending', async () => {
    const page1 = {
      total_results: 50,
      messages: [[{ id: '300' }], [{ id: '100' }]],
    }
    const page2 = {
      total_results: 50,
      messages: [[{ id: '200' }]],
    }
    const t = new FakeDiscordTransport((n) => {
      if (n === 1) return page1
      if (n === 2) return page2
      return { total_results: 50, messages: [] }
    })
    const out = await searchGuild(new DiscordAccessor(t), 'G1', 'hello')
    expect(t.calls[0]?.method).toBe('GET')
    expect(t.calls[0]?.endpoint).toBe('/guilds/G1/messages/search')
    expect(t.calls[0]?.params).toEqual({ content: 'hello', offset: 0 })
    expect(t.calls[1]?.params).toEqual({ content: 'hello', offset: 25 })
    expect(out.map((m) => m.id)).toEqual(['100', '200', '300'])
  })

  it('forwards channel_id when provided', async () => {
    const t = new FakeDiscordTransport(() => ({ total_results: 0, messages: [] }))
    await searchGuild(new DiscordAccessor(t), 'G1', 'q', 'C1')
    expect(t.calls[0]?.params).toEqual({ content: 'q', offset: 0, channel_id: 'C1' })
  })

  it('omits channel_id when undefined or empty', async () => {
    const t = new FakeDiscordTransport(() => ({ total_results: 0, messages: [] }))
    await searchGuild(new DiscordAccessor(t), 'G1', 'q', '')
    expect(t.calls[0]?.params).toEqual({ content: 'q', offset: 0 })
  })

  it('stops when limit is reached and slices the result', async () => {
    const t = new FakeDiscordTransport(() => ({
      total_results: 1000,
      messages: [[{ id: '1' }], [{ id: '2' }], [{ id: '3' }]],
    }))
    const out = await searchGuild(new DiscordAccessor(t), 'G1', 'q', undefined, 2)
    expect(out).toHaveLength(2)
    expect(t.calls).toHaveLength(1)
  })

  it('breaks gracefully on non-dict response', async () => {
    const t = new FakeDiscordTransport(() => null)
    const out = await searchGuild(new DiscordAccessor(t), 'G1', 'q')
    expect(out).toEqual([])
  })

  it('breaks gracefully on array response', async () => {
    const t = new FakeDiscordTransport(() => [])
    const out = await searchGuild(new DiscordAccessor(t), 'G1', 'q')
    expect(out).toEqual([])
  })

  it('breaks when messages array is empty', async () => {
    const t = new FakeDiscordTransport(() => ({ total_results: 999, messages: [] }))
    const out = await searchGuild(new DiscordAccessor(t), 'G1', 'q')
    expect(out).toEqual([])
    expect(t.calls).toHaveLength(1)
  })
})

describe('formatGrepResults', () => {
  const scope = {
    level: 'guild' as const,
    useNative: true,
    guildId: 'G1',
    guildName: 'My Server',
    resourcePath: 'My Server__G1',
  }

  it('builds full VFS path with prefix, sanitized guild and channel dirs', () => {
    const lines = formatGrepResults(
      [
        {
          id: '1',
          channel_id: 'C1',
          timestamp: '2026-04-25T12:34:56.000Z',
          author: { username: 'alice' },
          content: 'hello world',
        },
      ],
      scope,
      '/discord',
      new Map([['C1', 'general']]),
    )
    expect(lines).toEqual([
      '/discord/My Server__G1/channels/general__C1/2026-04-25/chat.jsonl:[alice] hello world',
    ])
  })

  it('falls back to unknown__id when channel name unknown', () => {
    const lines = formatGrepResults(
      [
        {
          id: '1',
          channel_id: 'C2',
          timestamp: '2026-04-25T12:34:56.000Z',
          author: { username: 'bob' },
          content: 'hi',
        },
      ],
      scope,
      '/discord',
    )
    expect(lines).toEqual([
      '/discord/My Server__G1/channels/unknown__C2/2026-04-25/chat.jsonl:[bob] hi',
    ])
  })

  it('uses scope.channelName when channel-scoped', () => {
    const lines = formatGrepResults(
      [
        {
          id: '1',
          channel_id: 'C3',
          timestamp: '2026-04-25T12:34:56.000Z',
          author: { username: 'carol' },
          content: 'msg',
        },
      ],
      { ...scope, level: 'channel', channelId: 'C3', channelName: 'eng' },
      '/discord',
    )
    expect(lines).toEqual([
      '/discord/My Server__G1/channels/eng__C3/2026-04-25/chat.jsonl:[carol] msg',
    ])
  })
})
