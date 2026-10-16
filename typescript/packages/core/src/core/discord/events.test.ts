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
import { DiscordAccessor } from '../../accessor/discord.ts'
import { FileChangeKind, PathSpec, type JsonValue } from '../../types.ts'
import { DiscordApiError, type DiscordTransport } from './client.ts'
import { snowflakeAt } from './history.ts'
import { DiscordEventHook } from './events.ts'

const { CREATE: C, UPDATE: U, UNKNOWN: X } = FileChangeKind
const GUILD = { id: '900', name: "Ada's Server" }
const GENERAL = { id: '100', name: 'general', type: 0, guild_id: '900' }
const CHANNEL_DIR = "/d/Ada's Server__900/channels/general__100"
const ROOT = new PathSpec({ virtual: '/d', directory: '/d', vfsPath: '' })

function id(year: number, month: number, day: number, hour = 12): string {
  return snowflakeAt(Date.UTC(year, month - 1, day, hour) / 1000).toString()
}

const OLD = id(2026, 9, 20)
const LATE = id(2026, 10, 1, 23)
const THREAD_ID = id(2026, 9, 28)

function fake(): {
  hook: DiscordEventHook
  calls: string[]
  objects: Record<string, Record<string, unknown>>
} {
  const calls: string[] = []
  const objects: Record<string, Record<string, unknown>> = {
    '/guilds/900': GUILD,
    '/channels/100': GENERAL,
    [`/channels/${THREAD_ID}`]: { id: THREAD_ID, name: 'a thread', type: 11, parent_id: '100' },
    '/channels/555': { id: '555', name: 'voice', type: 2 },
  }
  const transport: DiscordTransport = {
    call(_method, endpoint) {
      calls.push(endpoint)
      const found = objects[endpoint]
      if (found === undefined) {
        return Promise.reject(new DiscordApiError(endpoint, 404, 'Unknown Channel'))
      }
      return Promise.resolve({ ...found })
    },
  }
  return { hook: new DiscordEventHook(new DiscordAccessor(transport)), calls, objects }
}

async function map(
  hook: DiscordEventHook,
  eventType: string,
  payload: JsonValue,
): Promise<[FileChangeKind, string][]> {
  const events = await hook.toEvents(ROOT, eventType, payload)
  return events.map((e) => [e.kind, e.path.virtual])
}

