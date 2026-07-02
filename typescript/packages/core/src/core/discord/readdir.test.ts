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
import { dateRangeDescending, readdir, snowflakeToDate } from './readdir.ts'

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

describe('snowflakeToDate', () => {
  it('returns empty string for empty input', () => {
    expect(snowflakeToDate('')).toBe('')
  })

  it('decodes 175928847299117056 to 2016-04-30', () => {
    expect(snowflakeToDate('175928847299117056')).toBe('2016-04-30')
  })

  it('decodes a known snowflake aligned to the discord epoch', () => {
    expect(snowflakeToDate('0')).toBe('2015-01-01')
  })
})

describe('dateRangeDescending', () => {
  it('returns 30 dates in descending order starting at endDate', () => {
    const out = dateRangeDescending('2026-04-25', 30)
    expect(out).toHaveLength(30)
    expect(out[0]).toBe('2026-04-25')
    expect(out[1]).toBe('2026-04-24')
    expect(out[29]).toBe('2026-03-27')
  })

  it('honors a custom days argument', () => {
    expect(dateRangeDescending('2024-01-03', 3)).toEqual(['2024-01-03', '2024-01-02', '2024-01-01'])
  })

  it('returns [] for malformed input', () => {
    expect(dateRangeDescending('', 30)).toEqual([])
  })
})

describe('readdir root', () => {
  it('lists guilds and populates the index', async () => {
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/users/@me/guilds') {
        return [
          { id: 'G1', name: 'My Server' },
          { id: 'G2', name: 'Other' },
        ]
      }
      return null
    })
    const idx = new RAMIndexCacheStore()
    const out = await readdir(new DiscordAccessor(t), spec('/mnt/discord', '/mnt/discord'), idx)
    expect(out).toEqual(['/mnt/discord/My Server__G1', '/mnt/discord/Other__G2'])
    const listing = await idx.listDir('/mnt/discord')
    expect(listing.entries).toEqual(['/mnt/discord/My Server__G1', '/mnt/discord/Other__G2'])
    const lookup = await idx.get('/mnt/discord/My Server__G1')
    expect(lookup.entry?.id).toBe('G1')
    expect(lookup.entry?.resourceType).toBe('discord/guild')
  })

  it('returns from cache without API call on second invocation', async () => {
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
    const t = new FakeDiscordTransport(() => {
      throw new Error('should not be called')
    })
    const out = await readdir(new DiscordAccessor(t), spec('/mnt/discord', '/mnt/discord'), idx)
    expect(out).toEqual(['/mnt/discord/My Server__G1'])
    expect(t.calls).toHaveLength(0)
  })
})

describe('readdir /<guild>', () => {
  it('returns the channels/members pair after auto-bootstrap', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/users/@me/guilds') return [{ id: 'G1', name: 'My Server' }]
      return null
    })
    const out = await readdir(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1', '/mnt/discord'),
      idx,
    )
    expect(out).toEqual([
      '/mnt/discord/My Server__G1/channels',
      '/mnt/discord/My Server__G1/members',
    ])
    const endpoints = t.calls.map((c) => c.endpoint)
    expect(endpoints).toContain('/users/@me/guilds')
  })

  it('throws ENOENT when the guild does not exist', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/users/@me/guilds') return []
      return null
    })
    await expect(
      readdir(new DiscordAccessor(t), spec('/mnt/discord/Missing__GX', '/mnt/discord'), idx),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns the channels/members pair without index (no auto-bootstrap)', async () => {
    const t = new FakeDiscordTransport(() => null)
    const out = await readdir(
      new DiscordAccessor(t),
      spec('/mnt/discord/Whatever__G1', '/mnt/discord'),
    )
    expect(out).toEqual(['/mnt/discord/Whatever__G1/channels', '/mnt/discord/Whatever__G1/members'])
    expect(t.calls).toHaveLength(0)
  })
})

describe('readdir /<guild>/channels', () => {
  it('lists channels filtered to text-like types and stores last_message_id as remoteTime', async () => {
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
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/guilds/G1/channels') {
        return [
          { id: 'C1', name: 'general', type: 0, last_message_id: '175928847299117056' },
          { id: 'C2', name: 'voice', type: 2 },
          { id: 'C3', name: 'announcements', type: 5 },
        ]
      }
      return null
    })
    const out = await readdir(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels', '/mnt/discord'),
      idx,
    )
    expect(out).toEqual([
      '/mnt/discord/My Server__G1/channels/general__C1',
      '/mnt/discord/My Server__G1/channels/announcements__C3',
    ])
    const lookup = await idx.get('/mnt/discord/My Server__G1/channels/general__C1')
    expect(lookup.entry?.id).toBe('C1')
    expect(lookup.entry?.resourceType).toBe('discord/channel')
    expect(lookup.entry?.remoteTime).toBe('175928847299117056')
    const announce = await idx.get('/mnt/discord/My Server__G1/channels/announcements__C3')
    expect(announce.entry?.remoteTime).toBe('')
  })

  it('throws ENOENT when no index is provided', async () => {
    const t = new FakeDiscordTransport(() => null)
    await expect(
      readdir(new DiscordAccessor(t), spec('/mnt/discord/My Server__G1/channels', '/mnt/discord')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('auto-bootstraps the root listing when guild not in cache', async () => {
    const idx = new RAMIndexCacheStore()
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/users/@me/guilds') return [{ id: 'G1', name: 'My Server' }]
      if (endpoint === '/guilds/G1/channels') {
        return [{ id: 'C1', name: 'general', type: 0 }]
      }
      return null
    })
    const out = await readdir(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels', '/mnt/discord'),
      idx,
    )
    expect(out).toEqual(['/mnt/discord/My Server__G1/channels/general__C1'])
    const endpoints = t.calls.map((c) => c.endpoint)
    expect(endpoints).toContain('/users/@me/guilds')
    expect(endpoints).toContain('/guilds/G1/channels')
  })
})

