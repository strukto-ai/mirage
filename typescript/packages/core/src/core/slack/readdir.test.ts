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
import { PathSpec } from '../../types.ts'
import type { SlackResponse, SlackTransport } from './_client.ts'
import { dateRange, latestMessageTs, readdir } from './readdir.ts'

interface Call {
  endpoint: string
  params?: Record<string, string>
  body?: unknown
}

class FakeTransport implements SlackTransport {
  public readonly calls: Call[] = []
  constructor(
    private readonly responder: (
      endpoint: string,
      params?: Record<string, string>,
    ) => SlackResponse,
  ) {}
  call(endpoint: string, params?: Record<string, string>, body?: unknown): Promise<SlackResponse> {
    this.calls.push({
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.responder(endpoint, params))
  }
}

function spec(original: string, prefix = ''): PathSpec {
  return new PathSpec({ original, directory: original, prefix })
}

describe('dateRange', () => {
  it('returns end and start (inclusive) walking backward', () => {
    // 2024-01-03 UTC
    const end = Date.UTC(2024, 0, 3) / 1000
    // 2024-01-01 UTC
    const start = Date.UTC(2024, 0, 1) / 1000
    expect(dateRange(end, start)).toEqual(['2024-01-03', '2024-01-02', '2024-01-01'])
  })

  it('clamps to maxDays when start is older than the limit', () => {
    const end = Date.UTC(2024, 0, 100) / 1000
    const start = Date.UTC(2024, 0, 1) / 1000
    const out = dateRange(end, start, 90)
    expect(out).toHaveLength(90)
    expect(out[0]).toBe(new Date(Date.UTC(2024, 0, 100)).toISOString().slice(0, 10))
    // last entry is end - (maxDays - 1) days
    const lastMs = Date.UTC(2024, 0, 100) - 89 * 86_400_000
    expect(out[out.length - 1]).toBe(new Date(lastMs).toISOString().slice(0, 10))
  })

  it('returns single date when latest equals created', () => {
    const ts = Date.UTC(2024, 5, 15) / 1000
    expect(dateRange(ts, ts)).toEqual(['2024-06-15'])
  })
})

describe('latestMessageTs', () => {
  it('returns float ts of first message', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      messages: [{ ts: '1700000000.123456' }],
    }))
    const ts = await latestMessageTs(new SlackAccessor(t), 'C1')
    expect(ts).toBeCloseTo(1700000000.123456, 5)
    expect(t.calls[0]?.endpoint).toBe('conversations.history')
    expect(t.calls[0]?.params).toMatchObject({ channel: 'C1', limit: '1' })
  })

  it('returns null for empty channel (no messages)', async () => {
    const t = new FakeTransport(() => ({ ok: true, messages: [] }))
    const ts = await latestMessageTs(new SlackAccessor(t), 'C1')
    expect(ts).toBeNull()
  })
})

describe('readdir root', () => {
  it('returns the three virtual roots for empty key with prefix', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await readdir(new SlackAccessor(t), spec('/mnt/slack', '/mnt/slack'))
    expect(out).toEqual(['/mnt/slack/channels', '/mnt/slack/dms', '/mnt/slack/users'])
    expect(t.calls).toHaveLength(0)
  })

  it('returns the three virtual roots for empty prefix', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await readdir(new SlackAccessor(t), spec('/'))
    expect(out).toEqual(['/channels', '/dms', '/users'])
  })
})

describe('readdir /channels', () => {
  it('lists channels, populates index, returns dirnames', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      channels: [
        { id: 'C1', name: 'general', created: 1000 },
        { id: 'C2', name: 'eng', created: 2000 },
      ],
      response_metadata: { next_cursor: '' },
    }))
    const idx = new RAMIndexCacheStore()
    const out = await readdir(new SlackAccessor(t), spec('/mnt/slack/channels', '/mnt/slack'), idx)
    expect(out).toEqual(['/mnt/slack/channels/general__C1', '/mnt/slack/channels/eng__C2'])
    const listing = await idx.listDir('/mnt/slack/channels')
    expect(listing.entries).toEqual([
      '/mnt/slack/channels/eng__C2',
      '/mnt/slack/channels/general__C1',
    ])
    const lookup = await idx.get('/mnt/slack/channels/general__C1')
    expect(lookup.entry?.id).toBe('C1')
    expect(lookup.entry?.resourceType).toBe('slack/channel')
    expect(lookup.entry?.remoteTime).toBe('1000')
  })

  it('returns from cache without API call when listDir hits', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/channels', [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'slack/channel',
          vfsName: 'general__C1',
          remoteTime: '1000',
        }),
      ],
    ])
    const t = new FakeTransport(() => {
      throw new Error('should not be called')
    })
    const out = await readdir(new SlackAccessor(t), spec('/mnt/slack/channels', '/mnt/slack'), idx)
    expect(out).toEqual(['/mnt/slack/channels/general__C1'])
    expect(t.calls).toHaveLength(0)
  })
})