describe('DiscordEventHook', () => {
  it('updates the UTC day a message id was minted on', async () => {
    const { hook } = fake()
    expect(await map(hook, 'MESSAGE_CREATE', { id: LATE, channel_id: '100' })).toEqual([
      [U, `${CHANNEL_DIR}/2026-10-01/chat.jsonl`],
    ])
  })

  it("creates a new message's listed attachments", async () => {
    const { hook } = fake()
    const attachments = [
      { id: '7', filename: 'plan.pdf', url: 'u', size: 3 },
      { id: '8', filename: 'gone.png' },
    ]
    expect(await map(hook, 'MESSAGE_CREATE', { id: LATE, channel_id: '100', attachments })).toEqual(
      [
        [U, `${CHANNEL_DIR}/2026-10-01/chat.jsonl`],
        [C, `${CHANNEL_DIR}/2026-10-01/files/plan__7.pdf`],
      ],
    )
  })

  it('refreshes the day an edited or deleted message was posted', async () => {
    const { hook } = fake()
    const day = `${CHANNEL_DIR}/2026-09-20`
    for (const kind of ['MESSAGE_UPDATE', 'MESSAGE_DELETE']) {
      expect(await map(hook, kind, { id: OLD, channel_id: '100' })).toEqual([
        [U, `${day}/chat.jsonl`],
        [X, `${day}/files`],
      ])
    }
  })

  it('names each day of a bulk delete once', async () => {
    const { hook } = fake()
    const found = await map(hook, 'MESSAGE_DELETE_BULK', {
      ids: [OLD, OLD, LATE],
      channel_id: '100',
    })
    expect(found.map(([, path]) => path)).toEqual([
      `${CHANNEL_DIR}/2026-09-20/chat.jsonl`,
      `${CHANNEL_DIR}/2026-09-20/files`,
      `${CHANNEL_DIR}/2026-10-01/chat.jsonl`,
      `${CHANNEL_DIR}/2026-10-01/files`,
    ])
  })

  it("updates a reaction's message day", async () => {
    const { hook } = fake()
    expect(
      await map(hook, 'MESSAGE_REACTION_ADD', { message_id: OLD, channel_id: '100', user_id: '1' }),
    ).toEqual([[U, `${CHANNEL_DIR}/2026-09-20/chat.jsonl`]])
  })

  it('refreshes a thread starter in the parent for a thread message', async () => {
    const { hook } = fake()
    expect(
      await map(hook, 'MESSAGE_CREATE', {
        id: LATE,
        channel_id: THREAD_ID,
        attachments: [{ id: '7', filename: 'a.txt', url: 'u' }],
      }),
    ).toEqual([[U, `${CHANNEL_DIR}/2026-09-28/chat.jsonl`]])
  })

  it('resolves ids once and maps unlisted channels to nothing', async () => {
    const { hook, calls } = fake()
    await map(hook, 'MESSAGE_CREATE', { id: LATE, channel_id: '100' })
    await map(hook, 'MESSAGE_UPDATE', { id: OLD, channel_id: '100' })
    expect(calls).toEqual(['/channels/100', '/guilds/900'])
    expect(await map(hook, 'MESSAGE_CREATE', { id: LATE, channel_id: '555' })).toEqual([])
  })

  it('renames from a channel dispatch and lists again', async () => {
    const { hook, calls } = fake()
    expect(await map(hook, 'CHANNEL_UPDATE', { ...GENERAL, name: 'lobby' })).toEqual([
      [X, "/d/Ada's Server__900/channels"],
    ])
    expect(await map(hook, 'MESSAGE_CREATE', { id: LATE, channel_id: '100' })).toEqual([
      [U, "/d/Ada's Server__900/channels/lobby__100/2026-10-01/chat.jsonl"],
    ])
    expect(calls).not.toContain('/channels/100')
  })

  it('is UNKNOWN on the listing for member and guild dispatches', async () => {
    const { hook } = fake()
    expect(await map(hook, 'GUILD_MEMBER_ADD', { guild_id: '900', user: {} })).toEqual([
      [X, "/d/Ada's Server__900/members"],
    ])
    expect(await map(hook, 'GUILD_CREATE', { id: '900', name: 'New' })).toEqual([[X, '/d']])
    expect(await map(hook, 'GUILD_MEMBER_REMOVE', { guild_id: '900' })).toEqual([
      [X, '/d/New__900/members'],
    ])
  })

  it('maps a direct message and an unknown dispatch to nothing', async () => {
    const { hook } = fake()
    expect(await map(hook, 'MESSAGE_CREATE', { id: LATE })).toEqual([])
    expect(await map(hook, 'TYPING_START', { channel_id: '100' })).toEqual([])
    expect(await map(hook, 'MESSAGE_CREATE', 'not an object')).toEqual([])
  })

  it("forgets a guild's channels on reconnect", async () => {
    const { hook, calls, objects } = fake()
    await map(hook, 'MESSAGE_CREATE', { id: LATE, channel_id: '100' })
    objects['/channels/100'] = { ...GENERAL, name: 'lobby' }
    await map(hook, 'GUILD_CREATE', { id: '900', name: "Ada's Server" })
    expect(await map(hook, 'MESSAGE_CREATE', { id: LATE, channel_id: '100' })).toEqual([
      [U, "/d/Ada's Server__900/channels/lobby__100/2026-10-01/chat.jsonl"],
    ])
    expect(calls.filter((c) => c === '/channels/100')).toHaveLength(2)
  })

  it('is UNKNOWN above a message from a deleted channel or guild', async () => {
    const { hook, objects } = fake()
    const gone = { id: OLD, channel_id: '404', guild_id: '900' }
    expect(await map(hook, 'MESSAGE_DELETE', gone)).toEqual([[X, "/d/Ada's Server__900/channels"]])
    expect(await map(hook, 'MESSAGE_DELETE', { ...gone, guild_id: '901' })).toEqual([[X, '/d']])
    objects['/channels/300'] = { ...GENERAL, id: '300', guild_id: '901' }
    expect(await map(hook, 'MESSAGE_CREATE', { id: LATE, channel_id: '300' })).toEqual([[X, '/d']])
    expect(await map(hook, 'MESSAGE_CREATE', { id: LATE, channel_id: '404' })).toEqual([])
  })
})
