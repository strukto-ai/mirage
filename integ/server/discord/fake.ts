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

import { Prisma, PrismaClient } from '../../generated/discord/index.js'
import type { DiscordChannel, DiscordMessage } from '../../generated/discord/index.js'
import { parseConfig } from '../kit/typescript/config.ts'
import { schemaFor } from '../kit/typescript/fixture.ts'
import { route } from '../kit/typescript/route.ts'
import type { Ctx, KitRoute } from '../kit/typescript/route.ts'
import { idWhere, tenantWhere } from '../kit/typescript/tenant.ts'
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

function scope(ctx: Ctx<C>): Prisma.DiscordMessageWhereInput {
  return tenantWhere<Prisma.DiscordMessageWhereInput>(ctx.tenant, KIND)
}

async function botPayload(ctx: Ctx<C>): Promise<{ [key: string]: JsonValue }> {
  const row = await ctx.db.discordBot.findFirst({
    where: tenantWhere<Prisma.DiscordBotWhereInput>(ctx.tenant, KIND),
    orderBy: { seq: 'asc' },
  })
  return row === null ? {} : { id: row.id, username: row.username }
}

async function guildExists(ctx: Ctx<C>, guildId: string): Promise<boolean> {
  const row = await ctx.db.discordGuild.findUnique({
    where: idWhere<Prisma.DiscordGuildWhereUniqueInput>(ctx.tenant, guildId, KIND),
  })
  return row !== null
}

async function channelRow(ctx: Ctx<C>, channelId: string): Promise<DiscordChannel | null> {
  return ctx.db.discordChannel.findUnique({
    where: idWhere<Prisma.DiscordChannelWhereUniqueInput>(ctx.tenant, channelId, KIND),
  })
}

async function messageIn(
  ctx: Ctx<C>,
  channelId: string,
  messageId: string,
): Promise<DiscordMessage | null> {
  return ctx.db.discordMessage.findFirst({
    where: { ...scope(ctx), channelId, id: messageId },
  })
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
  const rows = await ctx.db.discordGuild.findMany({
    where: {
      ...tenantWhere<Prisma.DiscordGuildWhereInput>(ctx.tenant, KIND),
      idNum: { gt: after },
    },
    orderBy: { idNum: 'asc' },
    take: limit,
  })
  return { status: 200, body: rows.map(renderGuild) }
}

async function guildChannels(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const guildId = ctx.params.guild_id ?? ''
  if (!(await guildExists(ctx, guildId))) return unknownChannel()
  // Documented as not paginated: the whole channel list comes back.
  const rows = await ctx.db.discordChannel.findMany({
    where: { ...tenantWhere<Prisma.DiscordChannelWhereInput>(ctx.tenant, KIND), guildId },
    orderBy: { seq: 'asc' },
  })
  return { status: 200, body: rows.map(renderChannel) }
}

async function guildMembers(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const guildId = ctx.params.guild_id ?? ''
  if (!(await guildExists(ctx, guildId))) return unknownChannel()
  const after = cursor(ctx.query.get('after') ?? '0')
  const limit = clamp(ctx.query.get('limit'), 1, MEMBERS_MAX_LIMIT)
  // Documented as ordered by user id, ascending.
  const rows = await ctx.db.discordMember.findMany({
    where: {
      ...tenantWhere<Prisma.DiscordMemberWhereInput>(ctx.tenant, KIND),
      guildId,
      userIdNum: { gt: after },
    },
    orderBy: { userIdNum: 'asc' },
    take: limit,
  })
  return { status: 200, body: rows.map(renderMember) }
}

