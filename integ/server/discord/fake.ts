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

import type { SQLInputValue } from 'node:sqlite'
import { Prisma, PrismaClient } from '../../generated/discord/index.js'
import type {
  DiscordChannel,
  DiscordGuild,
  DiscordMember,
  DiscordMessage,
} from '../../generated/discord/index.js'
import { parseConfig } from '../kit/typescript/config.ts'
import { schemaFor } from '../kit/typescript/fixture.ts'
import { route } from '../kit/typescript/route.ts'
import type { Ctx, KitRoute } from '../kit/typescript/route.ts'
import { BYTES, all, bytes, exec, one } from '../kit/typescript/sql.ts'
import type { Fake } from '../kit/typescript/base.ts'
import type { Dmmf } from '../kit/typescript/seed.ts'
import type { JsonValue, Reply } from '../kit/typescript/types.ts'
import { readMultipart } from '../box/multipart.ts'
import { materialize } from './seed.ts'
import { pyField } from './pyvalue.ts'
import { renderChannel, renderGuild, renderMember, renderMessage, renderThread } from './render.ts'
import {
  BASE_TOKEN,
  EDIT_TIMESTAMP,
  MEMBERS_MAX_LIMIT,
  MESSAGES_MAX_LIMIT,
  POST_TIMESTAMP,
  baseOf,
  bodyObject,
  cdnQuery,
  clamp,
  cursor,
  invalidFormBody,
  isObject,
  missingAccess,
  parseRange,
  postSnowflake,
  requireBody,
  resolveBase,
  unauthorized,
  unknownChannel,
  unknownMessage,
} from './wire.ts'

type C = PrismaClient

const config = parseConfig({
  service: 'discord',
  schema: schemaFor('discord'),
  tenantKind: 'pk-column',
  mintSharing: 'global',
})

const KIND = config.tenantKind

function authed(ctx: Ctx<C>): boolean {
  const raw = ctx.headers.authorization
  const one = Array.isArray(raw) ? raw[0] : raw
  return typeof one === 'string' && one.startsWith('Bot ')
}

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/discord.prisma declares, rows shaped as Prisma's generated types. A
// BigInt column holds a snowflake past 2^53, which node:sqlite will not read
// as a number, so it is read as text and parsed.
const GUILD =
  'SELECT tenant, id, seq, CAST(idNum AS TEXT) AS idNum, name, members, messages FROM DiscordGuild'
const CHANNEL =
  'SELECT tenant, id, guildId, seq, name, type, topic, position, lastMessageId, botHidden ' +
  'FROM DiscordChannel'
const MEMBER =
  'SELECT pk, tenant, guildId, seq, userId, CAST(userIdNum AS TEXT) AS userIdNum, username, ' +
  'nick, payloadJson FROM DiscordMember'
const MESSAGE =
  'SELECT tenant, id, seq, CAST(idNum AS TEXT) AS idNum, channelId, guildId, content, ' +
  'timestamp, editedTimestamp, authorJson, attachmentsJson, pollJson, pinnedAt FROM DiscordMessage'

type Text<T, K extends keyof T> = Omit<T, K> & Record<K, string>

function toGuild(row: Text<DiscordGuild, 'idNum'>): DiscordGuild {
  return { ...row, idNum: BigInt(row.idNum) }
}

function toChannel(row: Omit<DiscordChannel, 'botHidden'> & { botHidden: number }): DiscordChannel {
  return { ...row, botHidden: row.botHidden === 1 }
}

function toMember(row: Text<DiscordMember, 'userIdNum'>): DiscordMember {
  return { ...row, userIdNum: BigInt(row.userIdNum) }
}

function toMessage(row: Text<DiscordMessage, 'idNum'>): DiscordMessage {
  return { ...row, idNum: BigInt(row.idNum) }
}

function messages(ctx: Ctx<C>, where: string, ...params: SQLInputValue[]): DiscordMessage[] {
  return all<Text<DiscordMessage, 'idNum'>>(
    ctx.sql,
    `${MESSAGE} WHERE tenant = ? AND ${where}`,
    ctx.tenant,
    ...params,
  ).map(toMessage)
}

