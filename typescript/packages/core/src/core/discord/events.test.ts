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
import { FileChangeKind, PathSpec, type JsonValue } from '../../types.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DiscordGuild } from '../../../tests/core/discord/guild.ts'
import { snowflakeAt } from './history.ts'
import { DiscordEventHook } from './events.ts'

const { CREATE: C, UPDATE: U, UNKNOWN: X } = FileChangeKind
const GUILD_DIR = '/d/My Server__111'
const CHANNEL_DIR = `${GUILD_DIR}/channels/general__211`
const ROOT = new PathSpec({ virtual: '/d', directory: '/d', vfsPath: '' })

function id(year: number, month: number, day: number, hour = 12): string {
  return snowflakeAt(Date.UTC(year, month - 1, day, hour) / 1000).toString()
}

const OLD = id(2026, 9, 20)
const LATE = id(2026, 10, 1, 23)
// A thread started from a message shares its id, so it names its starter's
// day.
const THREAD_ID = id(2026, 9, 28)
const VOICE = '555'
// A channel of a guild the bot's listing does not hold.
const STRAY = '300'

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

async function hook(): Promise<DiscordEventHook> {
  // Channels the unit world does not hold, stored as another client would
  // have made them, in one statement.
  await guild.run.execute(
    'INSERT INTO DiscordChannel (tenant, id, guildId, seq, name, type, position, parentId) VALUES ' +
      "('default', ?, '111', 97, 'a thread', 11, 9, '211'), " +
      "('default', ?, '111', 98, 'voice', 2, 9, NULL), " +
      "('default', ?, '901', 99, 'elsewhere', 0, 9, NULL)",
    THREAD_ID,
    VOICE,
    STRAY,
  )
  await guild.run.recordRequests()
  return new DiscordEventHook(guild.accessor())
}

async function map(
  on: DiscordEventHook,
  eventType: string,
  payload: JsonValue,
): Promise<[FileChangeKind, string][]> {
  const events = await on.toEvents(ROOT, eventType, payload)
  return events.map((e) => [e.kind, e.path.virtual])
}

async function lookups(): Promise<string[]> {
  return (await guild.run.requests()).map((r) => r.split(' ')[1] ?? '')
}