async function searchMembers(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const guildId = ctx.params.guild_id ?? ''
  if (!(await guildExists(ctx, guildId))) return unknownChannel()
  const needle = (ctx.query.get('query') ?? '').toLowerCase()
  const limit = clamp(ctx.query.get('limit'), 1, MEMBERS_MAX_LIMIT)
  const rows = await ctx.db.discordMember.findMany({
    where: { ...tenantWhere<Prisma.DiscordMemberWhereInput>(ctx.tenant, KIND), guildId },
    orderBy: { userIdNum: 'asc' },
  })
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
  const where = { ...scope(ctx), channelId }
  let rows: DiscordMessage[]
  if (after !== null) {
    // `after` walks forward: the window is the oldest ids above the cursor, so
    // the caller advances with the newest id it received.
    rows = await ctx.db.discordMessage.findMany({
      where: { ...where, idNum: { gt: cursor(after) } },
      orderBy: { seq: 'asc' },
      take: limit,
    })
  } else if (before !== null) {
    rows = await ctx.db.discordMessage.findMany({
      where: { ...where, idNum: { lt: cursor(before) } },
      orderBy: { seq: 'desc' },
      take: limit,
    })
  } else {
    rows = await ctx.db.discordMessage.findMany({
      where,
      orderBy: { seq: 'desc' },
      take: limit,
    })
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
    await ctx.db.discordBlob.create({ data: { tenant: ctx.tenant, id, seq: n, body: part.bytes } })
    out.push({
      id,
      filename,
      size: part.bytes.length,
      url: `${BASE_TOKEN}/attachments/${id}/${filename}`,
      proxy_url: `${BASE_TOKEN}/attachments/${id}/${filename}`,
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
  const tail = await ctx.db.discordMessage.aggregate({
    where: { ...scope(ctx), channelId },
    _max: { seq: true },
  })
  const id = postSnowflake(ctx.minter.next('post'))
  const poll = body.poll
  const row = await ctx.db.discordMessage.create({
    data: {
      tenant: ctx.tenant,
      id,
      seq: (tail._max.seq ?? -1) + 1,
      idNum: BigInt(id),
      channelId,
      guildId: channel.guildId,
      content: pyField(raw, 'content'),
      timestamp: POST_TIMESTAMP,
      editedTimestamp: null,
      authorJson: JSON.stringify({ ...bot, bot: true }),
      attachmentsJson: JSON.stringify(attachments),
      // Discord echoes the poll object (with defaults resolved) on the created
      // message; the fake echoes it verbatim.
      pollJson: poll !== undefined && isObject(poll) ? JSON.stringify(poll) : null,
    },
  })
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
  const row = await ctx.db.discordMessage.update({
    where: idWhere<Prisma.DiscordMessageWhereUniqueInput>(ctx.tenant, messageId, KIND),
    data: { content: pyField(ctx.body, 'content'), editedTimestamp: EDIT_TIMESTAMP },
  })
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
  await ctx.db.discordMessage.delete({
    where: idWhere<Prisma.DiscordMessageWhereUniqueInput>(ctx.tenant, messageId, KIND),
  })
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
  const row = await ctx.db.discordGuild.findUnique({
    where: idWhere<Prisma.DiscordGuildWhereUniqueInput>(
      ctx.tenant,
      ctx.params.guild_id ?? '',
      KIND,
    ),
  })
  if (row === null) return unknownChannel()
  return { status: 200, body: renderGuild(row) }
}

async function searchMessages(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return unauthorized()
  const guildId = ctx.params.guild_id ?? ''
  const needle = ctx.query.get('content') ?? ''
  const channelFilter = ctx.query.get('channel_id')
  const base = baseOf(ctx.url)
  const query = cdnQuery(ctx.run, ctx.tenant)
  const channels = await ctx.db.discordChannel.findMany({
    where: { ...tenantWhere<Prisma.DiscordChannelWhereInput>(ctx.tenant, KIND), guildId },
    orderBy: { seq: 'asc' },
  })
  const contexts: JsonValue[] = []
  for (const channel of channels) {
    if (channelFilter !== null && channel.id !== channelFilter) continue
    const rows = await ctx.db.discordMessage.findMany({
      where: { ...scope(ctx), channelId: channel.id },
      orderBy: { seq: 'asc' },
    })
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
  const seq = await ctx.db.discordReaction.count({
    where: tenantWhere<Prisma.DiscordReactionWhereInput>(ctx.tenant, KIND),
  })
  await ctx.db.discordReaction.create({
    data: { tenant: ctx.tenant, seq, channelId, messageId, emoji: ctx.params.emoji ?? '' },
  })
  return { status: 204 }
}

// The CDN serves attachments without the Authorization header, and it honors
// Range: a fake that answered 200 with the whole body would let a client that
// never applies the window pass anyway.
async function attachment(ctx: Ctx<C>): Promise<Reply> {
  const row = await ctx.db.discordBlob.findUnique({
    where: idWhere<Prisma.DiscordBlobWhereUniqueInput>(
      ctx.tenant,
      ctx.params.attachment_id ?? '',
      KIND,
    ),
  })
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
