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
import { FileType, PathSpec } from '../../types.ts'
import type { DiscordMethod, DiscordResponse, DiscordTransport } from './_client.ts'
import { stat } from './stat.ts'

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: { method: DiscordMethod; endpoint: string }[] = []
  constructor(private readonly responder: () => DiscordResponse = () => null) {}
  call(method: DiscordMethod, endpoint: string): Promise<DiscordResponse> {
    this.calls.push({ method, endpoint })
    return Promise.resolve(this.responder())
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

describe('stat virtual root', () => {
  it('returns DIRECTORY for root with name "/"', async () => {
    const t = new FakeDiscordTransport()
    const out = await stat(new DiscordAccessor(t), spec('/mnt/discord', '/mnt/discord'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('/')
    expect(t.calls).toHaveLength(0)
  })
})

describe('stat guild dir', () => {
  it('returns DIRECTORY with extra.guild_id for cached guild', async () => {
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
    const t = new FakeDiscordTransport()
    const out = await stat(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1', '/mnt/discord'),
      idx,
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('My Server__G1')
    expect(out.extra.guild_id).toBe('G1')
  })

  it('throws ENOENT for guild without index', async () => {
    const t = new FakeDiscordTransport()
    await expect(
      stat(new DiscordAccessor(t), spec('/mnt/discord/My Server__G1', '/mnt/discord')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for guild not in cache', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeDiscordTransport()
    await expect(
      stat(new DiscordAccessor(t), spec('/mnt/discord/Missing__GX', '/mnt/discord'), idx),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat virtual containers under guild', () => {
  it('returns DIRECTORY for /<g>/channels (no index lookup)', async () => {
    const t = new FakeDiscordTransport()
    const out = await stat(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels', '/mnt/discord'),
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('channels')
    expect(t.calls).toHaveLength(0)
  })

  it('returns DIRECTORY for /<g>/members (no index lookup)', async () => {
    const t = new FakeDiscordTransport()
    const out = await stat(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/members', '/mnt/discord'),
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('members')
  })
})

describe('stat channel dir', () => {
  it('returns DIRECTORY with extra.channel_id for cached channel', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/discord/My Server__G1/channels', [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'discord/channel',
          vfsName: 'general__C1',
          remoteTime: '794354201395200000',
        }),
      ],
    ])
    const t = new FakeDiscordTransport()
    const out = await stat(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
      idx,
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('general__C1')
    expect(out.extra.channel_id).toBe('C1')
    expect(out.modified).toBe('2021-01-01T00:00:00Z')
  })

  it('throws ENOENT for channel dir without index', async () => {
    const t = new FakeDiscordTransport()
    await expect(
      stat(
        new DiscordAccessor(t),
        spec('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for channel dir not in cache', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeDiscordTransport()
    await expect(
      stat(
        new DiscordAccessor(t),
        spec('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
        idx,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat member file', () => {
  it('returns JSON with extra.user_id for cached member', async () => {
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
    const t = new FakeDiscordTransport()
    const out = await stat(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/members/alice__U1.json', '/mnt/discord'),
      idx,
    )
    expect(out.type).toBe(FileType.JSON)
    expect(out.name).toBe('alice__U1.json')
    expect(out.extra.user_id).toBe('U1')
  })

  it('throws ENOENT for member without index', async () => {
    const t = new FakeDiscordTransport()
    await expect(
      stat(
        new DiscordAccessor(t),
        spec('/mnt/discord/My Server__G1/members/alice__U1.json', '/mnt/discord'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for member not in cache', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeDiscordTransport()
    await expect(
      stat(
        new DiscordAccessor(t),
        spec('/mnt/discord/My Server__G1/members/alice__U1.json', '/mnt/discord'),
        idx,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat history chat.jsonl', () => {
  it('returns TEXT with chat.jsonl name (no index lookup)', async () => {
    const t = new FakeDiscordTransport()
    const out = await stat(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels/general__C1/2024-01-15/chat.jsonl', '/mnt/discord'),
    )
    expect(out.type).toBe(FileType.TEXT)
    expect(out.name).toBe('chat.jsonl')
    expect(t.calls).toHaveLength(0)
  })

  it('returns DIRECTORY for date dir', async () => {
    const t = new FakeDiscordTransport()
    const out = await stat(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels/general__C1/2024-01-15', '/mnt/discord'),
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('2024-01-15')
  })
})

describe('stat unknown', () => {
  it('throws ENOENT for unknown 2-segment shape', async () => {
    const t = new FakeDiscordTransport()
    await expect(
      stat(new DiscordAccessor(t), spec('/mnt/discord/My Server__G1/foo', '/mnt/discord')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for 4+ segment shape that is not history', async () => {
    const t = new FakeDiscordTransport()
    await expect(
      stat(
        new DiscordAccessor(t),
        spec('/mnt/discord/My Server__G1/channels/general__C1/extra', '/mnt/discord'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for unknown 3-segment shape', async () => {
    const t = new FakeDiscordTransport()
    await expect(
      stat(new DiscordAccessor(t), spec('/mnt/discord/My Server__G1/foo/bar', '/mnt/discord')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