function messageById(ctx: Ctx<C>, messageId: string): DiscordMessage {
  const row = one<Text<DiscordMessage, 'idNum'>>(
    ctx.sql,
    `${MESSAGE} WHERE tenant = ? AND id = ?`,
    ctx.tenant,
    messageId,
  )
  if (row === null) throw new Error(`discord fake: message ${messageId} vanished`)
  return toMessage(row)
}

// Throws when nothing matched, as Prisma's update and delete did; every route
// looks the message up first.
function changeOne(ctx: Ctx<C>, sql: string, ...params: SQLInputValue[]): void {
  if (exec(ctx.sql, sql, ...params) === 0) throw new Error('discord fake: no row matched')
}

async function botPayload(ctx: Ctx<C>): Promise<{ [key: string]: JsonValue }> {
  const row = one<{ id: string; username: string }>(
    ctx.sql,
    'SELECT id, username FROM DiscordBot WHERE tenant = ? ORDER BY seq LIMIT 1',
    ctx.tenant,
  )
  return row === null ? {} : { id: row.id, username: row.username }
}

async function guildExists(ctx: Ctx<C>, guildId: string): Promise<boolean> {
  const row = one<{ id: string }>(
    ctx.sql,
    'SELECT id FROM DiscordGuild WHERE tenant = ? AND id = ?',
    ctx.tenant,
    guildId,
  )
  return row !== null
}

async function channelRow(ctx: Ctx<C>, channelId: string): Promise<DiscordChannel | null> {
  const row = one<Omit<DiscordChannel, 'botHidden'> & { botHidden: number }>(
    ctx.sql,
    `${CHANNEL} WHERE tenant = ? AND id = ?`,
    ctx.tenant,
    channelId,
  )
  return row === null ? null : toChannel(row)
}

function channelsOf(ctx: Ctx<C>, guildId: string): DiscordChannel[] {
  return all<Omit<DiscordChannel, 'botHidden'> & { botHidden: number }>(
    ctx.sql,
    `${CHANNEL} WHERE tenant = ? AND guildId = ? ORDER BY seq`,
    ctx.tenant,
    guildId,
  ).map(toChannel)
}

async function messageIn(
  ctx: Ctx<C>,
  channelId: string,
  messageId: string,
): Promise<DiscordMessage | null> {
  const rows = messages(ctx, 'channelId = ? AND id = ? LIMIT 1', channelId, messageId)
  return rows[0] ?? null
}

// Newest first, whichever cursor selected the window. The selection reads
// `seq` (insertion order) and the answer sorts on `idNum` (the snowflake), and
// those are genuinely different orders once a message has been posted: a
// posted id derives from a base below every fixture id.
function newestFirst(rows: DiscordMessage[]): DiscordMessage[] {
  return [...rows].sort((a, b) => (a.idNum < b.idNum ? 1 : a.idNum > b.idNum ? -1 : 0))
}

async function currentUserGuilds(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const after = cursor(ctx.query.get('after') ?? '0')
  const limit = clamp(ctx.query.get('limit'), 200, 200)
  const rows = all<Text<DiscordGuild, 'idNum'>>(
    ctx.sql,
    `${GUILD} WHERE tenant = ? AND idNum > ? ORDER BY DiscordGuild.idNum LIMIT ?`,
    ctx.tenant,
    after,
    limit,
  ).map(toGuild)
  return { status: 200, body: rows.map(renderGuild) }
}

async function guildChannels(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const guildId = ctx.params.guild_id ?? ''
  if (!(await guildExists(ctx, guildId))) return unknownChannel()
  // Documented as not paginated: the whole channel list comes back.
  const rows = channelsOf(ctx, guildId)
  return { status: 200, body: rows.map(renderChannel) }
}

async function guildMembers(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const guildId = ctx.params.guild_id ?? ''
  if (!(await guildExists(ctx, guildId))) return unknownChannel()
  const after = cursor(ctx.query.get('after') ?? '0')
  const limit = clamp(ctx.query.get('limit'), 1, MEMBERS_MAX_LIMIT)
  // Documented as ordered by user id, ascending.
  const rows = all<Text<DiscordMember, 'userIdNum'>>(
    ctx.sql,
    `${MEMBER} WHERE tenant = ? AND guildId = ? AND userIdNum > ? ` +
      'ORDER BY DiscordMember.userIdNum LIMIT ?',
    ctx.tenant,
    guildId,
    after,
    limit,
  ).map(toMember)
  return { status: 200, body: rows.map(renderMember) }
}

