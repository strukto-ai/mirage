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
import type { DirListing } from '../../types.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { SlackVFSBase } from '../../vfs/slack/slack.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import type { SlackResponse, SlackTransport } from './client.ts'
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

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

function paths(listed: readonly FileStat[] | DirListing, folder: string): string[] {
  return rowsOf(listed).map((row) => `${folder.replace(/\/$/, '')}/${row.name}`)
}

// A conversation's row as its container's listing names it.
function conversationRow(dirname = 'general__C1', created = 0, name = 'general'): FileStat {
  return new FileStat({
    name: dirname,
    type: FileType.DIRECTORY,
    extra: { channel_id: dirname.split('__').at(-1) ?? '', name, created },
  })
}

// A day's row as its channel's listing names it.
const DAY = new FileStat({
  name: '2026-04-10',
  type: FileType.DIRECTORY,
  extra: { channel_id: 'C1' },
})

function mounted(t: SlackTransport): Workspace {
  return new Workspace({ '/mnt/slack/': new SlackVFSBase({ accessor: new SlackAccessor(t) }) })
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

  it('escapes the cap for a glob span older than the window', () => {
    // A day dir is real for any date the channel has existed for, so a glob
    // older than the 90-day window must still list its days.
    const end = Date.UTC(2024, 0, 100) / 1000
    const start = Date.UTC(2010, 0, 1) / 1000
    const out = dateRange(end, start, 90, ['2010-03-01', '2010-04-01'])
    expect(out).toHaveLength(31)
    expect(out[0]).toBe('2010-03-31')
    expect(out[30]).toBe('2010-03-01')
  })

  it('clips a glob span at both ends of the channel', () => {
    const start = Date.UTC(2010, 2, 10) / 1000
    const end = Date.UTC(2010, 2, 20) / 1000
    const out = dateRange(end, start, 90, ['2010-03-01', '2010-04-01'])
    expect(out[0]).toBe('2010-03-20')
    expect(out[out.length - 1]).toBe('2010-03-10')
  })

  it('lists nothing for a glob span the channel never covered', () => {
    const start = Date.UTC(2020, 0, 1) / 1000
    const end = Date.UTC(2020, 0, 5) / 1000
    expect(dateRange(end, start, 90, ['2010-03-01', '2010-04-01'])).toEqual([])
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
    expect(paths(out, '/mnt/slack')).toEqual([
      '/mnt/slack/channels',
      '/mnt/slack/dms',
      '/mnt/slack/users',
    ])
    expect(t.calls).toHaveLength(0)
  })

  it('returns the three virtual roots for empty prefix', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await readdir(new SlackAccessor(t), spec('/'))
    expect(paths(out, '/')).toEqual(['/channels', '/dms', '/users'])
  })
})

describe('readdir /channels', () => {
  it('lists channels with their ids and creation times', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      channels: [
        { id: 'C1', name: 'general', created: 1000 },
        { id: 'C2', name: 'eng', created: 2000 },
      ],
      response_metadata: { next_cursor: '' },
    }))
    const out = await readdir(new SlackAccessor(t), spec('/mnt/slack/channels', '/mnt/slack'))
    expect(paths(out, '/mnt/slack/channels')).toEqual([
      '/mnt/slack/channels/general__C1',
      '/mnt/slack/channels/eng__C2',
    ])
    const [row] = rowsOf(out)
    expect(row?.extra).toEqual({ channel_id: 'C1', name: 'general', created: 1000 })
    expect(row?.modified).not.toBeNull()
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
    const out = await readdir(new SlackAccessor(t), spec('/mnt/slack/dms', '/mnt/slack'))
    expect(paths(out, '/mnt/slack/dms')).toEqual(['/mnt/slack/dms/alice__D1'])
    const calls = t.calls.map((c) => c.endpoint)
    expect(calls).toContain('conversations.list')
    expect(calls).toContain('users.list')
    const listed = t.calls.find((c) => c.endpoint === 'conversations.list')
    expect(listed?.params?.types).toBe('im,mpim')
    expect(rowsOf(out)[0]?.extra.name).toBe('alice')
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
    const out = await readdir(new SlackAccessor(t), spec('/mnt/slack/users', '/mnt/slack'))
    expect(paths(out, '/mnt/slack/users')).toEqual([
      '/mnt/slack/users/alice__U1.json',
      '/mnt/slack/users/bob__U4.json',
    ])
    expect(rowsOf(out)[0]?.extra.user_id).toBe('U1')
  })
})

