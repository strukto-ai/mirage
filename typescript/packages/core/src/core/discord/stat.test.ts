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
import { ContentType, FileType, type FileStat } from '../../types.ts'
import { FakeDiscordTransport, mountDiscord, type Responder } from '../../vfs/discord/_test_util.ts'
import type { DiscordResponse, DiscordTransport } from './client.ts'

const GUILD = '/mnt/discord/My Server__G1'
const CHANNEL = `${GUILD}/channels/general__C1`

async function stat(t: DiscordTransport, path: string): Promise<FileStat> {
  return (await mountDiscord(t).dispatch('stat', path)) as FileStat
}

function api(answers: Record<string, DiscordResponse>): FakeDiscordTransport {
  const responder: Responder = (_m, endpoint) => answers[endpoint] ?? null
  return new FakeDiscordTransport(responder)
}

const GUILDS = { '/users/@me/guilds': [{ id: 'G1', name: 'My Server' }] }

describe('stat virtual root', () => {
  it('returns DIRECTORY for root', async () => {
    const t = new FakeDiscordTransport()
    const out = await stat(t, '/mnt/discord')
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(t.calls).toHaveLength(0)
  })
})

describe('stat guild dir', () => {
  it('returns DIRECTORY with extra.guild_id for a listed guild', async () => {
    const out = await stat(api(GUILDS), GUILD)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('My Server__G1')
    expect(out.extra.guild_id).toBe('G1')
  })

  it('throws ENOENT for a guild the listing does not name', async () => {
    await expect(stat(api(GUILDS), '/mnt/discord/Missing__GX')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('stat containers under guild', () => {
  it('returns DIRECTORY for /<g>/channels once the guild is proven', async () => {
    const out = await stat(api(GUILDS), `${GUILD}/channels`)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('channels')
  })

  it('returns DIRECTORY for /<g>/members once the guild is proven', async () => {
    const out = await stat(api(GUILDS), `${GUILD}/members`)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('members')
  })

  it('throws ENOENT for a container under a bogus guild', async () => {
    // The containers exist per guild, so a guild the listing does not
    // prove takes its children with it.
    await expect(stat(api(GUILDS), '/mnt/discord/Nope__G9/channels')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('stat channel dir', () => {
  it('returns DIRECTORY with extra.channel_id for a listed channel', async () => {
    const t = api({
      ...GUILDS,
      '/guilds/G1/channels': [
        { id: 'C1', name: 'general', type: 0, last_message_id: '794354201395200000' },
      ],
    })
    const out = await stat(t, CHANNEL)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('general__C1')
    expect(out.extra.channel_id).toBe('C1')
    expect(out.modified).toBe('2021-01-01T00:00:00Z')
  })

  it('throws ENOENT for a channel the listing does not name', async () => {
    const t = api({ ...GUILDS, '/guilds/G1/channels': [] })
    await expect(stat(t, CHANNEL)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stat member file', () => {
  it('returns JSON with extra.user_id for a listed member', async () => {
    const t = api({
      ...GUILDS,
      '/guilds/G1/members': [{ user: { id: 'U1', username: 'alice' } }],
    })
    const out = await stat(t, `${GUILD}/members/alice__U1.json`)
    expect(out.content).toBe(ContentType.JSON)
    expect(out.name).toBe('alice__U1.json')
    expect(out.extra.user_id).toBe('U1')
  })

  it('throws ENOENT for a member the listing does not name', async () => {
    const t = api({ ...GUILDS, '/guilds/G1/members': [] })
    await expect(stat(t, `${GUILD}/members/alice__U1.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('stat history chat.jsonl', () => {
  it('returns TEXT with the rendered size once the day is fetched', async () => {
    const t = api({
      ...GUILDS,
      '/guilds/G1/channels': [{ id: 'C1', name: 'general', type: 0 }],
      '/channels/C1/messages': [{ id: '1196300000000000000', content: 'hello' }],
    })
    const out = await stat(t, `${CHANNEL}/2024-01-15/chat.jsonl`)
    expect(out.content).toBe(ContentType.TEXT)
    expect(out.name).toBe('chat.jsonl')
    expect(out.size).not.toBeNull()
  })

  it('throws ENOENT for chat.jsonl under a bogus channel', async () => {
    const t = api({ ...GUILDS, '/guilds/G1/channels': [] })
    await expect(stat(t, `${CHANNEL}/2024-01-15/chat.jsonl`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('returns DIRECTORY for a date dir under a real channel', async () => {
    const t = api({
      ...GUILDS,
      '/guilds/G1/channels': [{ id: 'C1', name: 'general', type: 0 }],
      '/channels/C1/messages': [],
    })
    const out = await stat(t, `${CHANNEL}/2024-01-15`)
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('2024-01-15')
  })
})

describe('stat unknown', () => {
  it('throws ENOENT for unknown 2-segment shape', async () => {
    await expect(stat(api(GUILDS), `${GUILD}/foo`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for 4+ segment shape that is not history', async () => {
    const t = api({ ...GUILDS, '/guilds/G1/channels': [{ id: 'C1', name: 'general', type: 0 }] })
    await expect(stat(t, `${CHANNEL}/extra`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for unknown 3-segment shape', async () => {
    await expect(stat(api(GUILDS), `${GUILD}/foo/bar`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('discord stat parent-listing failures', () => {
  class FailingTransport implements DiscordTransport {
    constructor(private readonly err: Error) {}
    call(): Promise<DiscordResponse> {
      return Promise.reject(this.err)
    }
  }

  it('propagates a backend failure instead of reporting ENOENT', async () => {
    const boom = Object.assign(new Error('401 Unauthorized'), { status: 401 })
    await expect(stat(new FailingTransport(boom), '/mnt/discord/guild-a__G7')).rejects.toThrow(
      '401 Unauthorized',
    )
  })

  it('still reports ENOENT when the parent is genuinely missing', async () => {
    const gone = Object.assign(new Error('/mnt/discord'), { code: 'ENOENT' })
    await expect(
      stat(new FailingTransport(gone), '/mnt/discord/guild-a__G7'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