async function searchMembers(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const guildId = ctx.params.guild_id ?? ''
  if (!(await guildExists(ctx, guildId))) return unknownChannel()
  const needle = (ctx.query.get('query') ?? '').toLowerCase()
  const limit = clamp(ctx.query.get('limit'), 1, MEMBERS_MAX_LIMIT)
  const rows = all<Text<DiscordMember, 'userIdNum'>>(
    ctx.sql,
    `${MEMBER} WHERE tenant = ? AND guildId = ? ORDER BY DiscordMember.userIdNum`,
    ctx.tenant,
    guildId,
  ).map(toMember)
  // Documented as a prefix match on username or nickname.
  const hits = rows.filter(
    (m) =>
      m.username.toLowerCase().startsWith(needle) ||
      (m.nick ?? '').toLowerCase().startsWith(needle),
  )
  return { status: 200, body: hits.slice(0, limit).map(renderMember) }
}

async function channelMessages(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const channelId = ctx.params.channel_id ?? ''
  const channel = await channelRow(ctx, channelId)
  if (channel === null) return unknownChannel()
  if (channel.botHidden) return missingAccess()
  const limit = clamp(ctx.query.get('limit'), 50, MESSAGES_MAX_LIMIT)
  const after = ctx.query.get('after')
  const before = ctx.query.get('before')
  let rows: DiscordMessage[]
  if (after !== null) {
    // `after` walks forward: the window is the oldest ids above the cursor, so
    // the caller advances with the newest id it received.
    rows = messages(
      ctx,
      'channelId = ? AND idNum > ? ORDER BY seq LIMIT ?',
      channelId,
      cursor(after),
      limit,
    )
  } else if (before !== null) {
    rows = messages(
      ctx,
      'channelId = ? AND idNum < ? ORDER BY seq DESC LIMIT ?',
      channelId,
      cursor(before),
      limit,
    )
  } else {
    rows = messages(ctx, 'channelId = ? ORDER BY seq DESC LIMIT ?', channelId, limit)
  }
  const base = baseOf(ctx.url)
  const query = cdnQuery(ctx.run, ctx.tenant)
  return {
    status: 200,
    body: newestFirst(rows).map((m) => resolveBase(renderMessage(m), base, query)),
  }
}

// A message with attachments arrives as multipart: the JSON body in its
// `payload_json` part and each file in a `files[n]` part, named by the
// `attachments` entry whose id is n. Each file is stored as a blob the CDN
// route serves, and the reply carries its resolved url, as Discord's does.
async function attachmentsOf(
  ctx: Ctx<C>,
  payload: { [key: string]: JsonValue },
  parts: Awaited<ReturnType<typeof readMultipart>>,
): Promise<JsonValue[]> {
  const declared = Array.isArray(payload.attachments) ? payload.attachments : []
  const out: JsonValue[] = []
  for (const entry of declared) {
    if (!isObject(entry)) continue
    const part = parts[`files[${String(entry.id)}]`]
    if (part === undefined) continue
    const n = ctx.minter.next('attachment')
    const id = postSnowflake(n)
    const filename = typeof entry.filename === 'string' ? entry.filename : 'file'
    const url = `${BASE_TOKEN}/attachments/${id}/${encodeURIComponent(filename)}`
    exec(
      ctx.sql,
      `INSERT INTO DiscordBlob (tenant, id, seq, body) VALUES (?, ?, ?, ${BYTES})`,
      ctx.tenant,
      id,
      n,
      ...bytes(part.bytes),
    )
    out.push({
      id,
      filename,
      size: part.bytes.length,
      url,
      proxy_url: url,
      content_type: 'application/octet-stream',
    })
  }
  return out
}

