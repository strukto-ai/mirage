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

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { MountMode, PathSpec, SlackVFS, Workspace } from '@struktoai/mirage-node'
import { SlackEventHook } from '@struktoai/mirage-core/core/slack/events/index'
import type { JsonValue } from '@struktoai/mirage-core/types'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

const MOUNT = '/slack'
const ROOT = new PathSpec({ virtual: MOUNT, directory: MOUNT, vfsPath: '' })
const MAX_AGE = 5 * 60

interface Envelope {
  type?: string
  challenge?: string
  event?: { type?: string } & Record<string, JsonValue>
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} env var is required`)
  }
  return value
}

const token = requiredEnv('SLACK_BOT_TOKEN')
const signingSecret = Buffer.from(requiredEnv('SLACK_SIGNING_SECRET'), 'utf8')
const vfs = new SlackVFS({ token })
const ws = new Workspace({ [MOUNT]: vfs }, { mode: MountMode.READ })
const hook = new SlackEventHook(vfs.accessor)

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** A header's raw bytes when it was sent exactly once, else empty. */
function header(req: IncomingMessage, name: string): Buffer {
  const values = req.headersDistinct[name.toLowerCase()] ?? []
  if (values.length !== 1) return Buffer.alloc(0)
  return Buffer.from(values[0] ?? '', 'latin1')
}

/**
 * Whether a delivery carries a valid, fresh Slack signature.
 *
 * Slack signs `v0:<timestamp>:<raw body>` with the app's signing secret
 * (HMAC-SHA256) and sends `v0=<hex>` as `X-Slack-Signature`. A timestamp
 * more than five minutes from now is refused as a replay.
 */
function signed(req: IncomingMessage, body: Buffer): boolean {
  const timestamp = header(req, 'X-Slack-Request-Timestamp').toString('latin1')
  if (!/^[0-9]+$/.test(timestamp)) return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_AGE) return false
  const base = Buffer.concat([Buffer.from(`v0:${timestamp}:`), body])
  const digest = createHmac('sha256', signingSecret).update(base).digest('hex')
  const expected = Buffer.from(`v0=${digest}`)
  const given = header(req, 'X-Slack-Signature')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * Receive one Slack Events API delivery and refresh the mount.
 *
 * Mirage hosts no server and opens no socket, so this endpoint is
 * yours: Slack posts here, you check its signature over the raw body
 * before anything else, unwrap the envelope, and the hook turns the
 * event into the paths it changed. Everything after `notify` is
 * mirage's: the stale listings are evicted and any live `events`
 * stream is woken.
 */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/slack/events') {
    res.writeHead(404).end()
    return
  }
  const raw = await readBody(req)
  if (!signed(req, raw)) {
    res.writeHead(401, { 'content-type': 'text/plain' }).end('invalid signature')
    return
  }
  const body = JSON.parse(raw.toString('utf-8')) as Envelope
  if (body.type === 'url_verification') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ challenge: body.challenge }))
    return
  }
  const event = body.event ?? {}
  for (const change of await hook.toEvents(ROOT, event.type ?? '', event)) {
    console.log(`  ${change.kind.padEnd(7)} ${change.path.virtual}`)
    await ws.notify(change)
  }
  res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
}

/** Print every change delivered to a subscriber of the mount. */
async function subscriber(): Promise<void> {
  for await (const change of ws.events(`${MOUNT}/channels`)) {
    console.log(`event -> ${change.kind} ${change.path.virtual}`)
  }
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error(err)
      res.writeHead(500).end()
    })
  })
  await new Promise<void>((done) => server.listen(3000, '127.0.0.1', done))

  console.log('POST http://127.0.0.1:3000/slack/events')
  console.log("Expose it through a tunnel, point your Slack app's Event")
  console.log('Subscriptions at the tunnel and subscribe to')
  console.log('message.channels, reaction_added, file_shared, channel_rename.\n')
  console.log("A message maps to that day's transcript, bucketed in UTC:")
  console.log('  /slack/channels/<name>__<CID>/<YYYY-MM-DD>/chat.jsonl')
  console.log("A thread reply maps to the PARENT's day, because chat.jsonl")
  console.log('renders conversations.history and a reply is in no day file.\n')

  const task = subscriber()
  try {
    await new Promise<void>((stop) => {
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
    await ws.close()
    await task
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
