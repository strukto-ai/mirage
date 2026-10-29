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

import { DEFAULT_RUN, DEFAULT_TENANT, RUN_QUERY, TENANT_QUERY } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, Reply } from '../kit/typescript/index.ts'
import { BOT_USER_ID, POST_TS_BASE, type C } from './config.ts'
import { channelById, messageAt, messageKey, pinKey } from './store.ts'
import { argsOf, fail, reactionsOf } from './wire.ts'

function obj(v: JsonValue | undefined): Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}
}

function str(v: JsonValue | undefined): string {
  return typeof v === 'string' ? v : ''
}

// Every write refuses an anonymous caller, which is what the vendor does and
// what makes the mount's token configuration load-bearing.
function authed(ctx: Ctx<C>): boolean {
  const raw = ctx.headers.authorization
  const one = Array.isArray(raw) ? raw[0] : raw
  return one !== undefined && one.startsWith('Bearer ') && one.slice(7) !== ''
}

export async function postMessage(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return fail('not_authed')
  const payload = obj(ctx.json())
  const channel = str(payload.channel)
  const text = str(payload.text)
  if (channel === '') return fail('channel_not_found')
  // The row has to land somewhere real, so an unknown channel is rejected
  // rather than left as an orphan message no listing can reach.
  const row = await channelById(ctx.db, ctx.tenant, channel)
  if (row === null) return fail('channel_not_found')
  if (!row.isMember) return fail('not_in_channel')
  const threadTs = str(payload.thread_ts) === '' ? null : str(payload.thread_ts)
  const ts = await post(ctx, channel, text, threadTs)
  const message: Record<string, JsonValue> = { type: 'message', user: BOT_USER_ID, text, ts }
  if (threadTs !== null) message.thread_ts = threadTs
  return { status: 200, body: { ok: true, channel, ts, message } }
}

// A message from the bot, at the next synthetic ts.
async function post(
  ctx: Ctx<C>,
  channel: string,
  text: string,
  threadTs: string | null,
): Promise<string> {
  const n = ctx.minter.next('post')
  const ts = `${String(POST_TS_BASE)}.${String(n).padStart(6, '0')}`
  await ctx.db.message.create({
    data: {
      tenant: ctx.tenant,
      channelId: channel,
      ts,
      userId: BOT_USER_ID,
      text,
      threadTs,
      reactionsJson: null,
      seq: n,
    },
  })
  return ts
}

export async function reactionsAdd(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return fail('not_authed')
  const payload = obj(ctx.json())
  const channel = str(payload.channel)
  const timestamp = str(payload.timestamp)
  const name = str(payload.name)
  const msg = await messageAt(ctx.db, ctx.tenant, channel, timestamp)
  if (msg === null) return fail('message_not_found')
  const reactions = reactionsOf(msg.reactionsJson)
  const existing = reactions.find((r) => r.name === name)
  if (existing !== undefined && existing.users.includes(BOT_USER_ID)) return fail('already_reacted')
  if (existing === undefined) reactions.push({ name, users: [BOT_USER_ID], count: 1 })
  else {
    existing.users.push(BOT_USER_ID)
    existing.count = existing.users.length
  }
  await ctx.db.message.update({
    where: messageKey(ctx.tenant, channel, timestamp),
    data: { reactionsJson: JSON.stringify(reactions) },
  })
  return { status: 200, body: { ok: true } }
}

export function pins(add: boolean) {
  return async (ctx: Ctx<C>): Promise<Reply> => {
    if (!authed(ctx)) return fail('not_authed')
    const payload = obj(ctx.json())
    const channel = str(payload.channel)
    const timestamp = str(payload.timestamp)
    if ((await messageAt(ctx.db, ctx.tenant, channel, timestamp)) === null) {
      return fail('message_not_found')
    }
    const key = pinKey(ctx.tenant, channel, timestamp)
    const pinned = await ctx.db.pin.findUnique({ where: key })
    if (add) {
      if (pinned !== null) return fail('already_pinned')
      await ctx.db.pin.create({
        data: {
          tenant: ctx.tenant,
          channelId: channel,
          ts: timestamp,
          createdBy: BOT_USER_ID,
          created: Math.floor(Number(timestamp)),
          seq: ctx.minter.next('pin'),
        },
      })
      return { status: 200, body: { ok: true } }
    }
    if (pinned === null) return fail('no_pin')
    await ctx.db.pin.delete({ where: key })
    return { status: 200, body: { ok: true } }
  }
}

// The file types an upload is given by its name; anything else is binary, as
// Slack calls a type it does not recognise.
const UPLOAD_TYPES: Record<string, string> = {
  txt: 'text/plain',
  json: 'application/json',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  png: 'image/png',
}