describe('readdir /<guild>/members', () => {
  it('lists members with discord/member resourceType', async () => {
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
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/guilds/G1/members') {
        return [
          { user: { id: 'U1', username: 'alice' } },
          { user: { id: 'U2', username: 'bob' } },
          { user: undefined },
        ]
      }
      return null
    })
    const out = await readdir(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/members', '/mnt/discord'),
      idx,
    )
    expect(out).toEqual([
      '/mnt/discord/My Server__G1/members/alice__U1.json',
      '/mnt/discord/My Server__G1/members/bob__U2.json',
    ])
    const lookup = await idx.get('/mnt/discord/My Server__G1/members/alice__U1.json')
    expect(lookup.entry?.id).toBe('U1')
    expect(lookup.entry?.resourceType).toBe('discord/member')
    expect(lookup.entry?.name).toBe('alice')
  })
})

describe('readdir /<guild>/channels/<ch>', () => {
  it('returns 30 dates in descending order using last_message_id', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/discord/My Server__G1/channels', [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'discord/channel',
          vfsName: 'general__C1',
          remoteTime: '175928847299117056',
        }),
      ],
    ])
    const t = new FakeDiscordTransport(() => null)
    const out = await readdir(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
      idx,
    )
    expect(out).toHaveLength(30)
    expect(out[0]).toBe('/mnt/discord/My Server__G1/channels/general__C1/2016-04-30')
    expect(out[1]).toBe('/mnt/discord/My Server__G1/channels/general__C1/2016-04-29')
    expect(out[29]).toBe('/mnt/discord/My Server__G1/channels/general__C1/2016-04-01')
    const lookup = await idx.get('/mnt/discord/My Server__G1/channels/general__C1/2016-04-30')
    expect(lookup.entry?.id).toBe('general__C1:2016-04-30')
    expect(lookup.entry?.resourceType).toBe('discord/date_dir')
    expect(t.calls).toHaveLength(0)
  })

  it('falls back to today UTC when last_message_id is empty', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/discord/My Server__G1/channels', [
      [
        'empty__C2',
        new IndexEntry({
          id: 'C2',
          name: 'empty',
          resourceType: 'discord/channel',
          vfsName: 'empty__C2',
          remoteTime: '',
        }),
      ],
    ])
    const t = new FakeDiscordTransport(() => null)
    const out = await readdir(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels/empty__C2', '/mnt/discord'),
      idx,
    )
    expect(out).toHaveLength(30)
    const now = new Date()
    const yyyy = now.getUTCFullYear().toString().padStart(4, '0')
    const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0')
    const dd = now.getUTCDate().toString().padStart(2, '0')
    expect(out[0]).toBe(`/mnt/discord/My Server__G1/channels/empty__C2/${yyyy}-${mm}-${dd}`)
  })

  it('returns from cache without API call when listDir hits', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/discord/My Server__G1/channels/general__C1', [
      [
        '2024-01-01',
        new IndexEntry({
          id: 'general__C1:2024-01-01',
          name: '2024-01-01',
          resourceType: 'discord/date_dir',
          vfsName: '2024-01-01',
        }),
      ],
    ])
    const t = new FakeDiscordTransport(() => {
      throw new Error('should not be called')
    })
    const out = await readdir(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
      idx,
    )
    expect(out).toEqual(['/mnt/discord/My Server__G1/channels/general__C1/2024-01-01'])
    expect(t.calls).toHaveLength(0)
  })

  it('auto-bootstraps the parent channels listing when not in cache', async () => {
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
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/guilds/G1/channels') {
        return [{ id: 'C1', name: 'general', type: 0, last_message_id: '175928847299117056' }]
      }
      return null
    })
    const out = await readdir(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
      idx,
    )
    expect(out).toHaveLength(30)
    expect(out[0]).toBe('/mnt/discord/My Server__G1/channels/general__C1/2016-04-30')
    const endpoints = t.calls.map((c) => c.endpoint)
    expect(endpoints).toContain('/guilds/G1/channels')
  })
})

describe('readdir unrecognized paths', () => {
  it('returns [] for non-date 4-segment paths', async () => {
    const idx = new RAMIndexCacheStore()
    // 4-segment with non-date last part — must not match date_dir rule
    const t = new FakeDiscordTransport(() => null)
    const out = await readdir(
      new DiscordAccessor(t),
      spec('/mnt/discord/My Server__G1/channels/general__C1/extra', '/mnt/discord'),
      idx,
    )
    expect(out).toEqual([])
  })
})