async function createMessage(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const channelId = ctx.params.channel_id ?? ''
  const channel = await channelRow(ctx, channelId)
  if (channel === null) return unknownChannel()
  if (channel.botHidden) return missingAccess()
  const type = ctx.headers['content-type']
  const multipart = (Array.isArray(type) ? type[0] : type)?.startsWith('multipart/form-data')
  let raw = ctx.body
  let body: { [key: string]: JsonValue }
  let attachments: JsonValue[] = []
  if (multipart === true) {
    const parts = await readMultipart(ctx)
    const payload = parts.payload_json
    if (payload === undefined) return invalidFormBody()
    raw = Buffer.from(payload.bytes)
    try {
      body = bodyObject(JSON.parse(payload.text) as JsonValue)
    } catch {
      return invalidFormBody()
    }
    attachments = await attachmentsOf(ctx, body, parts)
  } else {
    requireBody(raw)
    body = bodyObject(ctx.json())
  }
  const bot = await botPayload(ctx)
  const tail = one<{ seq: number | null }>(
    ctx.sql,
    'SELECT MAX(seq) AS seq FROM DiscordMessage WHERE tenant = ? AND channelId = ?',
    ctx.tenant,
    channelId,
  )
  const id = postSnowflake(ctx.minter.next('post'))
  const poll = body.poll
  exec(
    ctx.sql,
    'INSERT INTO DiscordMessage (tenant, id, seq, idNum, channelId, guildId, content, ' +
      'timestamp, editedTimestamp, authorJson, attachmentsJson, pollJson) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
    ctx.tenant,
    id,
    (tail?.seq ?? -1) + 1,
    BigInt(id),
    channelId,
    channel.guildId,
    pyField(raw, 'content'),
    POST_TIMESTAMP,
    JSON.stringify({ ...bot, bot: true }),
    JSON.stringify(attachments),
    // Discord echoes the poll object (with defaults resolved) on the created
    // message; the fake echoes it verbatim.
    poll !== undefined && isObject(poll) ? JSON.stringify(poll) : null,
  )
  const row = messageById(ctx, id)
  if (attachments.length === 0) return { status: 200, body: renderMessage(row) }
  return {
    status: 200,
    body: resolveBase(renderMessage(row), baseOf(ctx.url), cdnQuery(ctx.run, ctx.tenant)),
  }
}

async function editMessage(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const channelId = ctx.params.channel_id ?? ''
  const messageId = ctx.params.message_id ?? ''
  requireBody(ctx.body)
  bodyObject(ctx.json())
  const found = await messageIn(ctx, channelId, messageId)
  if (found === null) return unknownMessage()
  changeOne(
    ctx,
    'UPDATE DiscordMessage SET content = ?, editedTimestamp = ? WHERE tenant = ? AND id = ?',
    pyField(ctx.body, 'content'),
    EDIT_TIMESTAMP,
    ctx.tenant,
    messageId,
  )
  const row = messageById(ctx, messageId)
  // Deliberately NOT base-resolved: the python fake returned the stored dict
  // here, so an edited message that carries attachments answers with the
  // literal {base} placeholder its url was seeded with.
  return { status: 200, body: renderMessage(row) }
}

async function deleteMessage(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const channelId = ctx.params.channel_id ?? ''
  const messageId = ctx.params.message_id ?? ''
  const found = await messageIn(ctx, channelId, messageId)
  if (found === null) return unknownMessage()
  changeOne(ctx, 'DELETE FROM DiscordMessage WHERE tenant = ? AND id = ?', ctx.tenant, messageId)
  return { status: 204 }
}

async function createThread(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const channelId = ctx.params.channel_id ?? ''
  const channel = await channelRow(ctx, channelId)
  if (channel === null) return unknownChannel()
  const messageId = ctx.params.message_id
  if (messageId !== undefined && (await messageIn(ctx, channelId, messageId)) === null) {
    return unknownMessage()
  }
  requireBody(ctx.body)
  const body = bodyObject(ctx.json())
  if (messageId === undefined && body.type !== 11 && body.type !== 12) return invalidFormBody()
  const bot = await botPayload(ctx)
  const owner = typeof bot.id === 'string' ? bot.id : ''
  const id = postSnowflake(ctx.minter.next('thread'))
  return {
    status: 200,
    body: renderThread(id, channel.guildId, channelId, owner, pyField(ctx.body, 'name'), messageId),
  }
}

