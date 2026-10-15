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
import { DirListing, FileStat, FileType, PathSpec } from '../../types.ts'
import { mountDiscord } from '../../vfs/discord/_test_util.ts'
import type { Workspace } from '../../workspace/workspace/workspace.ts'
import {
  DiscordApiError,
  type DiscordMethod,
  type DiscordResponse,
  type DiscordTransport,
} from './client.ts'
import { dateRangeDescending, listFiles, readdir } from './readdir.ts'
import { snowflakeToDate } from './entry.ts'
import { compactJsonBytes, jsonlBytes } from '../render/json.ts'

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
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

const GUILD = '/mnt/discord/My Server__G1'
const CHANNEL = `${GUILD}/channels/general__C1`
const GUILDS = [{ id: 'G1', name: 'My Server' }]

async function listed(ws: Workspace, path: string): Promise<string[]> {
  return (await ws.dispatch('readdir', path)) as string[]
}

async function statOf(ws: Workspace, path: string): Promise<FileStat> {
  return (await ws.dispatch('stat', path)) as FileStat
}

function api(answers: Record<string, DiscordResponse>): FakeDiscordTransport {
  return new FakeDiscordTransport((_m, endpoint) => answers[endpoint] ?? null)
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

  it('reaches days outside the window for a glob span', () => {
    const out = dateRangeDescending('2024-01-15', 30, ['2023-11-01', '2023-12-01'])
    expect(out).toHaveLength(30)
    expect(out[0]).toBe('2023-11-30')
    expect(out[29]).toBe('2023-11-01')
  })

  it('clips a glob span at the newest message', () => {
    const out = dateRangeDescending('2024-01-15', 30, ['2024-01-01', '2024-02-01'])
    expect(out).toHaveLength(15)
    expect(out[0]).toBe('2024-01-15')
  })

  it('lists nothing for a glob span after the newest message', () => {
    expect(dateRangeDescending('2024-01-15', 30, ['2025-01-01', '2025-02-01'])).toEqual([])
  })
})

describe('readdir root', () => {
  it('lists guilds as rows carrying their ids', async () => {
    const t = api({
      '/users/@me/guilds': [
        { id: 'G1', name: 'My Server' },
        { id: 'G2', name: 'Other' },
      ],
    })
    const ws = mountDiscord(t)
    expect(await listed(ws, '/mnt/discord')).toEqual([GUILD, '/mnt/discord/Other__G2'])
    expect((await statOf(ws, GUILD)).extra.guild_id).toBe('G1')
    expect(t.calls).toHaveLength(1)
  })

  it('answers a second listing from the first', async () => {
    const t = api({ '/users/@me/guilds': GUILDS })
    const ws = mountDiscord(t)
    await listed(ws, '/mnt/discord')
    expect(await listed(ws, '/mnt/discord')).toEqual([GUILD])
    expect(t.calls).toHaveLength(1)
  })
})

