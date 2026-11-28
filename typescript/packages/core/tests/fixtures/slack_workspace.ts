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

export const TEAM = 'unit'
// The bot, in every conversation the fixture holds.
export const TOKEN = `xoxb-${TEAM}`
// A user token naming no one, which the fake reads as the installing user: in
// every conversation, and allowed to search.
export const USER_TOKEN = `xoxp-${TEAM}`
// ben's user token: he is in general only, not in the private random or in
// ana's DM.
export const SEARCHER = `xoxp-${TEAM}.U2`
const FIXTURE = 'unit'
export const HISTORY = '/api/conversations.history'
export const LISTING = '/api/conversations.list'
export const INFO = '/api/conversations.info'
export const EMOJI = '/api/emoji.list'
export const POST = '/api/chat.postMessage'
export const UPDATE = '/api/chat.update'
export const DELETE = '/api/chat.delete'
export const PINS_ADD = '/api/pins.add'
export const PINS_REMOVE = '/api/pins.remove'
export const PINS = '/api/pins.list'
export const REACT = '/api/reactions.add'
export const REACTIONS = '/api/reactions.get'
export const UPLOAD_URL = '/api/files.getUploadURLExternal'
export const COMPLETE = '/api/files.completeUploadExternal'
export const USERS = '/api/users.list'
export const USER = '/api/users.info'
export const AUTH = '/api/auth.test'
export const SEARCH_MESSAGES = '/api/search.messages'
export const SEARCH_FILES = '/api/search.files'
export const DOWNLOAD = '/files/download/:id'
export const UNTIL_CLEARED = 1_000_000

type Row = Record<string, JsonValue>

interface Listed {
  requests: { route: string; query: string; headers: Record<string, string> }[]
}

/** What a Mirage accessor or config on the workspace may set. */
export interface SlackOptions {
  token?: string
  searchToken?: string
  timeout?: number
  startTime?: string
  endTime?: string
}

/** A Slack mount config's fields on the workspace. */
export interface SlackFields extends SlackOptions {
  token: string
  baseUrl: string
}

/**
 * One Slack workspace on the integ Slack fake, in the world the unit fixture
 * seeds, and the reads a test checks it by. Twin of
 * python/tests/fixtures/slack_workspace.py. Kit-only, so node's tests use it
 * too; core's tests/core/slack/workspace.ts adds a Mirage accessor.
 *
 * The world (integ/fixtures/slack/unit.json): ana (U1) and ben (U2), a bot, a
 * deactivated user and Slackbot; general (C1) holds both people, random (C2)
 * is private to ana, D1 is ana's DM; plan.txt is uploaded in general on
 * 2025-11-05 and shared again in random on 2025-11-07, and general holds three
 * more attachments on 2025-11-08.
 */
export class SlackWorkspace {
  readonly run: KitRun

  constructor(origin: string) {
    this.run = new KitRun(origin, { Authorization: `Bearer ${TOKEN}` })
  }

  /** Seed the run afresh with a fixture's world and record its requests. */
  async reset(fixture = FIXTURE): Promise<void> {
    await this.run.call('POST', '/reset', { json: { fixture, tenants: [TEAM] } })
    await this.record()
  }

  /** Start listing requests afresh, with the token each sent. */
  async record(): Promise<void> {
    await this.run.recordRequests('authorization')
  }

  /** A mount config's fields on the workspace, as the user token. */
  config(options: SlackOptions = {}): SlackFields {
    return { token: USER_TOKEN, baseUrl: `${this.run.url}/api`, ...options }
  }

  private async listed(): Promise<Listed['requests']> {
    return (await this.run.call<Listed>('GET', '/_kit/requests')).requests
  }

  /** The query of each search since recording started, in order. */
  async searches(): Promise<string[]> {
    return (await this.listed())
      .filter((r) => r.route === SEARCH_MESSAGES || r.route === SEARCH_FILES)
      .map((r) => new URLSearchParams(r.query).get('query') ?? '')
  }

  /** How many requests went to `route` since recording started, only those
   * sent with `token` when given. */
  async count(route: string, token?: string): Promise<number> {
    return (await this.listed()).filter(
      (r) =>
        r.route === route && (token === undefined || r.headers.authorization === `Bearer ${token}`),
    ).length
  }

  /** Post a message as the bot, from another client, and its ts. */
  async post(channel: string, text: string): Promise<string> {
    const done = await this.run.call<{ ok: boolean; ts: string }>('POST', POST, {
      json: { channel, text },
    })
    if (!done.ok) throw new Error(`post failed: ${JSON.stringify(done)}`)
    return done.ts
  }

  /** A conversation's messages, newest first, as Slack answers. */
  async history(channel: string): Promise<Row[]> {
    const page = await this.run.call<{ messages: Row[] }>(
      'GET',
      `${HISTORY}?channel=${channel}&limit=1000`,
    )
    return page.messages
  }

  /** Pin a message as another client would. */
  async pin(channel: string, ts: string): Promise<void> {
    const done = await this.run.call<{ ok: boolean }>('POST', PINS_ADD, {
      json: { channel, timestamp: ts },
    })
    if (!done.ok) throw new Error(`pin failed: ${JSON.stringify(done)}`)
  }

  /**
   * Answer the next request to `route` with the fake's own first page of
   * `size` rows, so the listing goes on by its cursor. Slack may answer fewer
   * rows than a request's `limit`, and Mirage asks for 200, more than the unit
   * world holds.
   */
  async firstPage(route: string, size: number, params: Record<string, string> = {}): Promise<void> {
    const query = new URLSearchParams({ ...params, limit: String(size) }).toString()
    const own = await this.run.call('GET', `${route}?${query}`)
    await this.run.answerNext('GET', route, 200, own)
  }

  /** Answer every auth.test with the fake's own answer, `fields` changed. */
  async answerAuth(fields: Row): Promise<void> {
    const own = await this.run.call<Row>('GET', AUTH)
    await this.run.answerNext('GET', AUTH, 200, { ...own, ...fields }, UNTIL_CLEARED)
  }

  /** Answer every request to `route` with Slack's refusal `error`. */
  async refuse(route: string, error: string): Promise<void> {
    await this.run.answerNext('GET', route, 200, { ok: false, error }, UNTIL_CLEARED)
  }

  /** Drop the run. */
  async close(): Promise<void> {
    await this.run.close()
  }
}