describe('DiscordEventHook', () => {
  it('updates the UTC day a message id was minted on', async () => {
    const on = await hook()
    expect(await map(on, 'MESSAGE_CREATE', { id: LATE, channel_id: '211' })).toEqual([
      [U, `${CHANNEL_DIR}/2026-10-01/chat.jsonl`],
    ])
  })

  it("creates a new message's listed attachments", async () => {
    const on = await hook()
    const attachments = [
      { id: '7', filename: 'plan.pdf', url: 'u', size: 3 },
      { id: '8', filename: 'gone.png' },
    ]
    expect(await map(on, 'MESSAGE_CREATE', { id: LATE, channel_id: '211', attachments })).toEqual([
      [U, `${CHANNEL_DIR}/2026-10-01/chat.jsonl`],
      [C, `${CHANNEL_DIR}/2026-10-01/files/plan__7.pdf`],
    ])
  })

  it('refreshes the day an edited or deleted message was posted', async () => {
    const on = await hook()
    const day = `${CHANNEL_DIR}/2026-09-20`
    for (const kind of ['MESSAGE_UPDATE', 'MESSAGE_DELETE']) {
      expect(await map(on, kind, { id: OLD, channel_id: '211' })).toEqual([
        [U, `${day}/chat.jsonl`],
        [X, `${day}/files`],
      ])
    }
  })

  it('names each day of a bulk delete once', async () => {
    const on = await hook()
    const found = await map(on, 'MESSAGE_DELETE_BULK', {
      ids: [OLD, OLD, LATE],
      channel_id: '211',
    })
    expect(found.map(([, path]) => path)).toEqual([
      `${CHANNEL_DIR}/2026-09-20/chat.jsonl`,
      `${CHANNEL_DIR}/2026-09-20/files`,
      `${CHANNEL_DIR}/2026-10-01/chat.jsonl`,
      `${CHANNEL_DIR}/2026-10-01/files`,
    ])
  })

  it("updates a reaction's message day", async () => {
    const on = await hook()
    expect(
      await map(on, 'MESSAGE_REACTION_ADD', { message_id: OLD, channel_id: '211', user_id: '1' }),
    ).toEqual([[U, `${CHANNEL_DIR}/2026-09-20/chat.jsonl`]])
  })

  it('refreshes a thread starter in the parent for a thread message', async () => {
    const on = await hook()
    expect(
      await map(on, 'MESSAGE_CREATE', {
        id: LATE,
        channel_id: THREAD_ID,
        attachments: [{ id: '7', filename: 'a.txt', url: 'u' }],
      }),
    ).toEqual([[U, `${CHANNEL_DIR}/2026-09-28/chat.jsonl`]])
  })

  it('resolves ids once and maps unlisted channels to nothing', async () => {
    const on = await hook()
    await map(on, 'MESSAGE_CREATE', { id: LATE, channel_id: '211' })
    await map(on, 'MESSAGE_UPDATE', { id: OLD, channel_id: '211' })
    expect(await lookups()).toEqual(['/api/v10/channels/211', '/api/v10/guilds/111'])
    expect(await map(on, 'MESSAGE_CREATE', { id: LATE, channel_id: VOICE })).toEqual([])
  })

  it('renames from a channel dispatch and lists again', async () => {
    const on = await hook()
    const renamed = { id: '211', name: 'lobby', type: 0, guild_id: '111' }
    expect(await map(on, 'CHANNEL_UPDATE', renamed)).toEqual([[X, `${GUILD_DIR}/channels`]])
    expect(await map(on, 'MESSAGE_CREATE', { id: LATE, channel_id: '211' })).toEqual([
      [U, `${GUILD_DIR}/channels/lobby__211/2026-10-01/chat.jsonl`],
    ])
    expect(await lookups()).not.toContain('/api/v10/channels/211')
  })

  it('is UNKNOWN on the listing for member and guild dispatches', async () => {
    const on = await hook()
    expect(await map(on, 'GUILD_MEMBER_ADD', { guild_id: '111', user: {} })).toEqual([
      [X, `${GUILD_DIR}/members`],
    ])
    expect(await map(on, 'GUILD_CREATE', { id: '111', name: 'New' })).toEqual([[X, '/d']])
    expect(await map(on, 'GUILD_MEMBER_REMOVE', { guild_id: '111' })).toEqual([
      [X, '/d/New__111/members'],
    ])
  })

  it('maps a direct message and an unknown dispatch to nothing', async () => {
    const on = await hook()
    expect(await map(on, 'MESSAGE_CREATE', { id: LATE })).toEqual([])
    expect(await map(on, 'TYPING_START', { channel_id: '211' })).toEqual([])
    expect(await map(on, 'MESSAGE_CREATE', 'not an object')).toEqual([])
  })

  it("forgets a guild's channels on reconnect", async () => {
    const on = await hook()
    await map(on, 'MESSAGE_CREATE', { id: LATE, channel_id: '211' })
    // general is renamed while the gateway is away; storing it reloads the
    // run, so the lookups so far are kept before it.
    const before = await lookups()
    await guild.run.execute("UPDATE DiscordChannel SET name = 'lobby' WHERE id = '211'")
    await guild.run.recordRequests()
    await map(on, 'GUILD_CREATE', { id: '111', name: 'My Server' })
    expect(await map(on, 'MESSAGE_CREATE', { id: LATE, channel_id: '211' })).toEqual([
      [U, `${GUILD_DIR}/channels/lobby__211/2026-10-01/chat.jsonl`],
    ])
    const all = [...before, ...(await lookups())]
    expect(all.filter((c) => c === '/api/v10/channels/211')).toHaveLength(2)
  })

  it('is UNKNOWN above a message from a deleted channel or guild', async () => {
    const on = await hook()
    const gone = { id: OLD, channel_id: '404', guild_id: '111' }
    expect(await map(on, 'MESSAGE_DELETE', gone)).toEqual([[X, `${GUILD_DIR}/channels`]])
    expect(await map(on, 'MESSAGE_DELETE', { ...gone, guild_id: '901' })).toEqual([[X, '/d']])
    expect(await map(on, 'MESSAGE_CREATE', { id: LATE, channel_id: STRAY })).toEqual([[X, '/d']])
    expect(await map(on, 'MESSAGE_CREATE', { id: LATE, channel_id: '404' })).toEqual([])
  })
})