describe('readdir /<guild>', () => {
  it('lists the channels/members pair under a listed guild', async () => {
    const t = api({ '/users/@me/guilds': GUILDS })
    expect(await listed(mountDiscord(t), GUILD)).toEqual([`${GUILD}/channels`, `${GUILD}/members`])
    expect(t.calls.map((c) => c.endpoint)).toContain('/users/@me/guilds')
  })

  it('throws ENOENT when the guild does not exist', async () => {
    const t = api({ '/users/@me/guilds': [] })
    await expect(listed(mountDiscord(t), '/mnt/discord/Missing__GX')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT for a bogus guild', async () => {
    const t = api({ '/users/@me/guilds': GUILDS })
    await expect(listed(mountDiscord(t), '/mnt/discord/Nope__G9')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('readdir /<guild>/channels', () => {
  it('lists channels filtered to text-like types and keeps last_message_id on the row', async () => {
    const t = api({
      '/users/@me/guilds': GUILDS,
      '/guilds/G1/channels': [
        { id: 'C1', name: 'general', type: 0, last_message_id: '175928847299117056' },
        { id: 'C2', name: 'voice', type: 2 },
        { id: 'C3', name: 'announcements', type: 5 },
      ],
    })
    const ws = mountDiscord(t)
    expect(await listed(ws, `${GUILD}/channels`)).toEqual([
      CHANNEL,
      `${GUILD}/channels/announcements__C3`,
    ])
    const general = await statOf(ws, CHANNEL)
    expect(general.extra.channel_id).toBe('C1')
    expect(general.extra.last_message_id).toBe('175928847299117056')
    const announce = await statOf(ws, `${GUILD}/channels/announcements__C3`)
    expect(announce.extra.last_message_id).toBe('')
  })

  it('throws ENOENT under a guild no listing names', async () => {
    await expect(
      listed(mountDiscord(new FakeDiscordTransport(() => null)), `${GUILD}/channels`),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('readdir /<guild>/members', () => {
  it('lists members as rows carrying their user ids', async () => {
    const t = api({
      '/users/@me/guilds': GUILDS,
      '/guilds/G1/members': [
        { user: { id: 'U1', username: 'alice' } },
        { user: { id: 'U2', username: 'bob' } },
        { user: undefined },
      ],
    })
    const ws = mountDiscord(t)
    expect(await listed(ws, `${GUILD}/members`)).toEqual([
      `${GUILD}/members/alice__U1.json`,
      `${GUILD}/members/bob__U2.json`,
    ])
    expect((await statOf(ws, `${GUILD}/members/alice__U1.json`)).extra.user_id).toBe('U1')
  })

  it('sizes each member row as rendered', async () => {
    const member = { user: { id: 'U1', username: 'alice' }, nick: 'al' }
    const ws = mountDiscord(api({ '/users/@me/guilds': GUILDS, '/guilds/G1/members': [member] }))
    await listed(ws, `${GUILD}/members`)
    expect((await statOf(ws, `${GUILD}/members/alice__U1.json`)).size).toBe(
      compactJsonBytes(member).byteLength,
    )
  })
})

const CHANNELS = [{ id: 'C1', name: 'general', type: 0, last_message_id: '175928847299117056' }]

describe('readdir /<guild>/channels/<ch>/<date>', () => {
  it('sizes chat.jsonl as rendered on the date listing', async () => {
    const messages = [
      { id: '175758114816000001', content: 'hello', attachments: [] },
      { id: '175758114816000002', content: 'world', attachments: [] },
    ]
    const ws = mountDiscord(
      api({
        '/users/@me/guilds': GUILDS,
        '/guilds/G1/channels': CHANNELS,
        '/channels/C1/messages': messages,
      }),
    )
    await listed(ws, `${CHANNEL}/2016-04-30`)
    expect((await statOf(ws, `${CHANNEL}/2016-04-30/chat.jsonl`)).size).toBe(
      jsonlBytes(messages).byteLength,
    )
  })

  it('skips tombstoned attachments in the files listing', async () => {
    // Tombstoned and access-restricted attachments carry an id but no
    // download URL and no byte size; listing them would surface phantom
    // files that ENOENT on read.
    const messages = [
      {
        id: '175758114816000001',
        content: 'files',
        attachments: [
          { id: 'A1', filename: 'kept.txt', url: 'https://cdn.example/kept.txt', size: 5 },
          { id: 'A2', filename: 'tombstoned.txt' },
          { id: 'A3', filename: 'sizeless.txt', url: 'https://cdn.example/sizeless.txt' },
          { id: 'A4', filename: 'urlless.txt', size: 9 },
        ],
      },
    ]
    const ws = mountDiscord(
      api({
        '/users/@me/guilds': GUILDS,
        '/guilds/G1/channels': CHANNELS,
        '/channels/C1/messages': messages,
      }),
    )
    expect(await listed(ws, `${CHANNEL}/2016-04-30/files`)).toEqual([
      `${CHANNEL}/2016-04-30/files/kept__A1.txt`,
    ])
  })
})

describe('readdir /<guild>/channels/<ch>', () => {
  it('returns 30 dates in descending order using last_message_id', async () => {
    const t = api({ '/users/@me/guilds': GUILDS, '/guilds/G1/channels': CHANNELS })
    const ws = mountDiscord(t)
    const out = await listed(ws, CHANNEL)
    expect(out).toHaveLength(30)
    expect(out[0]).toBe(`${CHANNEL}/2016-04-30`)
    expect(out[1]).toBe(`${CHANNEL}/2016-04-29`)
    expect(out[29]).toBe(`${CHANNEL}/2016-04-01`)
    expect((await statOf(ws, `${CHANNEL}/2016-04-30`)).extra.channel_id).toBe('C1')
    expect(t.calls.map((c) => c.endpoint)).not.toContain('/channels/C1/messages')
  })

  it('falls back to today UTC when last_message_id is empty', async () => {
    const t = api({
      '/users/@me/guilds': GUILDS,
      '/guilds/G1/channels': [{ id: 'C2', name: 'empty', type: 0 }],
    })
    const out = await listed(mountDiscord(t), `${GUILD}/channels/empty__C2`)
    expect(out).toHaveLength(30)
    const now = new Date()
    const yyyy = now.getUTCFullYear().toString().padStart(4, '0')
    const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0')
    const dd = now.getUTCDate().toString().padStart(2, '0')
    expect(out[0]).toBe(`${GUILD}/channels/empty__C2/${yyyy}-${mm}-${dd}`)
  })
})

describe('readdir unrecognized paths', () => {
  const t = api({
    '/users/@me/guilds': GUILDS,
    '/guilds/G1/channels': CHANNELS,
    '/channels/C1/messages': [],
  })

  it('raises ENOENT for non-date 4-segment paths', async () => {
    // 4-segment with non-date last part — must not match the date_dir rule,
    // and an unrecognized shape is ENOENT rather than an empty listing that
    // reads as a real, empty directory.
    await expect(listed(mountDiscord(t), `${CHANNEL}/extra`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('raises ENOTDIR for a file path', async () => {
    await expect(listed(mountDiscord(t), `${CHANNEL}/2026-06-01/chat.jsonl`)).rejects.toMatchObject(
      { code: 'ENOTDIR' },
    )
  })
})

describe('readdir channel and sealed-day windows', () => {
  it('lists a channel and a sealed day as windows', async () => {
    // The channel lists the last 30 days, and a 403/404/429 seals an empty
    // day: neither is the backend saying anything outside it is gone.
    const sealed: DiscordTransport = {
      call: (_method, endpoint) =>
        endpoint === '/channels/C1/messages'
          ? Promise.reject(new DiscordApiError(endpoint, 403, 'Missing Access'))
          : Promise.resolve(null),
    }
    const accessor = new DiscordAccessor(sealed)
    const extra = { channel_id: 'C1', last_message_id: '175928847299117056' }
    const channel = await readdir(
      accessor,
      spec(CHANNEL, '/mnt/discord'),
      new FileStat({ name: 'general__C1', type: FileType.DIRECTORY, extra }),
    )
    const day = await readdir(
      accessor,
      spec(`${CHANNEL}/2016-04-30`, '/mnt/discord'),
      new FileStat({ name: '2016-04-30', type: FileType.DIRECTORY, extra: { channel_id: 'C1' } }),
    )
    expect(channel).toBeInstanceOf(DirListing)
    expect((channel as DirListing).window).toBe(true)
    expect(day).toBeInstanceOf(DirListing)
    expect((day as DirListing).entries).toEqual([])
    expect((day as DirListing).window).toBe(true)
  })
})

describe('listFiles of a sealed day', () => {
  // Reached when the files listing was evicted but the day survived; a soft
  // error there must not evict the attachments it listed before.
  it('lists the files as a window too', async () => {
    const sealed: DiscordTransport = {
      call: (_method, endpoint) =>
        endpoint === '/channels/C1/messages'
          ? Promise.reject(new DiscordApiError(endpoint, 403, 'Missing Access'))
          : Promise.resolve(null),
    }
    const own = new FileStat({
      name: 'files',
      type: FileType.DIRECTORY,
      extra: { channel_id: 'C1' },
    })
    const listing = await listFiles(
      new DiscordAccessor(sealed),
      {
        kind: 'files',
        vfsPath: 'g/channels/c/2016-04-30/files',
        slots: { day: '2016-04-30' },
      } as never,
      own,
    )
    expect((listing as DirListing).window).toBe(true)
  })
})
