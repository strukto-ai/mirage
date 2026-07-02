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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { DiscordAccessor } from '../../accessor/discord.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { DiscordMethod, DiscordResponse, DiscordTransport } from './_client.ts'
import { read } from './read.ts'

interface RecordedCall {
  method: DiscordMethod
  endpoint: string
  params?: Record<string, string | number>
  body?: Record<string, unknown>
}

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: RecordedCall[] = []
  constructor(
    private readonly responder: (method: DiscordMethod, endpoint: string) => DiscordResponse = () =>
      null,
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
    return Promise.resolve(this.responder(method, endpoint))
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

const decoder = new TextDecoder()

describe('read history jsonl branch', () => {
  it('reads channel jsonl bytes via getHistoryJsonl when channel cached', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/discord/My Server__G1/channels', [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'discord/channel',
          vfsName: 'general__C1',
          remoteTime: '',
        }),
      ],
    ])
    let returned = false
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/channels/C1/messages') {
        if (returned) return []
        returned = true
        return [
          { id: '1196300000000000000', content: 'hello' },
          { id: '1196400000000000000', content: 'world' },
        ]
      }
      return null
    })
    const out = await read(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels/general__C1/2024-01-15/chat.jsonl', '/mnt/discord'),
      idx,
    )
    const text = decoder.decode(out).trimEnd()
    const lines = text.split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0] ?? '') as { content: string }
    expect(first.content).toBe('hello')
    const histCall = t.calls.find((c) => c.endpoint === '/channels/C1/messages')
    expect(histCall).toBeDefined()
  })

  it('throws ENOENT for jsonl path when index is undefined', async () => {
    const t = new FakeDiscordTransport(() => null)
    await expect(
      read(
        new DiscordAccessor(t),
        spec(
          '/mnt/discord/My Server__G1/channels/general__C1/2024-01-15/chat.jsonl',
          '/mnt/discord',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for jsonl path when channel not in cache', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeDiscordTransport(() => null)
    await expect(
      read(
        new DiscordAccessor(t),
        spec(
          '/mnt/discord/My Server__G1/channels/general__C1/2024-01-15/chat.jsonl',
          '/mnt/discord',
        ),
        idx,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('read members branch', () => {
  it('returns JSON-stringified member bytes for matching user id', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/discord', [
      [
        'My Server__G1',
        new IndexEntry({
          id: 'G1',
          name: 'My Server',
          resourceType: 'discord/guild',
          vfsName: 'My Server__G1',
        }),
      ],
    ])
    await idx.setDir('/mnt/discord/My Server__G1/members', [
      [
        'alice__U1.json',
        new IndexEntry({
          id: 'U1',
          name: 'alice',
          resourceType: 'discord/member',
          vfsName: 'alice__U1.json',
        }),
      ],
    ])
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/guilds/G1/members') {
        return [
          { user: { id: 'U2', username: 'bob' }, nick: 'Bob' },
          { user: { id: 'U1', username: 'alice' }, nick: 'Alice' },
        ]
      }
      return null
    })
    const out = await read(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/members/alice__U1.json', '/mnt/discord'),
      idx,
    )
    const parsed = JSON.parse(decoder.decode(out)) as Record<string, unknown>
    expect(parsed).toMatchObject({
      user: { id: 'U1', username: 'alice' },
      nick: 'Alice',
    })
    const memCall = t.calls.find((c) => c.endpoint === '/guilds/G1/members')
    expect(memCall).toBeDefined()
  })

  it('throws ENOENT for members path when index is undefined', async () => {
    const t = new FakeDiscordTransport(() => null)
    await expect(
      read(
        new DiscordAccessor(t),
        spec('/mnt/discord/My Server__G1/members/alice__U1.json', '/mnt/discord'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for members path when member not in cache', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeDiscordTransport(() => null)
    await expect(
      read(
        new DiscordAccessor(t),
        spec('/mnt/discord/My Server__G1/members/alice__U1.json', '/mnt/discord'),
        idx,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for members path when guild not in cache', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/discord/My Server__G1/members', [
      [
        'alice__U1.json',
        new IndexEntry({
          id: 'U1',
          name: 'alice',
          resourceType: 'discord/member',
          vfsName: 'alice__U1.json',
        }),
      ],
    ])
    const t = new FakeDiscordTransport(() => null)
    await expect(
      read(
        new DiscordAccessor(t),
        spec('/mnt/discord/My Server__G1/members/alice__U1.json', '/mnt/discord'),
        idx,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT when no member matches the cached user id', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/discord', [
      [
        'My Server__G1',
        new IndexEntry({
          id: 'G1',
          name: 'My Server',
          resourceType: 'discord/guild',
          vfsName: 'My Server__G1',
        }),
      ],
    ])
    await idx.setDir('/mnt/discord/My Server__G1/members', [
      [
        'alice__U1.json',
        new IndexEntry({
          id: 'U1',
          name: 'alice',
          resourceType: 'discord/member',
          vfsName: 'alice__U1.json',
        }),
      ],
    ])
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/guilds/G1/members') {
        return [{ user: { id: 'U2', username: 'bob' } }]
      }
      return null
    })
    await expect(
      read(
        new DiscordAccessor(t),
        spec('/mnt/discord/My Server__G1/members/alice__U1.json', '/mnt/discord'),
        idx,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('read unknown', () => {
  it('throws ENOENT for unknown path shape', async () => {
    const t = new FakeDiscordTransport(() => null)
    await expect(
      read(new DiscordAccessor(t), spec('/mnt/discord/My Server__G1/foo/bar', '/mnt/discord')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for root', async () => {
    const t = new FakeDiscordTransport(() => null)
    await expect(
      read(new DiscordAccessor(t), spec('/mnt/discord', '/mnt/discord')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
