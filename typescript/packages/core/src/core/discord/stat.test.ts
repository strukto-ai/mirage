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
import { ContentType, FileType, type FileStat } from '../../types.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { ALICE, DAY, DiscordGuild, GENERAL, GUILDS } from '../../../tests/core/discord/guild.ts'
import { mountDiscord } from '../../../tests/workspace/fixtures/chat_fixture.ts'
import { snowflakeToIso } from './entry.ts'

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

const GUILD_PATH = '/mnt/discord/My Server__111'
const CHANNEL = `${GUILD_PATH}/channels/general__211`

async function stat(path: string): Promise<FileStat> {
  return (await mountDiscord(guild.accessor()).dispatch('stat', path)) as FileStat
}

describe('stat virtual root', () => {
  it('returns DIRECTORY for root', async () => {
    const out = await stat('/mnt/discord')
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(await guild.run.requests()).toEqual([])
  })
})

describe('stat guild dir', () => {
  it('returns DIRECTORY with extra.guild_id for a listed guild', async () => {
    const out = await stat(GUILD_PATH)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('My Server__111')
    expect(out.extra.guild_id).toBe('111')
  })

  it('throws ENOENT for a guild the listing does not name', async () => {
    await expect(stat('/mnt/discord/Missing__9')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat containers under guild', () => {
  it('returns DIRECTORY for /<g>/channels once the guild is proven', async () => {
    const out = await stat(`${GUILD_PATH}/channels`)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('channels')
  })

  it('returns DIRECTORY for /<g>/members once the guild is proven', async () => {
    const out = await stat(`${GUILD_PATH}/members`)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('members')
  })

  it('throws ENOENT for a container under a bogus guild', async () => {
    // The containers exist per guild, so a guild the listing does not
    // prove takes its children with it.
    await expect(stat('/mnt/discord/Nope__9/channels')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat channel dir', () => {
  it('returns DIRECTORY with extra.channel_id for a listed channel', async () => {
    const out = await stat(CHANNEL)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('general__211')
    expect(out.extra.channel_id).toBe(GENERAL)
    // A channel is dated by its last message.
    const listed = await guild.channel(GENERAL)
    expect(out.modified).toBe(snowflakeToIso(listed.last_message_id ?? ''))
  })

  it('throws ENOENT for a channel the listing does not name', async () => {
    await expect(stat(`${GUILD_PATH}/channels/nope__9`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat member file', () => {
  it('returns JSON with extra.user_id for a listed member', async () => {
    const out = await stat(`${GUILD_PATH}/members/alice__311.json`)
    expect(out.content).toBe(ContentType.JSON)
    expect(out.name).toBe('alice__311.json')
    expect(out.extra.user_id).toBe(ALICE)
  })

  it('throws ENOENT for a member the listing does not name', async () => {
    await expect(stat(`${GUILD_PATH}/members/carol__399.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('stat history chat.jsonl', () => {
  it('returns TEXT with the rendered size once the day is fetched', async () => {
    const out = await stat(`${CHANNEL}/${DAY}/chat.jsonl`)
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('chat.jsonl')
    expect(out.size).not.toBeNull()
  })

  it('throws ENOENT for chat.jsonl under a bogus channel', async () => {
    await expect(stat(`${GUILD_PATH}/channels/nope__9/${DAY}/chat.jsonl`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('returns DIRECTORY for a date dir under a real channel', async () => {
    const out = await stat(`${CHANNEL}/2024-01-10`)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('2024-01-10')
  })
})

describe('stat unknown', () => {
  it('throws ENOENT for unknown 2-segment shape', async () => {
    await expect(stat(`${GUILD_PATH}/foo`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for 4+ segment shape that is not history', async () => {
    await expect(stat(`${CHANNEL}/extra`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for unknown 3-segment shape', async () => {
    await expect(stat(`${GUILD_PATH}/foo/bar`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('discord stat parent-listing failures', () => {
  it('propagates a backend failure instead of reporting ENOENT', async () => {
    await guild.refuse(GUILDS, 401)
    // Discord's 401 is a refusal on the listing above, not an absent guild.
    await expect(stat('/mnt/discord/guild-a__7')).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('still reports ENOENT when the parent is genuinely missing', async () => {
    await guild.refuse(GUILDS, 404)
    await expect(stat('/mnt/discord/guild-a__7')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
