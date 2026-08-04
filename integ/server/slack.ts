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

// One shared fake Slack Web API, backed by Prisma + SQLite and seeded from
// integ/fixtures/slack/v1.json. The Python and TypeScript battery hosts both
// point their slack mounts at SLACK_URL/api and call it over HTTP, so every
// response is byte-identical across hosts by construction. Search endpoints
// (search.messages / search.files) are mocked so the grep/rg push-down runs
// live; they require a user token (xoxp-) exactly like real Slack.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = join(HERE, '..', 'prisma', 'schema.prisma')
const FIXTURE_DIR = join(HERE, '..', 'fixtures', 'slack')
const FIXTURE = join(FIXTURE_DIR, 'v1.json')
const DEFAULT_PORT = 5097
// chat.postMessage assigns synthetic, deterministic ts values so the write
// commands produce byte-identical output on both hosts. postSeq resets in
// seed() (i.e. on every /reset), so each host's run starts the counter fresh.
const POST_TS_BASE = 1775000000
const BOT_USER_ID = 'UBOT'
let postSeq = 0

interface FixtureUser {
  id: string
  name: string
  real_name: string
  email: string
  is_bot?: boolean
  deleted?: boolean
}
interface FixtureChannel {
  id: string
  name: string
  kind: string
  created: number
  is_archived?: boolean
  is_private?: boolean
}
interface FixtureDm {
  id: string
  user: string
  kind: string
  created: number
}
interface Reaction {
  name: string
  users: string[]
  count: number
}
interface FixtureMessage {
  channel: string
  ts: string
  user: string
  text: string
  thread_ts?: string
  reactions?: Reaction[]
}
interface FixtureFile {
  id: string
  channel: string
  message_ts: string
  name: string
  title: string
  mimetype: string
  filetype: string
  content?: string
  content_path?: string
}
interface Fixture {
  users: FixtureUser[]
  channels: FixtureChannel[]
  dms: FixtureDm[]
  messages: FixtureMessage[]
  files: FixtureFile[]
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
}

// db push materializes schema.prisma into a fresh SQLite file per server
// instance, so every start is clean state (no migration history to carry).
function pushSchema(dbUrl: string): void {
  const prismaBin = createRequire(import.meta.url).resolve('prisma/build/index.js')
  execFileSync('node', [prismaBin, 'db', 'push', '--schema', SCHEMA, '--skip-generate'], {
    env: { ...process.env, SLACK_DB_URL: dbUrl },
    stdio: 'ignore',
  })
}

async function seed(db: PrismaClient, fx: Fixture): Promise<void> {
  postSeq = 0
  await db.slackFile.deleteMany({})
  await db.message.deleteMany({})
  await db.channel.deleteMany({})
  await db.user.deleteMany({})
  for (const u of fx.users) {
    await db.user.create({
      data: {
        id: u.id,
        name: u.name,
        realName: u.real_name,
        email: u.email,
        isBot: u.is_bot ?? false,
        deleted: u.deleted ?? false,
      },
    })
  }
  for (const c of fx.channels) {
    await db.channel.create({
      data: {
        id: c.id,
        name: c.name,
        kind: c.kind,
        created: c.created,
        isArchived: c.is_archived ?? false,
        isPrivate: c.is_private ?? false,
      },
    })
  }
  for (const d of fx.dms) {
    await db.channel.create({
      data: { id: d.id, name: '', kind: d.kind, created: d.created, dmUserId: d.user },
    })
  }
  // createMany keeps re-seeding fast at scale (1000+ messages, re-seeded on
  // every host's /reset). Reactions are stored as a JSON string column and
  // re-materialized by conversations.history.
  await db.message.createMany({
    data: fx.messages.map((m) => ({
      channelId: m.channel,
      ts: m.ts,
      userId: m.user,
      text: m.text,
      threadTs: m.thread_ts ?? null,
      reactionsJson: m.reactions !== undefined ? JSON.stringify(m.reactions) : null,
    })),
  })
  await db.slackFile.createMany({ data: fx.files.map(fileSeed) })
}

// Text attachments carry their bytes inline (content); binary attachments
// (pdf/pptx/xlsx/png) live in fixtures/slack/blobs and are referenced by
// content_path — their bytes are read from disk so size and download are the
// real file, byte-for-byte.
function fileSeed(f: FixtureFile): Record<string, unknown> {
  const timestamp = Math.floor(Number(f.message_ts))
  if (f.content_path !== undefined) {
    const bytes = readFileSync(join(FIXTURE_DIR, f.content_path))
    return {
      id: f.id,
      channelId: f.channel,
      messageTs: f.message_ts,
      name: f.name,
      title: f.title,
      mimetype: f.mimetype,
      filetype: f.filetype,
      size: bytes.length,
      timestamp,
      content: '',
      contentPath: f.content_path,
    }
  }
  const content = f.content ?? ''
  return {
    id: f.id,
    channelId: f.channel,
    messageTs: f.message_ts,
    name: f.name,
    title: f.title,
    mimetype: f.mimetype,
    filetype: f.filetype,
    size: Buffer.byteLength(content, 'utf8'),
    timestamp,
    content,
    contentPath: null,
  }
}