async function guildInfo(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const row = one<Text<DiscordGuild, 'idNum'>>(
    ctx.sql,
    `${GUILD} WHERE tenant = ? AND id = ?`,
    ctx.tenant,
    ctx.params.guild_id ?? '',
  )
  if (row === null) return unknownChannel()
  return { status: 200, body: renderGuild(toGuild(row)) }
}

async function searchMessages(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const guildId = ctx.params.guild_id ?? ''
  const needle = ctx.query.get('content') ?? ''
  const channelFilter = ctx.query.get('channel_id')
  const base = baseOf(ctx.url)
  const query = cdnQuery(ctx.run, ctx.tenant)
  const channels = channelsOf(ctx, guildId)
  const contexts: JsonValue[] = []
  for (const channel of channels) {
    if (channelFilter !== null && channel.id !== channelFilter) continue
    const rows = messages(ctx, 'channelId = ? ORDER BY seq', channel.id)
    for (const row of rows) {
      if (needle !== '' && !row.content.includes(needle)) continue
      contexts.push([resolveBase(renderMessage(row), base, query)])
    }
  }
  return { status: 200, body: { total_results: contexts.length, messages: contexts } }
}

async function addReaction(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const channelId = ctx.params.channel_id ?? ''
  const messageId = ctx.params.message_id ?? ''
  if ((await messageIn(ctx, channelId, messageId)) === null) return unknownMessage()
  exec(
    ctx.sql,
    'INSERT INTO DiscordReaction (tenant, seq, channelId, messageId, emoji) ' +
      'VALUES (?, (SELECT COUNT(*) FROM DiscordReaction WHERE tenant = ?), ?, ?, ?)',
    ctx.tenant,
    ctx.tenant,
    channelId,
    messageId,
    ctx.params.emoji ?? '',
  )
  return { status: 204 }
}

// One message, with the reactions the bare listing leaves out. Discord omits
// the field entirely on a message nobody reacted to.
async function getMessage(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const channelId = ctx.params.channel_id ?? ''
  const messageId = ctx.params.message_id ?? ''
  const row = await messageIn(ctx, channelId, messageId)
  if (row === null) return unknownMessage()
  const added = all<{ emoji: string }>(
    ctx.sql,
    'SELECT emoji FROM DiscordReaction WHERE tenant = ? AND messageId = ? ORDER BY seq',
    ctx.tenant,
    messageId,
  )
  const body = renderMessage(row) as { [key: string]: JsonValue }
  const emojis = [...new Set(added.map((one) => one.emoji))]
  if (emojis.length > 0) {
    body.reactions = emojis.map((name) => {
      const count = added.filter((one) => one.emoji === name).length
      return {
        count,
        count_details: { burst: 0, normal: count },
        me: true,
        me_burst: false,
        emoji: { id: null, name },
        burst_colors: [],
      }
    })
  }
  return { status: 200, body }
}

async function setPin(ctx: Ctx<C>, pinnedAt: string | null): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const channelId = ctx.params.channel_id ?? ''
  const messageId = ctx.params.message_id ?? ''
  if ((await messageIn(ctx, channelId, messageId)) === null) return unknownMessage()
  changeOne(
    ctx,
    'UPDATE DiscordMessage SET pinnedAt = ? WHERE tenant = ? AND id = ?',
    pinnedAt,
    ctx.tenant,
    messageId,
  )
  return { status: 204 }
}

function addPin(ctx: Ctx<C>): Promise<Reply> {
  return setPin(ctx, new Date(ctx.clock.nowMs()).toISOString())
}

function removePin(ctx: Ctx<C>): Promise<Reply> {
  return setPin(ctx, null)
}

