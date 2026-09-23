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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rangeReply } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { BOT_ID, BOT_USER_ID, BOT_USER_NAME, TEAM_ID, TEAM_NAME } from './config.ts'
import { channelById, channels, fileById, filesIn, messageAt, users } from './store.ts'
import type { MessageRow } from './store.ts'
import {
  CUSTOM_EMOJI,
  argsOf,
  channelJson,
  fail,
  messageJson,
  reactionsOf,
  userJson,
} from './wire.ts'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'slack')

export function fileBytes(f: { content: string; contentPath: string | null }): Buffer {
  return f.contentPath !== null && f.contentPath !== ''
    ? readFileSync(join(FIXTURE_DIR, f.contentPath))
    : Buffer.from(f.content, 'utf8')
}

function intQuery(ctx: Ctx<C>, name: string, fallback: number): number {
  const raw = argsOf(ctx).get(name)
  return raw === null ? fallback : Number.parseInt(raw, 10)
}

// A page size as Slack reads one: unset or not a positive number means the
// method's default, and anything past the ceiling is the ceiling.
function pageSize(ctx: Ctx<C>, fallback: number, ceiling: number): number {
  const asked = intQuery(ctx, 'limit', fallback)
  return Number.isNaN(asked) || asked <= 0 ? fallback : Math.min(asked, ceiling)
}

// Slack's cursors are opaque base64 of what the next page starts at; these are
// the two spellings its own documentation shows, `team:<channel id>` for a
// conversation list and `next_ts:<ts without its dot>` for a thread.
function cursorFor(prefix: string, key: string): string {
  return Buffer.from(`${prefix}:${key}`, 'utf8').toString('base64')
}

function cursorStart(ctx: Ctx<C>, prefix: string, keys: string[]): number | null {
  const raw = argsOf(ctx).get('cursor') ?? ''
  if (raw === '') return 0
  const decoded = Buffer.from(raw, 'base64').toString('utf8')
  if (!decoded.startsWith(`${prefix}:`)) return null
  const at = keys.indexOf(decoded.slice(prefix.length + 1))
  return at === -1 ? null : at
}

// Pages by `limit` (default 100, at most 1000) and a cursor naming the next
// conversation, the way Slack does; it used to answer every conversation at
// once with an empty cursor whatever `limit` said.
export async function conversationsList(ctx: Ctx<C>): Promise<Reply> {
  const args = argsOf(ctx)
  const types = (args.get('types') ?? '').split(',').filter((t) => t !== '')
  const kinds = types.map((t) =>
    t === 'public_channel' || t === 'private_channel' ? 'channel' : t,
  )
  const where: Record<string, JsonValue> = {
    tenant: ctx.tenant,
    kind: { in: kinds.length > 0 ? kinds : ['channel'] },
  }
  if (args.get('exclude_archived') === 'true') where.isArchived = false
  const rows = await ctx.db.channel.findMany({ where, orderBy: { id: 'asc' } })
  const start = cursorStart(
    ctx,
    'team',
    rows.map((row) => row.id),
  )
  if (start === null) return fail('invalid_cursor')
  const size = pageSize(ctx, 100, 1000)
  const next = rows[start + size]
  return {
    status: 200,
    body: {
      ok: true,
      channels: rows.slice(start, start + size).map(channelJson),
      response_metadata: { next_cursor: next === undefined ? '' : cursorFor('team', next.id) },
    },
  }
}

