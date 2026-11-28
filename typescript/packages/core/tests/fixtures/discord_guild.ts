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

import { type JsonValue, KitRun } from './kit_fake.ts'

export const TOKEN = 'unit-bot-token'
const FIXTURE = 'unit'
export const GUILD = '111'
export const GUILD_DIR = 'My Server__111'
export const GENERAL = '211'
export const RANDOM = '212'
export const ALICE = '311'
export const BOB = '312'
// general's day of two messages: hello, then files with kept.txt and a
// tombstoned attachment.
export const DAY = '2024-01-15'
export const GUILDS = '/api/v10/users/@me/guilds'
export const CHANNELS = '/api/v10/guilds/:guild_id/channels'
export const MEMBERS = '/api/v10/guilds/:guild_id/members'
export const MEMBER_SEARCH = '/api/v10/guilds/:guild_id/members/search'
export const SEARCH = '/api/v10/guilds/:guild_id/messages/search'
export const MESSAGES = '/api/v10/channels/:channel_id/messages'
export const MESSAGE = '/api/v10/channels/:channel_id/messages/:message_id'
export const PINS = '/api/v10/channels/:channel_id/messages/pins'
export const THREADS = '/api/v10/channels/:channel_id/threads'
export const FROM_MESSAGE = '/api/v10/channels/:channel_id/messages/:message_id/threads'
export const ATTACHMENT = '/attachments/:attachment_id/:filename'
export const UNTIL_CLEARED = 1_000_000
const EPOCH = 1420070400000n
const DAY_MS = 86_400_000n
// The most messages Discord answers a page.
export const PAGE = 100

// Discord's own bodies for the refusals a test arms. A 429 is retried after
// its retry_after, so it waits none.
const REFUSALS: Record<number, JsonValue> = {
  401: { message: '401: Unauthorized', code: 0 },
  403: { message: 'Missing Access', code: 50001 },
  404: { message: 'Unknown Channel', code: 10003 },
  429: { message: 'You are being rate limited.', retry_after: 0, global: false },
  500: { message: '500: Internal Server Error', code: 0 },
}

type Row = Record<string, JsonValue>

/** A message, as Discord answers one. */
export type MessageRow = Row & { id: string; content: string }

/** A channel, as Discord lists one. */
export type ChannelRow = Row & { id: string; last_message_id: string | null }

interface Listed {
  requests: { method: string; route: string; path: string; query: string }[]
}

/** The snowflake Discord mints at `ms`. */
export function snowflakeAt(ms: number): bigint {
  return (BigInt(ms) - EPOCH) << 22n
}

/** The UTC day, `YYYY-MM-DD`, a snowflake was minted on. */
export function dayOf(snowflake: bigint): string {
  return new Date(Number((snowflake >> 22n) + EPOCH)).toISOString().slice(0, 10)
}

/** What a Mirage accessor or config on the guild may set. */
export interface DiscordOptions {
  timeout?: number
  startTime?: string
  endTime?: string
}

/** A Discord mount config's fields on the guild. */
export interface DiscordFields extends DiscordOptions {
  token: string
  baseUrl: string
}

/**
 * One Discord server on the integ Discord fake, in the world the unit fixture
 * seeds, as the bot reaches it, and the reads a test checks it by. Twin of
 * python/tests/fixtures/discord_guild.py. Kit-only, so node's tests use it
 * too; core's tests/core/discord/guild.ts adds a Mirage accessor.
 *
 * The world (integ/fixtures/discord/unit.json): My Server (111) with general
 * (211) and random (212); members alice (311, nick al), bob (312) and the bot
 * (911); general holds hello and files on 2024-01-15, the second carrying
 * kept.txt and a tombstoned attachment, and morning on 01-16; random holds one
 * message on 01-14.
 */
export class DiscordGuild {
  readonly run: KitRun

  constructor(origin: string) {
    this.run = new KitRun(origin, { Authorization: `Bot ${TOKEN}` })
  }

  /** Seed the run afresh with a fixture's world and record its requests. */
  async reset(fixture = FIXTURE): Promise<void> {
    await this.run.call('POST', '/reset', { json: { fixture } })
    await this.run.recordRequests()
  }

  /** A mount config's fields on the guild, as the bot. */
  config(options: DiscordOptions = {}): DiscordFields {
    return { token: TOKEN, baseUrl: `${this.run.url}/api/v10`, ...options }
  }

  private async listed(): Promise<Listed['requests']> {
    return (await this.run.call<Listed>('GET', '/_kit/requests')).requests
  }