// The upload URL is presigned: the client sends the bytes to it with no token,
// so the run and the tenant ride in the url, as the discord fake's CDN does.
function uploadUrl(ctx: Ctx<C>, id: string): string {
  const parts: string[] = []
  if (ctx.runPrefix === '' && ctx.run !== DEFAULT_RUN) {
    parts.push(`${RUN_QUERY}=${encodeURIComponent(ctx.run)}`)
  }
  if (ctx.tenant !== DEFAULT_TENANT) {
    parts.push(`${TENANT_QUERY}=${encodeURIComponent(ctx.tenant)}`)
  }
  const query = parts.length === 0 ? '' : `?${parts.join('&')}`
  return `${ctx.url.origin}${ctx.runPrefix}/upload/${id}${query}`
}

// files.getUploadURLExternal: reserve a file id for `filename` of `length`
// bytes and hand back where to send them.
export async function getUploadUrl(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return fail('not_authed')
  const args = argsOf(ctx)
  const name = args.get('filename') ?? ''
  const length = Number.parseInt(args.get('length') ?? '', 10)
  if (name === '' || Number.isNaN(length) || length < 0) return fail('invalid_arguments')
  const n = ctx.minter.next('file')
  const id = `FU${String(n).padStart(6, '0')}`
  await ctx.db.upload.create({ data: { tenant: ctx.tenant, id, name, length, body: null, seq: n } })
  return { status: 200, body: { ok: true, upload_url: uploadUrl(ctx, id), file_id: id } }
}

// The upload URL itself: the raw bytes, answered the way Slack answers them.
export async function receiveUpload(ctx: Ctx<C>): Promise<Reply> {
  const key = { tenant_id: { tenant: ctx.tenant, id: ctx.params.id ?? '' } }
  if ((await ctx.db.upload.findUnique({ where: key })) === null) return { status: 404 }
  await ctx.db.upload.update({ where: key, data: { body: new Uint8Array(ctx.body) } })
  return { status: 200, body: Buffer.from(`OK - ${String(ctx.body.length)}`) }
}

// Slack reads files.completeUploadExternal's arguments from the query
// string, form fields or a JSON body; `files` is a JSON string in the first
// two and an array in the last. null when that string does not parse.
function completeArgs(ctx: Ctx<C>): Record<string, JsonValue> | null {
  const args: Record<string, JsonValue> = Object.fromEntries(argsOf(ctx))
  const raw = ctx.headers['content-type']
  const type = Array.isArray(raw) ? raw[0] : raw
  if (type?.startsWith('application/json') === true) Object.assign(args, obj(ctx.json()))
  if (typeof args.files !== 'string') return args
  try {
    args.files = JSON.parse(args.files) as JsonValue
  } catch {
    return null
  }
  return args
}

// files.completeUploadExternal: share the uploaded files in `channel_id`, as
// one bot message carrying `initial_comment`, in `thread_ts` when given.
// Without a channel the files complete unshared, so nothing lists them.
export async function completeUpload(ctx: Ctx<C>): Promise<Reply> {
  if (!authed(ctx)) return fail('not_authed')
  const args = completeArgs(ctx)
  if (args === null) return fail('invalid_arguments')
  const asked = args.files
  if (!Array.isArray(asked) || asked.length === 0) return fail('invalid_arguments')
  const entries = asked.map(obj)
  const uploads = []
  for (const entry of entries) {
    const row = await ctx.db.upload.findUnique({
      where: { tenant_id: { tenant: ctx.tenant, id: str(entry.id) } },
    })
    if (row === null || row.body === null) return fail('file_not_found')
    uploads.push({ row, title: str(entry.title) === '' ? row.name : str(entry.title) })
  }
  const channel = str(args.channel_id)
  let ts: string | null = null
  if (channel !== '') {
    const target = await channelById(ctx.db, ctx.tenant, channel)
    if (target === null) return fail('channel_not_found')
    if (!target.isMember) return fail('not_in_channel')
    const threadTs = str(args.thread_ts)
    ts = await post(ctx, channel, str(args.initial_comment), threadTs === '' ? null : threadTs)
  }
  for (const { row, title } of uploads) {
    await ctx.db.upload.delete({ where: { tenant_id: { tenant: ctx.tenant, id: row.id } } })
    if (ts === null) continue
    const ext = row.name.includes('.') ? row.name.slice(row.name.lastIndexOf('.') + 1) : ''
    await ctx.db.slackFile.create({
      data: {
        tenant: ctx.tenant,
        id: row.id,
        channelId: channel,
        messageTs: ts,
        name: row.name,
        title,
        mimetype: UPLOAD_TYPES[ext.toLowerCase()] ?? 'application/octet-stream',
        filetype: ext === '' ? 'binary' : ext.toLowerCase(),
        size: row.body?.length ?? 0,
        timestamp: Math.floor(Number(ts)),
        content: '',
        contentPath: null,
        blob: row.body,
        seq: row.seq,
      },
    })
  }
  return {
    status: 200,
    body: { ok: true, files: uploads.map(({ row, title }) => ({ id: row.id, title })) },
  }
}
