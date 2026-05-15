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
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType, PathSpec } from '../../types.ts'
import type { SlackResponse, SlackTransport } from './_client.ts'
import { stat } from './stat.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: () => SlackResponse) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder())
  }
}

function spec(original: string, prefix = ''): PathSpec {
  return new PathSpec({ original, directory: original, prefix })
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
          remoteTime: '0',
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
    expect(out.type).toBe(FileType.JSON)
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
  it('returns DIRECTORY with date name for channel/<chan>/<date>', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1/2026-04-24', '/mnt/slack'),
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('2026-04-24')
    expect(t.calls).toHaveLength(0)
  })

  it('returns DIRECTORY with date name for dm/<dm>/<date>', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(
      new SlackAccessor(t),
      spec('/mnt/slack/dms/alice__D1/2026-04-24', '/mnt/slack'),
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('2026-04-24')
  })
})

describe('stat chat.jsonl and files dir', () => {
  it('returns TEXT chat.jsonl for <chan>/<date>/chat.jsonl', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1/2026-04-24/chat.jsonl', '/mnt/slack'),
    )
    expect(out.type).toBe(FileType.TEXT)
    expect(out.name).toBe('chat.jsonl')
  })

  it('returns DIRECTORY files for <chan>/<date>/files', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await stat(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1/2026-04-24/files', '/mnt/slack'),
    )
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('files')
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
