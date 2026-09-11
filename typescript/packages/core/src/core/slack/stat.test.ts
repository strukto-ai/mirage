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
import { SlackAccessor } from '../../accessor/slack.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { ContentType, FileType, PathSpec } from '../../types.ts'
import type { SlackResponse, SlackTransport } from './client.ts'
import { stat } from './stat.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: (endpoint: string) => SlackResponse) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder(endpoint))
  }
}

function channelWorld(endpoint: string): SlackResponse {
  if (endpoint === 'conversations.list') {
    return { ok: true, channels: [{ id: 'C1', name: 'general', created: 1 }] }
  }
  if (endpoint === 'conversations.open' || endpoint === 'users.conversations') {
    return { ok: true, channels: [] }
  }
  if (endpoint === 'users.list') {
    return { ok: true, members: [{ id: 'U1', name: 'alice' }] }
  }
  return { ok: true, channels: [], members: [], ims: [] }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

describe('stat virtual roots', () => {
  it('returns DIRECTORY for root with name "/"', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(new SlackAccessor(t), spec('/mnt/slack', '/mnt/slack'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('/')
    expect(t.calls).toHaveLength(0)
  })

  it('returns DIRECTORY for /channels', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(new SlackAccessor(t), spec('/mnt/slack/channels', '/mnt/slack'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('channels')
  })

  it('returns DIRECTORY for /dms', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(new SlackAccessor(t), spec('/mnt/slack/dms', '/mnt/slack'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('dms')
  })

  it('returns DIRECTORY for /users', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(new SlackAccessor(t), spec('/mnt/slack/users', '/mnt/slack'))
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('users')
  })
})

describe('stat channel/dm dir', () => {
  it('returns DIRECTORY with extra.channel_id for cached channel', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/channels', [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'slack/channel',
          vfsName: 'general__C1',
          remoteTime: '1609459200',
        }),
      ],
    ])
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1', '/mnt/slack'),
      idx,
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('general__C1')
    expect(out.extra.channel_id).toBe('C1')
    expect(out.modified).toBe('2021-01-01T00:00:00Z')
  })

  it('throws ENOENT for channel dir without index', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      stat(new SlackAccessor(t), spec('/mnt/slack/channels/general__C1', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for channel dir not in cache', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      stat(new SlackAccessor(t), spec('/mnt/slack/channels/general__C1', '/mnt/slack'), idx),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns DIRECTORY with extra.channel_id for cached dm', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/dms', [
      [
        'alice__D1',
        new IndexEntry({
          id: 'D1',
          name: 'alice',
          resourceType: 'slack/dm',
          vfsName: 'alice__D1',
          remoteTime: '0',
        }),
      ],
    ])
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(
      new SlackAccessor(t),
      spec('/mnt/slack/dms/alice__D1', '/mnt/slack'),
      idx,
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('alice__D1')
    expect(out.extra.channel_id).toBe('D1')
  })
})

describe('stat user file', () => {
  it('returns JSON with extra.user_id for cached user', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/users', [
      [
        'alice__U1.json',
        new IndexEntry({
          id: 'U1',
          name: 'alice',
          resourceType: 'slack/user',
          vfsName: 'alice__U1.json',
        }),
      ],
    ])
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(
      new SlackAccessor(t),
      spec('/mnt/slack/users/alice__U1.json', '/mnt/slack'),
      idx,
    )
    expect(out.content).toBe(ContentType.JSON)
    expect(out.name).toBe('alice__U1.json')
    expect(out.extra.user_id).toBe('U1')
  })

  it('throws ENOENT for user without index', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      stat(new SlackAccessor(t), spec('/mnt/slack/users/alice__U1.json', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat date directory', () => {
  it('returns DIRECTORY with date name for a listed channel', async () => {
    const t = new FakeTransport(channelWorld)
    const out = await stat(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1/2026-04-24', '/mnt/slack'),
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('2026-04-24')
  })

  it('returns DIRECTORY with date name for a seeded dm', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/dms', [
      [
        'alice__D1',
        new IndexEntry({
          id: 'D1',
          name: 'alice',
          resourceType: 'slack/dm',
          vfsName: 'alice__D1',
        }),
      ],
    ])
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(
      new SlackAccessor(t),
      spec('/mnt/slack/dms/alice__D1/2026-04-24', '/mnt/slack'),
      idx,
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('2026-04-24')
  })

  it('throws ENOENT for a date under a bogus channel', async () => {
    const t = new FakeTransport(channelWorld)
    await expect(
      stat(new SlackAccessor(t), spec('/mnt/slack/channels/nope__C9/2026-04-24', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat chat.jsonl and files dir', () => {
  it('serves chat.jsonl size from the index', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/channels/general__C1/2026-04-24', [
      [
        'chat.jsonl',
        new IndexEntry({
          id: 'C1:2026-04-24:chat',
          name: 'chat.jsonl',
          resourceType: 'slack/chat_jsonl',
          vfsName: 'chat.jsonl',
          size: 42,
        }),
      ],
    ])
    const out = await stat(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1/2026-04-24/chat.jsonl', '/mnt/slack'),
      idx,
    )
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('chat.jsonl')
    expect(out.size).toBe(42)
  })

  it('rejects chat.jsonl absent from an empty day', async () => {
    // A denied or empty day lists no chat.jsonl; stat must not fabricate
    // a sizeless file for it.
    const t = new FakeTransport(() => ({ ok: true }))
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/channels/general__C1/2026-04-24', [])
    await expect(
      stat(
        new SlackAccessor(t),
        spec('/mnt/slack/channels/general__C1/2026-04-24/chat.jsonl', '/mnt/slack'),
        idx,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns DIRECTORY files for a listed day', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/channels/general__C1/2026-04-24', [
      [
        'files',
        new IndexEntry({
          id: 'C1:2026-04-24:files',
          name: 'files',
          resourceType: 'slack/files_dir',
          vfsName: 'files',
          extra: { channel_id: 'C1', date: '2026-04-24' },
        }),
      ],
    ])
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1/2026-04-24/files', '/mnt/slack'),
      idx,
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('files')
  })

  it('throws ENOENT for files under a sealed day', async () => {
    // A sealed day lists nothing, so its files subdir does not exist.
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/channels/general__C1/2026-04-24', [])
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      stat(
        new SlackAccessor(t),
        spec('/mnt/slack/channels/general__C1/2026-04-24/files', '/mnt/slack'),
        idx,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat unknown', () => {
  it('throws ENOENT for unknown path shape', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      stat(new SlackAccessor(t), spec('/mnt/slack/foo/bar/baz', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