interface ChannelRow {
  id: string
  name: string
  kind: string
  created: number
  isArchived: boolean
  isPrivate: boolean
  dmUserId: string | null
}
interface UserRow {
  id: string
  name: string
  realName: string
  email: string
  isBot: boolean
  deleted: boolean
}
interface FileRow {
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

function userJson(u: UserRow): Record<string, unknown> {
  return {
    id: u.id,
    name: u.name,
    real_name: u.realName,
    is_bot: u.isBot,
    deleted: u.deleted,
    profile: { real_name: u.realName, display_name: u.name, email: u.email },
  }
}

function channelJson(c: ChannelRow): Record<string, unknown> {
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
  }
}

function fileMeta(f: FileRow, host: string): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    title: f.title,
    mimetype: f.mimetype,
    filetype: f.filetype,
    size: f.size,
    timestamp: f.timestamp,
    url_private_download: `http://${host}/files/download/${f.id}`,
  }
}

// Slack search-query DSL (a faithful subset). Unquoted operator tokens are
// stripped and interpreted; a "quoted phrase" is kept verbatim as literal:
//   in:#channel   scope to a channel by name
//   in:@user      scope to a DM by the other member's name
//   from:@user    only messages authored by that user (name resolved to id)
//   after:DATE    strictly after that UTC day (DATE = YYYY-MM-DD)
//   before:DATE   strictly before that UTC day
//   on:DATE       within that UTC day
// Everything else is the literal, matched as an ASCII-case-insensitive
// substring against the stored text/name/title/content — data-driven, so the
// same fake answers any query, not just the fixture's exact wording. Names
// (#channel / @user) are resolved to ids server-side, like real Slack.
interface ParsedQuery {
  literal: string
  channelName?: string
  dmName?: string
  fromName?: string
  after?: string
  before?: string
  on?: string
}

function tokenizeQuery(query: string): { value: string; quoted: boolean }[] {
  const tokens: { value: string; quoted: boolean }[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(query)) !== null) {
    if (m[1] !== undefined) tokens.push({ value: m[1], quoted: true })
    else if (m[2] !== undefined) tokens.push({ value: m[2], quoted: false })
  }
  return tokens
}

function parseQuery(query: string): ParsedQuery {
  const terms: string[] = []
  const out: ParsedQuery = { literal: '' }
  for (const { value, quoted } of tokenizeQuery(query)) {
    if (!quoted) {
      if (value.startsWith('in:#')) {
        out.channelName = value.slice(4)
        continue
      }
      if (value.startsWith('in:@')) {
        out.dmName = value.slice(4)
        continue
      }
      if (value.startsWith('from:@')) {
        out.fromName = value.slice(6)
        continue
      }
      if (value.startsWith('from:')) {
        out.fromName = value.slice(5)
        continue
      }
      if (value.startsWith('after:')) {
        out.after = value.slice(6)
        continue
      }
      if (value.startsWith('before:')) {
        out.before = value.slice(7)
        continue
      }
      if (value.startsWith('on:')) {
        out.on = value.slice(3)
        continue
      }
    }
    terms.push(value)
  }
  out.literal = terms.join(' ')
  return out
}

function dayStartEpoch(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000)
}

function withinDates(tsNum: number, parsed: ParsedQuery): boolean {
  if (parsed.after !== undefined && tsNum < dayStartEpoch(parsed.after) + 86400) return false
  if (parsed.before !== undefined && tsNum >= dayStartEpoch(parsed.before)) return false
  if (parsed.on !== undefined) {
    const start = dayStartEpoch(parsed.on)
    if (tsNum < start || tsNum >= start + 86400) return false
  }
  return true
}

function parseJsonBody(body: string): Record<string, unknown> {
  return body === '' ? {} : (JSON.parse(body) as Record<string, unknown>)
}