// Most recent pin first, a page at a time, `before` a pin's own timestamp.
async function channelPins(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const limit = Number(ctx.url.searchParams.get('limit') ?? '50')
  const before = ctx.url.searchParams.get('before')
  const channelId = ctx.params.channel_id ?? ''
  const rows =
    before === null
      ? messages(
          ctx,
          'channelId = ? AND pinnedAt IS NOT NULL ORDER BY pinnedAt DESC, seq DESC',
          channelId,
        )
      : messages(
          ctx,
          'channelId = ? AND pinnedAt IS NOT NULL AND pinnedAt < ? ' +
            'ORDER BY pinnedAt DESC, seq DESC',
          channelId,
          before,
        )
  const items = rows
    .slice(0, limit)
    .map((row) => ({ pinned_at: row.pinnedAt ?? '', message: renderMessage(row) }))
  return { status: 200, body: { items, has_more: rows.length > limit } }
}

// The CDN serves attachments without the Authorization header, and it honors
// Range: a fake that answered 200 with the whole body would let a client that
// never applies the window pass anyway.
async function attachment(ctx: Ctx<C>): Promise<Reply> {
  const row = one<{ body: Uint8Array }>(
    ctx.sql,
    'SELECT body FROM DiscordBlob WHERE tenant = ? AND id = ?',
    ctx.tenant,
    ctx.params.attachment_id ?? '',
  )
  // An empty Buffer would set Content-Type: application/octet-stream, and
  // aiohttp's bare `web.Response(status=404)` sends no Content-Type at all.
  if (row === null) return { status: 404 }
  const body = Buffer.from(row.body)
  const raw = ctx.headers.range
  const header = Array.isArray(raw) ? raw[0] : raw
  const window = parseRange(header, body.length)
  if (window === null) return { status: 200, body }
  if (window.start >= body.length) {
    return {
      status: 416,
      body: Buffer.alloc(0),
      headers: { 'Content-Range': `bytes */${String(body.length)}` },
    }
  }
  return {
    status: 206,
    body: body.subarray(window.start, Math.max(window.start, window.end)),
    headers: {
      'Content-Range': `bytes ${String(window.start)}-${String(window.end - 1)}/${String(body.length)}`,
    },
  }
}

export const discordFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  defaultTenants: ['default'],
  // `bot_user` and `guilds` are named, not derived: neither de-pluralization
  // reaches a model whose name is prefixed with the service.
  seedRoots: { bot_user: 'DiscordBot', guilds: 'DiscordGuild' },
  afterSeed: (db, tenant, counts) => materialize(db, tenant, KIND, counts),
  routes: (): KitRoute<C>[] => [
    route('GET', '/api/v10/users/@me/guilds', currentUserGuilds),
    route('GET', '/api/v10/guilds/:guild_id/channels', guildChannels),
    route('GET', '/api/v10/guilds/:guild_id/members/search', searchMembers),
    route('GET', '/api/v10/guilds/:guild_id/members', guildMembers),
    route('GET', '/api/v10/guilds/:guild_id/messages/search', searchMessages),
    route('GET', '/api/v10/guilds/:guild_id', guildInfo),
    route('GET', '/api/v10/channels/:channel_id/messages/pins', channelPins),
    route('PUT', '/api/v10/channels/:channel_id/messages/pins/:message_id', addPin, {
      write: true,
    }),
    route('DELETE', '/api/v10/channels/:channel_id/messages/pins/:message_id', removePin, {
      write: true,
    }),
    route('GET', '/api/v10/channels/:channel_id/messages/:message_id', getMessage),
    route('GET', '/api/v10/channels/:channel_id/messages', channelMessages),
    route('POST', '/api/v10/channels/:channel_id/messages', createMessage, { write: true }),
    route('PATCH', '/api/v10/channels/:channel_id/messages/:message_id', editMessage, {
      write: true,
    }),
    route('DELETE', '/api/v10/channels/:channel_id/messages/:message_id', deleteMessage, {
      write: true,
    }),
    route(
      'PUT',
      '/api/v10/channels/:channel_id/messages/:message_id/reactions/:emoji/@me',
      addReaction,
      { write: true },
    ),
    route('POST', '/api/v10/channels/:channel_id/messages/:message_id/threads', createThread, {
      write: true,
    }),
    route('POST', '/api/v10/channels/:channel_id/threads', createThread, { write: true }),
    route('GET', '/attachments/:attachment_id/:filename', attachment),
  ],
}