// A thread oldest first: the parent, then its replies. `ts` may name the
// parent or any reply in it, and an unthreaded message answers alone.
// `oldest` / `latest` bound it, exclusive unless `inclusive` is set. The bounds
// pick which messages come back, never what the parent counts or whom a reply
// names as its parent's author.
export async function conversationsReplies(ctx: Ctx<C>): Promise<Reply> {
  const args = argsOf(ctx)
  const channel = args.get('channel') ?? ''
  if ((await channelById(ctx.db, ctx.tenant, channel)) === null) return fail('channel_not_found')
  const asked = await messageAt(ctx.db, ctx.tenant, channel, args.get('ts') ?? '')
  if (asked === null) return fail('thread_not_found')
  const root = asked.threadTs !== null && asked.threadTs !== '' ? asked.threadTs : asked.ts
  const inclusive = ['true', '1'].includes(args.get('inclusive') ?? '')
  const oldest = args.get('oldest')
  const latest = args.get('latest')
  const whole = (await ctx.db.message.findMany({
    where: { tenant: ctx.tenant, channelId: channel, OR: [{ ts: root }, { threadTs: root }] },
    orderBy: { ts: 'asc' },
  })) as MessageRow[]
  const parent = whole.find((m) => m.ts === root)
  const replies = whole.filter((m) => m.ts !== root)
  const thread = whole.filter((m) => {
    const ts = Number(m.ts)
    if (oldest !== null && (inclusive ? ts < Number(oldest) : ts <= Number(oldest))) return false
    if (latest !== null && (inclusive ? ts > Number(latest) : ts >= Number(latest))) return false
    return true
  })
  const start = cursorStart(
    ctx,
    'next_ts',
    thread.map((m) => m.ts.replace('.', '')),
  )
  if (start === null) return fail('invalid_cursor')
  const size = pageSize(ctx, 1000, 1000)
  const next = thread[start + size]
  const files = await filesIn(ctx.db, ctx.tenant, channel)
  const messages = thread.slice(start, start + size).map((m) => {
    const out = messageJson(
      m,
      files.filter((f) => f.messageTs === m.ts),
      ctx.url.origin,
    ) as Record<string, JsonValue>
    if (m.ts !== root) return { ...out, parent_user_id: parent?.userId ?? '' }
    if (replies.length === 0) return out
    const people = [...new Set(replies.map((r) => r.userId))]
    return {
      ...out,
      thread_ts: root,
      reply_count: replies.length,
      reply_users_count: people.length,
      latest_reply: replies[replies.length - 1]!.ts,
      reply_users: people,
    }
  })
  return {
    status: 200,
    body: {
      ok: true,
      messages,
      has_more: next !== undefined,
      response_metadata: {
        next_cursor: next === undefined ? '' : cursorFor('next_ts', next.ts.replace('.', '')),
      },
    },
  }
}

// Who holds the token, and the workspace URL every later call is made under.
// slack-mcp-server calls this first and sends everything after it to
// `<url>api/`, so the URL is the fake's own, with the run it was reached under.
export function authTest(ctx: Ctx<C>): Reply {
  return {
    status: 200,
    body: {
      ok: true,
      url: `${ctx.url.origin}${ctx.runPrefix}/`,
      team: TEAM_NAME,
      user: BOT_USER_NAME,
      team_id: TEAM_ID,
      user_id: BOT_USER_ID,
      bot_id: BOT_ID,
      is_enterprise_install: false,
    },
  }
}

// client.userBoot is Slack's own web client bootstrap, undocumented, and
// slack-mcp-server refuses to start without it: it reads `ims` to find DMs
// shared from another workspace. The fake answers who is signed in and its
// DMs, none of them shared, and nothing else the real reply carries.
export async function clientUserBoot(ctx: Ctx<C>): Promise<Reply> {
  const dms = await ctx.db.channel.findMany({
    where: { tenant: ctx.tenant, kind: 'im' },
    orderBy: { id: 'asc' },
  })
  return {
    status: 200,
    body: {
      ok: true,
      self: { id: BOT_USER_ID, name: BOT_USER_NAME },
      team: { id: TEAM_ID, name: TEAM_NAME },
      ims: dms.map((dm) => ({
        id: dm.id,
        created: dm.created,
        is_im: true,
        user: dm.dmUserId,
        is_shared: false,
        is_ext_shared: false,
        is_open: true,
      })),
    },
  }
}

