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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DirListing, FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import type { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import {
  ALICE,
  CHANNELS,
  DAY,
  DiscordGuild,
  GENERAL,
  GUILDS,
  MEMBERS,
  MESSAGES,
  snowflakeAt,
} from '../../../tests/core/discord/guild.ts'
import { mountDiscord } from '../../../tests/workspace/fixtures/chat_fixture.ts'
import { DiscordApiError } from './client.ts'
import { dateRange, readdir } from './readdir.ts'
import { snowflakeToDate } from './entry.ts'
import { compactJsonBytes, jsonlBytes } from '../render/json.ts'

let origin = ''
let guild: DiscordGuild

beforeAll(async () => {
  origin = await serve('discord')
})

beforeEach(async () => {
  guild = new DiscordGuild(origin)
  await guild.reset()
})

afterEach(async () => {
  await guild.close()
})

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

const GUILD_PATH = '/mnt/discord/My Server__111'
const CHANNEL = `${GUILD_PATH}/channels/general__211`

async function listed(ws: Workspace, path: string): Promise<string[]> {
  return (await ws.dispatch('readdir', path)) as string[]
}

async function statOf(ws: Workspace, path: string): Promise<FileStat> {
  return (await ws.dispatch('stat', path)) as FileStat
}

function mounted(): Workspace {
  return mountDiscord(guild.accessor())
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

describe('dateRange', () => {
  it('returns 30 dates in descending order starting at endDate', () => {
    const out = dateRange('2026-04-25', 30)
    expect(out).toHaveLength(30)
    expect(out[0]).toBe('2026-04-25')
    expect(out[1]).toBe('2026-04-24')
    expect(out[29]).toBe('2026-03-27')
  })

  it('honors a custom days argument', () => {
    expect(dateRange('2024-01-03', 3)).toEqual(['2024-01-03', '2024-01-02', '2024-01-01'])
  })

  it('returns [] for malformed input', () => {
    expect(dateRange('', 30)).toEqual([])
  })

  it('reaches days outside the window for a glob span', () => {
    const out = dateRange('2024-01-15', 30, ['2023-11-01', '2023-12-01'])
    expect(out).toHaveLength(30)
    expect(out[0]).toBe('2023-11-30')
    expect(out[29]).toBe('2023-11-01')
  })

  it('clips a glob span at the newest message', () => {
    const out = dateRange('2024-01-15', 30, ['2024-01-01', '2024-02-01'])
    expect(out).toHaveLength(15)
    expect(out[0]).toBe('2024-01-15')
  })

  it('lists nothing for a glob span after the newest message', () => {
    expect(dateRange('2024-01-15', 30, ['2025-01-01', '2025-02-01'])).toEqual([])
  })
})

describe('readdir root', () => {
  it('lists guilds as rows carrying their ids', async () => {
    // The bot is in a second server too.
    await guild.run.execute(
      "INSERT INTO DiscordGuild (tenant, id, seq, idNum, name) VALUES ('default', '222', 2, 222, 'Other')",
    )
    await guild.run.recordRequests()
    const ws = mounted()
    expect(await listed(ws, '/mnt/discord')).toEqual([GUILD_PATH, '/mnt/discord/Other__222'])
    expect((await statOf(ws, GUILD_PATH)).extra.guild_id).toBe('111')
    expect(await guild.count(GUILDS)).toBe(1)
  })

  it('answers a second listing from the first', async () => {
    const ws = mounted()
    await listed(ws, '/mnt/discord')
    expect(await listed(ws, '/mnt/discord')).toEqual([GUILD_PATH])
    expect(await guild.count(GUILDS)).toBe(1)
  })
})

describe('readdir /<guild>', () => {
  it('lists the channels/members pair under a listed guild', async () => {
    expect(await listed(mounted(), GUILD_PATH)).toEqual([
      `${GUILD_PATH}/channels`,
      `${GUILD_PATH}/members`,
    ])
    expect(await guild.count(GUILDS)).toBe(1)
  })

  it('throws ENOENT when the guild does not exist', async () => {
    // The bot is in no server at all.
    await guild.run.answerNext('GET', GUILDS, 200, [])
    await expect(listed(mounted(), '/mnt/discord/Missing__9')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT for a bogus guild', async () => {
    await expect(listed(mounted(), '/mnt/discord/Nope__9')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('readdir /<guild>/channels', () => {
  it('lists channels filtered to text-like types and keeps last_message_id on the row', async () => {
    // Discord's own channel list, with a voice and an announcement channel
    // the unit world does not hold.
    const own = await guild.run.call<Record<string, unknown>[]>(
      'GET',
      '/api/v10/guilds/111/channels',
    )
    await guild.run.answerNext('GET', CHANNELS, 200, [
      ...own,
      { id: '215', name: 'voice', type: 2 },
      { id: '213', name: 'announcements', type: 5 },
    ] as never)
    const ws = mounted()
    expect(await listed(ws, `${GUILD_PATH}/channels`)).toEqual([
      CHANNEL,
      `${GUILD_PATH}/channels/random__212`,
      `${GUILD_PATH}/channels/announcements__213`,
    ])
    const general = await statOf(ws, CHANNEL)
    expect(general.extra.channel_id).toBe(GENERAL)
    expect(general.extra.last_message_id).toBe((await guild.channel(GENERAL)).last_message_id)
    const announce = await statOf(ws, `${GUILD_PATH}/channels/announcements__213`)
    expect(announce.extra.last_message_id).toBe('')
  })

  it('throws ENOENT under a guild no listing names', async () => {
    await guild.run.answerNext('GET', GUILDS, 200, [])
    await expect(listed(mounted(), `${GUILD_PATH}/channels`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('readdir /<guild>/members', () => {
  it('lists members as rows carrying their user ids', async () => {
    // Discord's own member list, with an entry that names no user.
    const own = await guild.run.call<Record<string, unknown>[]>(
      'GET',
      '/api/v10/guilds/111/members?limit=1000',
    )
    await guild.run.answerNext('GET', MEMBERS, 200, [...own, {}] as never)
    const ws = mounted()
    expect(await listed(ws, `${GUILD_PATH}/members`)).toEqual([
      `${GUILD_PATH}/members/alice__311.json`,
      `${GUILD_PATH}/members/bob__312.json`,
      `${GUILD_PATH}/members/mirage-bot__911.json`,
    ])
    expect((await statOf(ws, `${GUILD_PATH}/members/alice__311.json`)).extra.user_id).toBe(ALICE)
  })

  it('sizes each member row as rendered', async () => {
    const ws = mounted()
    await listed(ws, `${GUILD_PATH}/members`)
    expect((await statOf(ws, `${GUILD_PATH}/members/alice__311.json`)).size).toBe(
      compactJsonBytes(await guild.member(ALICE)).byteLength,
    )
  })
})

describe('readdir /<guild>/channels/<ch>/<date>', () => {
  it('sizes chat.jsonl as rendered on the date listing', async () => {
    const ws = mounted()
    await listed(ws, `${CHANNEL}/${DAY}`)
    expect((await statOf(ws, `${CHANNEL}/${DAY}/chat.jsonl`)).size).toBe(
      jsonlBytes(await guild.day(GENERAL, DAY)).byteLength,
    )
  })

  it('skips tombstoned attachments in the files listing', async () => {
    // Tombstoned and access-restricted attachments carry an id but no
    // download URL and no byte size; listing them would surface phantom
    // files that ENOENT on read. The fake stores the tombstone; Discord's
    // own day, one attachment with no size and one with no URL added.
    const eve = snowflakeAt(Date.parse(`${DAY}T00:00:00Z`)) - 1n
    const page = await guild.run.call<Record<string, unknown>[]>(
      'GET',
      `/api/v10/channels/${GENERAL}/messages?after=${String(eve)}&limit=100`,
    )
    const files = page.find((m) => m.content === 'files') as {
      attachments: Record<string, unknown>[]
    }
    const kept = files.attachments[0] ?? {}
    files.attachments.push(
      { id: 'A3', filename: 'sizeless.txt', url: kept.url },
      { id: 'A4', filename: 'urlless.txt', size: 9 },
    )
    await guild.run.answerNext('GET', MESSAGES, 200, page as never)
    expect(await listed(mounted(), `${CHANNEL}/${DAY}/files`)).toEqual([
      `${CHANNEL}/${DAY}/files/kept__A1.txt`,
    ])
  })
})

describe('readdir /<guild>/channels/<ch>', () => {
  it('returns 30 dates in descending order using last_message_id', async () => {
    // general's last message is 2024-01-16.
    const ws = mounted()
    const out = await listed(ws, CHANNEL)
    expect(out).toHaveLength(30)
    expect(out[0]).toBe(`${CHANNEL}/2024-01-16`)
    expect(out[1]).toBe(`${CHANNEL}/2024-01-15`)
    expect(out[29]).toBe(`${CHANNEL}/2023-12-18`)
    expect((await statOf(ws, `${CHANNEL}/2024-01-16`)).extra.channel_id).toBe(GENERAL)
    expect(await guild.count(MESSAGES)).toBe(0)
  })

  it('falls back to today UTC when last_message_id is empty', async () => {
    // A channel no one has posted in.
    await guild.run.execute(
      'INSERT INTO DiscordChannel (tenant, id, guildId, seq, name, type, position) ' +
        "VALUES ('default', '213', '111', 3, 'empty', 0, 2)",
    )
    const out = await listed(mounted(), `${GUILD_PATH}/channels/empty__213`)
    expect(out).toHaveLength(30)
    const now = new Date()
    const yyyy = now.getUTCFullYear().toString().padStart(4, '0')
    const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0')
    const dd = now.getUTCDate().toString().padStart(2, '0')
    expect(out[0]).toBe(`${GUILD_PATH}/channels/empty__213/${yyyy}-${mm}-${dd}`)
  })
})

describe('readdir unrecognized paths', () => {
  it('raises ENOENT for non-date 4-segment paths', async () => {
    // 4-segment with non-date last part — must not match the date_dir rule,
    // and an unrecognized shape is ENOENT rather than an empty listing that
    // reads as a real, empty directory.
    await expect(listed(mounted(), `${CHANNEL}/extra`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('raises ENOTDIR for a file path', async () => {
    await expect(listed(mounted(), `${CHANNEL}/${DAY}/chat.jsonl`)).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })
})

describe('readdir channel window', () => {
  it('lists a channel as a window', async () => {
    // The channel lists the last 30 days: not the backend saying anything
    // outside them is gone.
    const extra = { channel_id: GENERAL, last_message_id: '175928847299117056' }
    const channel = await readdir(
      guild.accessor(),
      spec(CHANNEL, '/mnt/discord'),
      new FileStat({ name: 'general__211', type: FileType.DIRECTORY, extra }),
    )
    expect(channel).toBeInstanceOf(DirListing)
    expect((channel as DirListing).window).toBe(true)
  })
})

describe('a day Discord refuses', () => {
  // Any day: Discord refuses the channel, not the day.
  const day = `${CHANNEL}/2024-01-13`

  it.each([
    [403, ''],
    [403, '/files'],
    [401, ''],
  ])('answers %i at the day%s with EACCES', async (status, below) => {
    await guild.refuse(MESSAGES, status)
    const own = new FileStat({
      name: below === '' ? '2024-01-13' : 'files',
      type: FileType.DIRECTORY,
      extra: { channel_id: GENERAL },
    })
    await expect(
      readdir(guild.accessor(), spec(day + below, '/mnt/discord'), own),
    ).rejects.toMatchObject({ code: 'EACCES', virtualPath: day + below })
  })

  it('answers a vanished channel with ENOENT', async () => {
    await guild.refuse(MESSAGES, 404)
    const own = new FileStat({
      name: '2024-01-13',
      type: FileType.DIRECTORY,
      extra: { channel_id: GENERAL },
    })
    await expect(readdir(guild.accessor(), spec(day, '/mnt/discord'), own)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it.each([429, 500])('propagates %i', async (status) => {
    await guild.refuse(MESSAGES, status)
    const own = new FileStat({
      name: '2024-01-13',
      type: FileType.DIRECTORY,
      extra: { channel_id: GENERAL },
    })
    await expect(readdir(guild.accessor(), spec(day, '/mnt/discord'), own)).rejects.toBeInstanceOf(
      DiscordApiError,
    )
  })
})