describe('readdir /dms', () => {
  it('lists DMs and users, builds user_map for dirnames', async () => {
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.list') {
        return {
          ok: true,
          channels: [{ id: 'D1', user: 'U1', created: 5 }],
          response_metadata: { next_cursor: '' },
        }
      }
      if (endpoint === 'users.list') {
        return {
          ok: true,
          members: [{ id: 'U1', name: 'alice' }],
        }
      }
      return { ok: true }
    })
    const idx = new RAMIndexCacheStore()
    const out = await readdir(new SlackAccessor(t), spec('/mnt/slack/dms', '/mnt/slack'), idx)
    expect(out).toEqual(['/mnt/slack/dms/alice__D1'])
    const calls = t.calls.map((c) => c.endpoint)
    expect(calls).toContain('conversations.list')
    expect(calls).toContain('users.list')
    const listed = t.calls.find((c) => c.endpoint === 'conversations.list')
    expect(listed?.params?.types).toBe('im,mpim')
    const lookup = await idx.get('/mnt/slack/dms/alice__D1')
    expect(lookup.entry?.resourceType).toBe('slack/dm')
    expect(lookup.entry?.name).toBe('alice')
  })
})

describe('readdir /users', () => {
  it('lists users (filters bots/deleted) and writes filenames', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      members: [
        { id: 'U1', name: 'alice' },
        { id: 'U2', name: 'bot', is_bot: true },
        { id: 'USLACKBOT', name: 'slackbot' },
        { id: 'U3', name: 'gone', deleted: true },
        { id: 'U4', name: 'bob' },
      ],
    }))
    const idx = new RAMIndexCacheStore()
    const out = await readdir(new SlackAccessor(t), spec('/mnt/slack/users', '/mnt/slack'), idx)
    expect(out).toEqual(['/mnt/slack/users/alice__U1.json', '/mnt/slack/users/bob__U4.json'])
    const lookup = await idx.get('/mnt/slack/users/alice__U1.json')
    expect(lookup.entry?.resourceType).toBe('slack/user')
  })
})

describe('readdir channel/<id> (history dates)', () => {
  it('throws ENOENT when no index is provided', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      readdir(new SlackAccessor(t), spec('/mnt/slack/channels/general__C1', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns date filenames bounded by latestMessageTs and created', async () => {
    const created = Date.UTC(2024, 0, 1) / 1000
    const latest = Date.UTC(2024, 0, 3) / 1000
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/channels', [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'slack/channel',
          vfsName: 'general__C1',
          remoteTime: String(created),
        }),
      ],
    ])
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.history') {
        return { ok: true, messages: [{ ts: String(latest) }] }
      }
      return { ok: true }
    })
    const out = await readdir(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1', '/mnt/slack'),
      idx,
    )
    expect(out).toEqual([
      '/mnt/slack/channels/general__C1/2024-01-03',
      '/mnt/slack/channels/general__C1/2024-01-02',
      '/mnt/slack/channels/general__C1/2024-01-01',
    ])
    const lookup = await idx.get('/mnt/slack/channels/general__C1/2024-01-02')
    expect(lookup.entry?.id).toBe('C1:2024-01-02')
    expect(lookup.entry?.resourceType).toBe('slack/date_dir')
  })

  it('auto-bootstraps parent listing when not in cache', async () => {
    const created = Date.UTC(2024, 0, 1) / 1000
    const latest = Date.UTC(2024, 0, 2) / 1000
    const idx = new RAMIndexCacheStore()
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.list') {
        return {
          ok: true,
          channels: [{ id: 'C1', name: 'general', created }],
          response_metadata: { next_cursor: '' },
        }
      }
      if (endpoint === 'conversations.history') {
        return { ok: true, messages: [{ ts: String(latest) }] }
      }
      return { ok: true }
    })
    const out = await readdir(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1', '/mnt/slack'),
      idx,
    )
    expect(out).toEqual([
      '/mnt/slack/channels/general__C1/2024-01-02',
      '/mnt/slack/channels/general__C1/2024-01-01',
    ])
    const endpoints = t.calls.map((c) => c.endpoint)
    expect(endpoints).toContain('conversations.list')
    expect(endpoints).toContain('conversations.history')
  })

  it('throws ENOENT when channel is missing even after bootstrap', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.list') {
        return { ok: true, channels: [], response_metadata: { next_cursor: '' } }
      }
      return { ok: true }
    })
    await expect(
      readdir(new SlackAccessor(t), spec('/mnt/slack/channels/general__CX', '/mnt/slack'), idx),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns no dates when channel has no messages and no created', async () => {
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
    const t = new FakeTransport(() => ({ ok: true, messages: [] }))
    const out = await readdir(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1', '/mnt/slack'),
      idx,
    )
    expect(out).toEqual([])
  })
})
