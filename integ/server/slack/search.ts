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

import type { Ctx, JsonValue, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { parseQuery, withinDates } from './query.ts'
import type { ParsedQuery } from './query.ts'
import { channels, users } from './store.ts'
import type { MessageRow } from './store.ts'
import type { ChannelRow, FileRow, UserRow } from './wire.ts'
import { argsOf, fail } from './wire.ts'

interface Scope {
  parsed: ParsedQuery
  channelId?: string
  fromUserId?: string
  fromMissing: boolean
  count: number
  display: (id: string) => string
  userName: Map<string, string>
}

// search.* requires a user token (xoxp-); a bot token is rejected exactly like
// real Slack, so the backend falls back to the per-file scan. This is the one
// place the two tokens a mount carries are told apart, which is why they stay
// distinct rather than collapsing to one string.
function userToken(ctx: Ctx<C>): boolean {
  const raw = ctx.headers.authorization
  const one = Array.isArray(raw) ? raw[0] : raw
  return one !== undefined && one.startsWith('Bearer xoxp-')
}

async function scopeOf(ctx: Ctx<C>): Promise<Scope> {
  const parsed = parseQuery(argsOf(ctx).get('query') ?? '')
  const chans: ChannelRow[] = await channels(ctx.db, ctx.tenant)
  const people: UserRow[] = await users(ctx.db, ctx.tenant)
  const userName = new Map(people.map((u) => [u.id, u.name]))
  const byId = new Map(chans.map((c) => [c.id, c]))
  const display = (id: string): string => {
    const ch = byId.get(id)
    if (ch === undefined) return ''
    if (ch.name !== '') return ch.name
    return ch.dmUserId !== null ? (userName.get(ch.dmUserId) ?? ch.dmUserId) : ch.id
  }
  let channelId: string | undefined
  if (parsed.channelName !== undefined) {
    channelId = chans.find((c) => c.name === parsed.channelName)?.id
  } else if (parsed.dmName !== undefined) {
    const dmUser = people.find((u) => u.name === parsed.dmName)
    if (dmUser !== undefined) channelId = chans.find((c) => c.dmUserId === dmUser.id)?.id
  }
  let fromUserId: string | undefined
  let fromMissing = false
  if (parsed.fromName !== undefined) {
    const from = people.find((u) => u.name === parsed.fromName)
    if (from !== undefined) fromUserId = from.id
    else fromMissing = true
  }
  const raw = argsOf(ctx).get('count')
  const out: Scope = {
    parsed,
    fromMissing,
    count: raw === null ? 20 : Number.parseInt(raw, 10),
    display,
    userName,
  }
  if (channelId !== undefined) out.channelId = channelId
  if (fromUserId !== undefined) out.fromUserId = fromUserId
  return out
}

export async function searchMessages(ctx: Ctx<C>): Promise<Reply> {
  if (!userToken(ctx)) return fail('not_allowed_token_type')
  const s = await scopeOf(ctx)
  const where: Record<string, JsonValue> = {
    tenant: ctx.tenant,
    text: { contains: s.parsed.literal },
  }
  if (s.channelId !== undefined) where.channelId = s.channelId
  if (s.fromUserId !== undefined) where.userId = s.fromUserId
  const rows: MessageRow[] = s.fromMissing
    ? []
    : await ctx.db.message.findMany({ where, orderBy: { ts: 'asc' } })
  const matches = rows
    .filter((m) => withinDates(Number(m.ts), s.parsed))
    .slice(0, s.count)
    .map((m) => ({
      type: 'message',
      user: m.userId,
      username: s.userName.get(m.userId) ?? m.userId,
      ts: m.ts,
      text: m.text,
      channel: { id: m.channelId, name: s.display(m.channelId) },
    }))
  return {
    status: 200,
    body: {
      ok: true,
      query: argsOf(ctx).get('query') ?? '',
      messages: {
        total: matches.length,
        pagination: { total_count: matches.length, page: 1, page_count: 1 },
        paging: { count: s.count, total: matches.length, page: 1, pages: 1 },
        matches,
      },
    },
  }
}

export async function searchFiles(ctx: Ctx<C>): Promise<Reply> {
  if (!userToken(ctx)) return fail('not_allowed_token_type')
  const s = await scopeOf(ctx)
  const where: Record<string, JsonValue> = {
    tenant: ctx.tenant,
    OR: [
      { name: { contains: s.parsed.literal } },
      { title: { contains: s.parsed.literal } },
      { content: { contains: s.parsed.literal } },
    ],
  }
  if (s.channelId !== undefined) where.channelId = s.channelId
  // search.files has no author field in this model, so a from: query can never
  // match a file; return an empty set rather than silently ignoring it.
  const rows: FileRow[] =
    s.parsed.fromName !== undefined
      ? []
      : await ctx.db.slackFile.findMany({ where, orderBy: { id: 'asc' } })
  const matches = rows
    .filter((f) => withinDates(f.timestamp, s.parsed))
    .slice(0, s.count)
    .map((f) => ({
      id: f.id,
      name: f.name,
      title: f.title,
      mimetype: f.mimetype,
      filetype: f.filetype,
      size: f.size,
      timestamp: f.timestamp,
    }))
  return {
    status: 200,
    body: {
      ok: true,
      query: argsOf(ctx).get('query') ?? '',
      files: {
        total: matches.length,
        pagination: { total_count: matches.length, page: 1, page_count: 1 },
        paging: { count: s.count, total: matches.length, page: 1, pages: 1 },
        matches,
      },
    },
  }
}