  /** A channel's messages of one UTC day, oldest first, as Discord answers. */
  async day(channel: string, day: string): Promise<MessageRow[]> {
    const start = Date.parse(`${day}T00:00:00Z`)
    let after = snowflakeAt(start) - 1n
    const end = snowflakeAt(start + Number(DAY_MS))
    const kept: MessageRow[] = []
    while (after < end) {
      const page = await this.run.call<MessageRow[]>(
        'GET',
        `/api/v10/channels/${channel}/messages?after=${String(after)}&limit=${String(PAGE)}`,
      )
      kept.push(...page.filter((m) => BigInt(m.id) < end))
      if (page.length < PAGE) break
      after = page.reduce((top, m) => (BigInt(m.id) > top ? BigInt(m.id) : top), after)
    }
    return kept.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  }

  /** A channel of the guild, as Discord lists it. */
  async channel(channel: string): Promise<ChannelRow> {
    const channels = await this.run.call<ChannelRow[]>('GET', `/api/v10/guilds/${GUILD}/channels`)
    const found = channels.find((c) => c.id === channel)
    if (found === undefined) throw new Error(`no channel ${channel}`)
    return found
  }

  /** A member of the guild, as Discord answers one. */
  async member(user: string): Promise<Row> {
    const members = await this.run.call<Row[]>('GET', `/api/v10/guilds/${GUILD}/members?limit=1000`)
    const found = members.find((m) => (m.user as Row).id === user)
    if (found === undefined) throw new Error(`no member ${user}`)
    return found
  }

  /** One message, as Discord answers it. */
  async message(channel: string, message: string): Promise<MessageRow> {
    return this.run.call<MessageRow>('GET', `/api/v10/channels/${channel}/messages/${message}`)
  }

  /** Post a message as the bot, from another client. */
  async post(channel: string, content: string): Promise<MessageRow> {
    return this.run.call<MessageRow>('POST', `/api/v10/channels/${channel}/messages`, {
      json: { content },
    })
  }

  /**
   * Store messages another client posted, each at its time. Discord mints a
   * post's time itself, so a message on a past day is a stored state, all of
   * them in one statement: the run reloads, which restarts the recording.
   */
  async addMessages(channel: string, author: string, posts: [Date, string][]): Promise<void> {
    const user = JSON.stringify((await this.member(author)).user)
    const rows: string[] = []
    const params: (string | number | bigint)[] = []
    for (const [i, [at, content]] of posts.entries()) {
      const snowflake = snowflakeAt(at.getTime())
      rows.push("('default', ?, ?, ?, ?, ?, ?, ?, ?, '[]')")
      params.push(
        String(snowflake),
        900 + i,
        snowflake,
        channel,
        GUILD,
        content,
        at.toISOString().replace(/\.\d{3}Z$/, '.000000+00:00'),
        user,
      )
    }
    await this.run.execute(
      'INSERT INTO DiscordMessage (tenant, id, seq, idNum, channelId, guildId, content, ' +
        `timestamp, authorJson, attachmentsJson) VALUES ${rows.join(', ')}`,
      ...params,
    )
    await this.run.recordRequests()
  }

  /** Store one message another client posted at `at`, as Discord answers it. */
  async addMessage(
    channel: string,
    at: Date,
    author: string,
    content: string,
  ): Promise<MessageRow> {
    await this.addMessages(channel, author, [[at, content]])
    const id = String(snowflakeAt(at.getTime()))
    const found = (await this.day(channel, at.toISOString().slice(0, 10))).find((m) => m.id === id)
    if (found === undefined) throw new Error(`message ${id} not stored`)
    return found
  }

  /**
   * Each channel day fetched since recording started, as `[channel, day]`: a
   * messages request whose `after` is the eve of a day, the first page of that
   * day's walk.
   */
  async dayFetches(): Promise<[string, string][]> {
    const fetched: [string, string][] = []
    for (const r of await this.listed()) {
      if (r.method !== 'GET' || r.route !== MESSAGES) continue
      const after = new URLSearchParams(r.query).get('after')
      if (after === null) continue
      const first = BigInt(after) + 1n
      if (((first >> 22n) + EPOCH) % DAY_MS !== 0n) continue
      fetched.push([r.path.split('/')[4] ?? '', dayOf(first)])
    }
    return fetched
  }

  /** How many requests went to `route` since recording started. */
  async count(route: string, method = 'GET'): Promise<number> {
    return (await this.listed()).filter((r) => r.route === route && r.method === method).length
  }

  /** Answer requests to `route` with Discord's `status`. */
  async refuse(route: string, status: number, times = UNTIL_CLEARED): Promise<void> {
    await this.run.answerNext('GET', route, status, REFUSALS[status], times)
  }

  /** Drop the run. */
  async close(): Promise<void> {
    await this.run.close()
  }
}