describe('readdir channel/<id> (history dates)', () => {
  it('throws ENOENT with no row for the channel', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await expect(
      readdir(new SlackAccessor(t), spec('/mnt/slack/channels/general__C1', '/mnt/slack')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns date filenames bounded by latestMessageTs and created', async () => {
    const created = Date.UTC(2024, 0, 1) / 1000
    const latest = Date.UTC(2024, 0, 3) / 1000
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.history') {
        return { ok: true, messages: [{ ts: String(latest) }] }
      }
      return { ok: true }
    })
    const out = await readdir(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1', '/mnt/slack'),
      conversationRow('general__C1', created),
    )
    expect(paths(out, '/mnt/slack/channels/general__C1')).toEqual([
      '/mnt/slack/channels/general__C1/2024-01-03',
      '/mnt/slack/channels/general__C1/2024-01-02',
      '/mnt/slack/channels/general__C1/2024-01-01',
    ])
    expect(rowsOf(out)[1]?.extra).toEqual({ channel_id: 'C1' })
  })

  it('lists the channels above it through a mount', async () => {
    const created = Date.UTC(2024, 0, 1) / 1000
    const latest = Date.UTC(2024, 0, 2) / 1000
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
    const out = await mounted(t).dispatch('readdir', '/mnt/slack/channels/general__C1')
    expect(out).toEqual([
      '/mnt/slack/channels/general__C1/2024-01-02',
      '/mnt/slack/channels/general__C1/2024-01-01',
    ])
    const endpoints = t.calls.map((c) => c.endpoint)
    expect(endpoints).toContain('conversations.list')
    expect(endpoints).toContain('conversations.history')
  })

  it('throws ENOENT when no listing names the channel', async () => {
    const t = new FakeTransport((endpoint) => {
      if (endpoint === 'conversations.list') {
        return { ok: true, channels: [], response_metadata: { next_cursor: '' } }
      }
      return { ok: true }
    })
    await expect(
      mounted(t).dispatch('readdir', '/mnt/slack/channels/general__CX'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns no dates when channel has no messages and no created', async () => {
    const t = new FakeTransport(() => ({ ok: true, messages: [] }))
    const out = await readdir(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1', '/mnt/slack'),
      conversationRow(),
    )
    expect(rowsOf(out)).toEqual([])
  })

  it('skips tombstoned and access-restricted file payloads', async () => {
    // Such payloads carry an id but no download URL and no size; listing
    // them would surface phantom files and break sizesAlwaysKnown.
    const t = new FakeTransport(() => ({
      ok: true,
      messages: [
        {
          ts: '1775779200.000100',
          files: [
            {
              id: 'F1',
              name: 'report.pdf',
              size: 12,
              url_private_download: 'https://files.slack.test/F1',
            },
            { id: 'F2', mode: 'tombstone' },
            { id: 'F3', name: 'restricted.docx', file_access: 'check_file_info' },
          ],
        },
      ],
    }))
    const listed = (await readdir(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1/2026-04-10', '/mnt/slack'),
      DAY,
    )) as DirListing
    const files = listed.seeds.get('files') ?? []
    expect(files.map((row) => row.name)).toEqual(['report__F1.pdf'])
    expect(files[0]?.size).toBe(12)
  })
})

describe('readdir of an end-scoped conversation without a creation time', () => {
  const latest = Date.UTC(2026, 5, 20) / 1000
  const first = Date.UTC(2026, 4, 30, 12) / 1000
  const end = Date.UTC(2026, 5, 2) / 1000
  const dm = conversationRow('alice__D1', 0, 'alice')

  function history(): FakeTransport {
    return new FakeTransport((endpoint, params) => {
      if (endpoint !== 'conversations.history') return { ok: true }
      if (params?.limit === '1') return { ok: true, messages: [{ ts: latest.toFixed(6) }] }
      return {
        ok: true,
        messages: [{ ts: (first + 3600).toFixed(6) }, { ts: first.toFixed(6) }],
        response_metadata: { next_cursor: '' },
      }
    })
  }

  it('takes a glob span as its first day instead of scanning history', async () => {
    const t = history()
    const out = paths(
      await readdir(
        new SlackAccessor(t, { endTime: '2026-06-02T00:00:00Z' }),
        new PathSpec({
          virtual: '/mnt/slack/dms/alice__D1/2026-05-*',
          directory: '/mnt/slack/dms/alice__D1/',
          vfsPath: mountKey('/mnt/slack/dms/alice__D1/2026-05-*', '/mnt/slack'),
          pattern: '2026-05-*',
        }),
        dm,
      ),
      '/mnt/slack/dms/alice__D1',
    )
    expect(t.calls.filter((c) => c.params?.limit === '200')).toEqual([])
    expect(out).toHaveLength(31)
    expect(out[0]).toBe('/mnt/slack/dms/alice__D1/2026-05-31')
    expect(out[30]).toBe('/mnt/slack/dms/alice__D1/2026-05-01')
  })

  it('pages only the history before the end for a bare listing', async () => {
    const t = history()
    const out = await readdir(
      new SlackAccessor(t, { endTime: '2026-06-02T00:00:00Z' }),
      spec('/mnt/slack/dms/alice__D1', '/mnt/slack'),
      dm,
    )
    expect(t.calls.filter((c) => c.params?.limit === '200').map((c) => c.params)).toEqual([
      { channel: 'D1', limit: '200', latest: end.toFixed(6) },
    ])
    expect(paths(out, '/mnt/slack/dms/alice__D1')).toEqual([
      '/mnt/slack/dms/alice__D1/2026-06-01',
      '/mnt/slack/dms/alice__D1/2026-05-31',
      '/mnt/slack/dms/alice__D1/2026-05-30',
    ])
  })
})

describe('readdir channel window', () => {
  it('lists a channel as a window', async () => {
    // The bare listing covers the last 90 days only; a day that falls out
    // of it still exists and is still readable by path.
    const created = Date.UTC(2024, 0, 1) / 1000
    const latest = Date.UTC(2024, 0, 3) / 1000
    const t = new FakeTransport((endpoint) =>
      endpoint === 'conversations.history'
        ? { ok: true, messages: [{ ts: String(latest) }] }
        : { ok: true },
    )
    const out = await readdir(
      new SlackAccessor(t),
      spec('/mnt/slack/channels/general__C1', '/mnt/slack'),
      conversationRow('general__C1', created),
    )
    expect((out as DirListing).window).toBe(true)
  })
})
