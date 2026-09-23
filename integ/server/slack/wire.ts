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

import type { Ctx, JsonValue } from '../kit/typescript/index.ts'
import type { C } from './config.ts'

export interface Reaction {
  name: string
  users: string[]
  count: number
}

export interface UserRow {
  id: string
  name: string
  realName: string
  email: string
  isBot: boolean
  deleted: boolean
}

export interface ChannelRow {
  id: string
  name: string
  kind: string
  created: number
  isArchived: boolean
  isPrivate: boolean
  dmUserId: string | null
  topic: string
  purpose: string
  membersJson: string
}

export interface FileRow {
  id: string
  channelId: string
  messageTs: string
  name: string
  title: string
  mimetype: string
  filetype: string
  size: number
  timestamp: number
  content: string
  contentPath: string | null
}

// Slack takes a method's arguments in the query string or, on a POST, as a form
// body. slack-go (and so slack-mcp-server) sends every call the second way and
// mirage's own client reads with the first, so a read method takes both.
export function argsOf(ctx: Ctx<C>): URLSearchParams {
  const out = new URLSearchParams(ctx.query)
  const raw = ctx.headers['content-type']
  const type = Array.isArray(raw) ? raw[0] : raw
  if (type !== undefined && type.startsWith('application/x-www-form-urlencoded')) {
    for (const [key, value] of new URLSearchParams(ctx.body.toString('utf8'))) {
      out.append(key, value)
    }
  }
  return out
}

// Slack answers 200 for a refused call and puts the failure in the body, so
// `ok: false` is a normal reply here and never an HTTP error.
export function fail(error: string): { status: number; body: JsonValue } {
  return { status: 200, body: { ok: false, error } }
}

export function reactionsOf(json: string | null): Reaction[] {
  return json !== null && json !== '' ? (JSON.parse(json) as Reaction[]) : []
}

export function userJson(u: UserRow): JsonValue {
  return {
    id: u.id,
    name: u.name,
    real_name: u.realName,
    is_bot: u.isBot,
    deleted: u.deleted,
    profile: { real_name: u.realName, display_name: u.name, email: u.email },
  }
}

export function channelJson(c: ChannelRow): JsonValue {
  if (c.kind === 'im' || c.kind === 'mpim') {
    return { id: c.id, created: c.created, is_im: c.kind === 'im', user: c.dmUserId }
  }
  return {
    id: c.id,
    name: c.name,
    created: c.created,
    is_channel: true,
    is_private: c.isPrivate,
    is_archived: c.isArchived,
    name_normalized: c.name,
    topic: textField(c.topic),
    purpose: textField(c.purpose),
    num_members: (JSON.parse(c.membersJson) as string[]).length,
  }
}

// A channel's topic and purpose, as Slack nests them. Who set one and when is
// not modelled, and Slack answers an unset one with the same empty creator and
// zero time.
function textField(value: string): JsonValue {
  return { value, creator: '', last_set: 0 }
}

export function fileMeta(f: FileRow, origin: string): JsonValue {
  return {
    id: f.id,
    name: f.name,
    title: f.title,
    mimetype: f.mimetype,
    filetype: f.filetype,
    size: f.size,
    timestamp: f.timestamp,
    url_private_download: `${origin}/files/download/${f.id}`,
  }
}

// Fixed key order (type, user, text, ts, thread_ts, reactions, files) so the
// rendered chat.jsonl line is byte-identical on both hosts, which dump the
// parsed message verbatim.
export function messageJson(
  m: {
    type: string
    userId: string
    text: string
    ts: string
    threadTs: string | null
    reactionsJson: string | null
  },
  files: FileRow[],
  origin: string,
): JsonValue {
  const base: Record<string, JsonValue> = { type: m.type, user: m.userId, text: m.text, ts: m.ts }
  if (m.threadTs !== null && m.threadTs !== '') base.thread_ts = m.threadTs
  const rs = reactionsOf(m.reactionsJson)
  if (rs.length > 0) {
    base.reactions = rs.map((r) => ({ name: r.name, users: r.users, count: r.count }))
  }
  if (files.length > 0) base.files = files.map((f) => fileMeta(f, origin))
  return base
}

export const CUSTOM_EMOJI: Record<string, JsonValue> = {
  shipit: 'https://emoji.example/shipit.png',
  partyparrot: 'alias:parrot',
}