function bearer(req: http.IncomingMessage): string {
  const auth = req.headers.authorization ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

type Reply = { status: number; json?: unknown; buffer?: Buffer; contentType?: string }

// Pins live in memory: the CLI facet pins and unpins within one scenario,
// and /reset clears them along with the reseeded rows.
const PINS = new Map<string, Set<string>>()

const CUSTOM_EMOJI: Record<string, string> = {
  shipit: 'https://emoji.example/shipit.png',
  partyparrot: 'alias:parrot',
}

async function handle(
  db: PrismaClient,
  req: http.IncomingMessage,
  url: URL,
  host: string,
  body: string,
): Promise<Reply> {
  const path = url.pathname
  const q = url.searchParams

  if (req.method === 'POST' && path === '/reset') {
    await seed(db, loadFixture())
    PINS.clear()
    return { status: 200, json: { ok: true } }
  }

  if (req.method === 'POST' && path === '/api/chat.postMessage') {
    if (bearer(req) === '') return { status: 200, json: { ok: false, error: 'not_authed' } }
    const payload = parseJsonBody(body)
    const channel = typeof payload.channel === 'string' ? payload.channel : ''
    const text = typeof payload.text === 'string' ? payload.text : ''
    if (channel === '') return { status: 200, json: { ok: false, error: 'channel_not_found' } }
    postSeq += 1
    const ts = `${String(POST_TS_BASE)}.${String(postSeq).padStart(6, '0')}`
    const message: Record<string, unknown> = { type: 'message', user: BOT_USER_ID, text, ts }
    if (typeof payload.thread_ts === 'string' && payload.thread_ts !== '') {
      message.thread_ts = payload.thread_ts
    }
    return { status: 200, json: { ok: true, channel, ts, message } }
  }

  if (req.method === 'POST' && path === '/api/reactions.add') {
    if (bearer(req) === '') return { status: 200, json: { ok: false, error: 'not_authed' } }
    const payload = parseJsonBody(body)
    const channel = typeof payload.channel === 'string' ? payload.channel : ''
    const timestamp = typeof payload.timestamp === 'string' ? payload.timestamp : ''
    const msg = await db.message.findFirst({ where: { channelId: channel, ts: timestamp } })
    if (msg === null) return { status: 200, json: { ok: false, error: 'message_not_found' } }
    return { status: 200, json: { ok: true } }
  }

  if (req.method === 'POST' && (path === '/api/pins.add' || path === '/api/pins.remove')) {
    if (bearer(req) === '') return { status: 200, json: { ok: false, error: 'not_authed' } }
    const payload = parseJsonBody(body)
    const channel = typeof payload.channel === 'string' ? payload.channel : ''
    const timestamp = typeof payload.timestamp === 'string' ? payload.timestamp : ''
    const msg = await db.message.findFirst({ where: { channelId: channel, ts: timestamp } })
    if (msg === null) return { status: 200, json: { ok: false, error: 'message_not_found' } }
    const pinned = PINS.get(channel) ?? new Set<string>()
    if (path === '/api/pins.add') {
      if (pinned.has(timestamp)) return { status: 200, json: { ok: false, error: 'already_pinned' } }
      pinned.add(timestamp)
      PINS.set(channel, pinned)
      return { status: 200, json: { ok: true } }
    }
    if (!pinned.has(timestamp)) return { status: 200, json: { ok: false, error: 'no_pin' } }
    pinned.delete(timestamp)
    return { status: 200, json: { ok: true } }
  }

  if (path === '/api/pins.list') {
    const channel = q.get('channel') ?? ''
    const pinned = [...(PINS.get(channel) ?? new Set<string>())].sort()
    const items = []
    for (const ts of pinned) {
      const m = (await db.message.findFirst({ where: { channelId: channel, ts } })) as {
        ts: string
        userId: string
        text: string
        type: string
      } | null
      if (m === null) continue
      items.push({
        type: 'message',
        channel,
        message: { type: m.type, user: m.userId, text: m.text, ts: m.ts },
      })
    }
    return { status: 200, json: { ok: true, items } }
  }

  if (path === '/api/reactions.get') {
    const channel = q.get('channel') ?? ''
    const timestamp = q.get('timestamp') ?? ''
    const m = (await db.message.findFirst({ where: { channelId: channel, ts: timestamp } })) as {
      ts: string
      userId: string
      text: string
      type: string
      reactionsJson: string | null
    } | null
    if (m === null) return { status: 200, json: { ok: false, error: 'message_not_found' } }
    const message: Record<string, unknown> = {
      type: m.type,
      user: m.userId,
      text: m.text,
      ts: m.ts,
    }
    if (m.reactionsJson !== null && m.reactionsJson !== '') {
      const rs = JSON.parse(m.reactionsJson) as Reaction[]
      message.reactions = rs.map((r) => ({ name: r.name, users: r.users, count: r.count }))
    }
    return { status: 200, json: { ok: true, message, type: 'message', channel } }
  }

  if (path === '/api/emoji.list') {
    return { status: 200, json: { ok: true, emoji: CUSTOM_EMOJI } }
  }

  if (path.startsWith('/files/download/')) {
    const id = path.slice('/files/download/'.length)
    const file = (await db.slackFile.findUnique({ where: { id } })) as FileRow | null
    if (file === null) return { status: 404, json: { error: 'not_found' } }
    if (file.contentPath !== null && file.contentPath !== '') {
      const bytes = readFileSync(join(FIXTURE_DIR, file.contentPath))
      return { status: 200, buffer: bytes, contentType: file.mimetype }
    }
    return { status: 200, buffer: Buffer.from(file.content, 'utf8'), contentType: file.mimetype }
  }

  if (path === '/api/conversations.list') {
    const types = (q.get('types') ?? '').split(',').filter((t) => t !== '')
    const kinds = types.map((t) => (t === 'public_channel' || t === 'private_channel' ? 'channel' : t))
    const where: Record<string, unknown> = { kind: { in: kinds.length > 0 ? kinds : ['channel'] } }
    if (q.get('exclude_archived') === 'true') where.isArchived = false
    const rows = (await db.channel.findMany({ where, orderBy: { id: 'asc' } })) as ChannelRow[]
    return {
      status: 200,
      json: { ok: true, channels: rows.map(channelJson), response_metadata: { next_cursor: '' } },
    }
  }

  if (path === '/api/conversations.history') {
    const channel = q.get('channel') ?? ''
    const oldest = q.get('oldest')
    const latest = q.get('latest')
    const limit = q.get('limit') !== null ? Number.parseInt(q.get('limit') as string, 10) : 100
    const where: Record<string, unknown> = { channelId: channel }
    const ts: Record<string, string> = {}
    if (oldest !== null) ts.gte = oldest
    if (latest !== null) ts.lte = latest
    if (Object.keys(ts).length > 0) where.ts = ts
    // Slack returns most-recent-first; the backend re-sorts the day window.
    const rows = (await db.message.findMany({
      where,
      orderBy: { ts: 'desc' },
      take: limit,
    })) as {
      channelId: string
      ts: string
      userId: string
      text: string
      type: string
      threadTs: string | null
      reactionsJson: string | null
    }[]
    const files = (await db.slackFile.findMany({ where: { channelId: channel } })) as FileRow[]
    // Fixed key order (type, user, text, ts, thread_ts, reactions, files) so
    // the rendered chat.jsonl line is byte-identical on both hosts, which
    // dump the parsed message verbatim.
    const messages = rows.map((m) => {
      const attached = files.filter((f) => f.messageTs === m.ts)
      const base: Record<string, unknown> = { type: m.type, user: m.userId, text: m.text, ts: m.ts }
      if (m.threadTs !== null && m.threadTs !== '') base.thread_ts = m.threadTs
      if (m.reactionsJson !== null && m.reactionsJson !== '') {
        const rs = JSON.parse(m.reactionsJson) as Reaction[]
        base.reactions = rs.map((r) => ({ name: r.name, users: r.users, count: r.count }))
      }
      if (attached.length > 0) base.files = attached.map((f) => fileMeta(f, host))
      return base
    })
    return { status: 200, json: { ok: true, messages, response_metadata: { next_cursor: '' } } }
  }

  if (path === '/api/users.list') {
    const rows = (await db.user.findMany({ orderBy: { id: 'asc' } })) as UserRow[]
    return {
      status: 200,
      json: { ok: true, members: rows.map(userJson), response_metadata: { next_cursor: '' } },
    }
  }

  if (path === '/api/users.info') {
    const user = (await db.user.findUnique({ where: { id: q.get('user') ?? '' } })) as UserRow | null
    if (user === null) return { status: 200, json: { ok: false, error: 'user_not_found' } }
    return { status: 200, json: { ok: true, user: userJson(user) } }
  }

  if (path === '/api/search.messages' || path === '/api/search.files') {
    // search.* requires a user token (xoxp-); a bot token is rejected exactly
    // like real Slack, so the backend falls back to the per-file scan.
    if (!bearer(req).startsWith('xoxp-')) {
      return { status: 200, json: { ok: false, error: 'not_allowed_token_type' } }
    }
    const parsed = parseQuery(q.get('query') ?? '')
    const channels = (await db.channel.findMany({})) as ChannelRow[]
    const users = (await db.user.findMany({})) as UserRow[]
    const userName = new Map(users.map((u) => [u.id, u.name]))
    const byId = new Map(channels.map((c) => [c.id, c]))
    const channelDisplay = (ch: ChannelRow): string =>
      ch.name !== '' ? ch.name : ch.dmUserId !== null ? (userName.get(ch.dmUserId) ?? ch.dmUserId) : ch.id
    let scopedChannelId: string | undefined
    if (parsed.channelName !== undefined) {
      scopedChannelId = channels.find((c) => c.name === parsed.channelName)?.id
    } else if (parsed.dmName !== undefined) {
      const dmUser = (await db.user.findFirst({ where: { name: parsed.dmName } })) as UserRow | null
      if (dmUser !== null) {
        scopedChannelId = channels.find((c) => c.dmUserId === dmUser.id)?.id
      }
    }
    const count = q.get('count') !== null ? Number.parseInt(q.get('count') as string, 10) : 20
    let fromUserId: string | undefined
    let fromMissing = false
    if (parsed.fromName !== undefined) {
      const fromUser = users.find((u) => u.name === parsed.fromName)
      if (fromUser !== undefined) fromUserId = fromUser.id
      else fromMissing = true
    }

    if (path === '/api/search.messages') {
      const where: Record<string, unknown> = { text: { contains: parsed.literal } }
      if (scopedChannelId !== undefined) where.channelId = scopedChannelId
      if (fromUserId !== undefined) where.userId = fromUserId
      const rows = fromMissing
        ? []
        : ((await db.message.findMany({ where, orderBy: { ts: 'asc' } })) as {
            channelId: string
            ts: string
            userId: string
            text: string
          }[])
      const matches = rows
        .filter((m) => withinDates(Number(m.ts), parsed))
        .slice(0, count)
        .map((m) => {
          const ch = byId.get(m.channelId)
          const chName = ch !== undefined ? channelDisplay(ch) : ''
          return {
            type: 'message',
            user: m.userId,
            username: userName.get(m.userId) ?? m.userId,
            ts: m.ts,
            text: m.text,
            channel: { id: m.channelId, name: chName },
          }
        })
      return {
        status: 200,
        json: {
          ok: true,
          query: q.get('query') ?? '',
          messages: {
            total: matches.length,
            pagination: { total_count: matches.length, page: 1, page_count: 1 },
            paging: { count, total: matches.length, page: 1, pages: 1 },
            matches,
          },
        },
      }
    }

    // search.files has no author field in this model, so a from: query can
    // never match a file; return an empty set rather than silently ignoring it.
    const fileWhere: Record<string, unknown> = {
      OR: [
        { name: { contains: parsed.literal } },
        { title: { contains: parsed.literal } },
        { content: { contains: parsed.literal } },
      ],
    }
    if (scopedChannelId !== undefined) fileWhere.channelId = scopedChannelId
    const fileRows =
      parsed.fromName !== undefined
        ? []
        : ((await db.slackFile.findMany({ where: fileWhere, orderBy: { id: 'asc' } })) as FileRow[])
    const matches = fileRows
      .filter((f) => withinDates(f.timestamp, parsed))
      .slice(0, count)
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
      json: {
        ok: true,
        query: q.get('query') ?? '',
        files: {
          total: matches.length,
          pagination: { total_count: matches.length, page: 1, page_count: 1 },
          paging: { count, total: matches.length, page: 1, pages: 1 },
          matches,
        },
      },
    }
  }

  return { status: 404, json: { ok: false, error: 'unknown_method' } }
}

export async function startServer(port: number): Promise<http.Server> {
  const dbUrl = `file:${join(tmpdir(), `mirage-slack-${String(process.pid)}-${String(port)}.db`)}`
  process.env.SLACK_DB_URL = dbUrl
  pushSchema(dbUrl)
  const db = new PrismaClient()
  await seed(db, loadFixture())
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? `127.0.0.1:${String(port)}`
    const url = new URL(req.url ?? '/', `http://${host}`)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      void handle(db, req, url, host, body)
        .then((reply) => {
          if (reply.buffer !== undefined) {
            res.writeHead(reply.status, { 'Content-Type': reply.contentType ?? 'application/octet-stream' })
            res.end(reply.buffer)
            return
          }
          res.writeHead(reply.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(reply.json))
        })
        .catch((err: unknown) => {
          console.error('slack fake: route error', err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'internal_error' }))
        })
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('slack.ts')
if (isMain) {
  const portArg = process.argv.indexOf('--port')
  const port = portArg !== -1 ? Number.parseInt(process.argv[portArg + 1] as string, 10) : DEFAULT_PORT
  void startServer(port).then(() => {
    console.log(`SLACK_URL=http://127.0.0.1:${String(port)}`)
  })
}
