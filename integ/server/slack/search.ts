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
import { argsOf, fail, reactionsOf, requestToken } from './wire.ts'

interface Scope {
  parsed: ParsedQuery
  channelId?: string
  fromUserId?: string
  fromMissing: boolean
  channelMissing: boolean
  count: number
  display: (id: string) => string
  isPrivate: (id: string) => boolean
  userName: Map<string, string>
  realName: Map<string, string>
}

function userToken(ctx: Ctx<C>): boolean {
  return /^xox[pc]-/.test(requestToken(ctx.headers, ctx.url, ctx.body) ?? '')
}

function searchPage(ctx: Ctx<C>, matches: JsonValue[], count: number): JsonValue {
  const page = Math.max(1, Number.parseInt(argsOf(ctx).get('page') ?? '1', 10) || 1)
  const total = matches.length
  const pages = Math.ceil(total / count)
  const start = (page - 1) * count
  return {
    total,
    pagination: {
      total_count: total,
      page,
      page_count: pages,
      per_page: count,
      first: total ? start + 1 : 0,
      last: Math.min(start + count, total),
    },
    paging: { count, total, page, pages },
    matches: matches.slice(start, start + count),
  }
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
  if (parsed.fromName !== undefined || parsed.fromId !== undefined) {
    const from = people.find((u) =>
      parsed.fromId !== undefined ? u.id === parsed.fromId : u.name === parsed.fromName,
    )
    if (from !== undefined) fromUserId = from.id
    else fromMissing = true
  }
  const raw = argsOf(ctx).get('count')
  const out: Scope = {
    parsed,
    fromMissing,
    channelMissing:
      (parsed.channelName !== undefined || parsed.dmName !== undefined) && channelId === undefined,
    count: Math.min(100, Math.max(1, Number.parseInt(raw ?? '20', 10) || 20)),
    display,
    isPrivate: (id) => {
      const ch = byId.get(id)
      return ch === undefined || ch.isPrivate || ch.kind !== 'channel'
    },
    userName,
    realName: new Map(people.map((u) => [u.id, u.realName || u.name])),
  }
  if (channelId !== undefined) out.channelId = channelId
  if (fromUserId !== undefined) out.fromUserId = fromUserId
  return out
}

// Search renders emphasis and named mentions; history keeps the stored mrkdwn.
// Pinned by MCP-Atlas's live search/history recordings (#1218).
function searchText(text: string, names: Map<string, string>): string {
  return text
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?;:)])/g, '$1$2')
    .replace(/<@([A-Z0-9]+)>/g, (mention: string, id: string) => {
      const name = names.get(id)
      return name === undefined ? mention : `<@${id}|${name}>`
    })
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
  const rows: MessageRow[] =
    s.fromMissing || s.channelMissing
      ? []
      : await ctx.db.message.findMany({ where, orderBy: { ts: 'asc' } })
  const matches = rows
    .filter(
      (m) =>
        m.text !== '' &&
        m.subtype !== 'channel_join' &&
        m.subtype !== 'channel_leave' &&
        (s.parsed.reaction === undefined ||
          reactionsOf(m.reactionsJson).some((r) => r.name === s.parsed.reaction)) &&
        withinDates(Number(m.ts), s.parsed),
    )
    .map((m) => ({
      type: 'message',
      ...(m.subtype ? { subtype: m.subtype } : {}),
      permalink: `${ctx.url.origin}/archives/${m.channelId}/p${m.ts.replace('.', '')}`,
      user: m.userId,
      username: s.userName.get(m.userId) ?? m.userId,
      ts: m.ts,
      text: searchText(m.text, s.realName),
      channel: { id: m.channelId, name: s.display(m.channelId) },
    }))
  return {
    status: 200,
    body: {
      ok: true,
      query: argsOf(ctx).get('query') ?? '',
      messages: searchPage(ctx, matches, s.count),
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
  // search.files has no author or reaction field in this model, so a from:
  // or has:: query can never match a file; return an empty set rather than
  // silently ignoring it.
  const rows: FileRow[] =
    s.channelMissing ||
    s.parsed.fromName !== undefined ||
    s.parsed.fromId !== undefined ||
    s.parsed.reaction !== undefined
      ? []
      : await ctx.db.slackFile.findMany({ where, orderBy: { id: 'asc' } })
  const matches = rows
    .filter((f) => withinDates(f.timestamp, s.parsed))
    .map((f) => ({
      id: f.id,
      name: f.name,
      title: f.title,
      mimetype: f.mimetype,
      filetype: f.filetype,
      size: f.size,
      timestamp: f.timestamp,
      channels: [f.channelId],
      shares: {
        [s.isPrivate(f.channelId) ? 'private' : 'public']: {
          [f.channelId]: [{ ts: f.messageTs, channel_name: s.display(f.channelId) }],
        },
      },
    }))
  return {
    status: 200,
    body: {
      ok: true,
      query: argsOf(ctx).get('query') ?? '',
      files: searchPage(ctx, matches, s.count),
    },
  }
}

export async function searchAll(ctx: Ctx<C>): Promise<Reply> {
  if (!userToken(ctx)) return fail('not_allowed_token_type')
  const messages = await searchMessages(ctx)
  const files = await searchFiles(ctx)
  return {
    status: 200,
    body: {
      ...(messages.body as Record<string, JsonValue>),
      ...(files.body as Record<string, JsonValue>),
    },
  }
}