export async function conversationsHistory(ctx: Ctx<C>): Promise<Reply> {
  const args = argsOf(ctx)
  const channel = args.get('channel') ?? ''
  const oldest = args.get('oldest')
  const latest = args.get('latest')
  const where: Record<string, JsonValue> = { tenant: ctx.tenant, channelId: channel }
  const ts: Record<string, string> = {}
  if (oldest !== null) ts.gte = oldest
  if (latest !== null) ts.lte = latest
  if (Object.keys(ts).length > 0) where.ts = ts
  // Slack returns most-recent-first; the backend re-sorts the day window.
  const rows: MessageRow[] = await ctx.db.message.findMany({
    where,
    orderBy: { ts: 'desc' },
    take: intQuery(ctx, 'limit', 100),
  })
  const files = await filesIn(ctx.db, ctx.tenant, channel)
  const messages = rows.map((m) =>
    messageJson(
      m,
      files.filter((f) => f.messageTs === m.ts),
      ctx.url.origin,
    ),
  )
  return { status: 200, body: { ok: true, messages, response_metadata: { next_cursor: '' } } }
}

export async function usersList(ctx: Ctx<C>): Promise<Reply> {
  const rows = await users(ctx.db, ctx.tenant)
  return {
    status: 200,
    body: { ok: true, members: rows.map(userJson), response_metadata: { next_cursor: '' } },
  }
}

export async function usersInfo(ctx: Ctx<C>): Promise<Reply> {
  const row = await ctx.db.user.findUnique({
    where: { tenant_id: { tenant: ctx.tenant, id: argsOf(ctx).get('user') ?? '' } },
  })
  if (row === null) return fail('user_not_found')
  return { status: 200, body: { ok: true, user: userJson(row) } }
}

export async function pinsList(ctx: Ctx<C>): Promise<Reply> {
  const channel = argsOf(ctx).get('channel') ?? ''
  const pinned = await ctx.db.pin.findMany({
    where: { tenant: ctx.tenant, channelId: channel },
    orderBy: { ts: 'asc' },
  })
  const items: JsonValue[] = []
  for (const pin of pinned) {
    const m = await ctx.db.message.findUnique({
      where: { tenant_channelId_ts: { tenant: ctx.tenant, channelId: channel, ts: pin.ts } },
    })
    if (m === null) continue
    items.push({
      type: 'message',
      channel,
      message: { type: m.type, user: m.userId, text: m.text, ts: m.ts },
    })
  }
  return { status: 200, body: { ok: true, items } }
}

export async function reactionsGet(ctx: Ctx<C>): Promise<Reply> {
  const args = argsOf(ctx)
  const channel = args.get('channel') ?? ''
  const timestamp = args.get('timestamp') ?? ''
  const m = await ctx.db.message.findUnique({
    where: { tenant_channelId_ts: { tenant: ctx.tenant, channelId: channel, ts: timestamp } },
  })
  if (m === null) return fail('message_not_found')
  const message: Record<string, JsonValue> = {
    type: m.type,
    user: m.userId,
    text: m.text,
    ts: m.ts,
  }
  const rs = reactionsOf(m.reactionsJson)
  if (rs.length > 0) {
    message.reactions = rs.map((r) => ({ name: r.name, users: r.users, count: r.count }))
  }
  return { status: 200, body: { ok: true, message, type: 'message', channel } }
}

export function emojiList(): Reply {
  return { status: 200, body: { ok: true, emoji: CUSTOM_EMOJI } }
}

// Slack serves files from a CDN that honours Range. The fake this replaces
// hand-rolled the parse and read `bytes=-5` as the FIRST six bytes rather than
// the last five, which is the same defect the dropbox and box fakes each had
// independently; rangeReply is the kit's, so there is one implementation now.
export async function download(ctx: Ctx<C>): Promise<Reply> {
  const file = await fileById(ctx.db, ctx.tenant, ctx.params.id ?? '')
  if (file === null) return { status: 404, body: { error: 'not_found' } }
  return rangeReply(ctx.headers, fileBytes(file), file.mimetype)
}

export { channelById, channels }
