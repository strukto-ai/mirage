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

/**
 * Browser Redis example: mounts redis from @struktoai/mirage-browser, whose
 * store speaks the Upstash REST API over fetch, and shows that what it writes
 * is what the Node mount reads over the redis protocol, byte for byte.
 *
 * Architecture:
 *   - "REST front" (top of file) runs in Node: an HTTP server answering the
 *     Upstash REST shape over the redis at REDIS_URL. That is the role
 *     serverless-redis-http plays in front of a self-hosted redis. Against
 *     Upstash itself none of it is needed: a page points RedisResource at the
 *     database's redis url, exactly as the Node mount is configured
 *     (examples/typescript/browser/redis.html).
 *   - "Browser code" (bottom) uses @struktoai/mirage-browser with nothing but
 *     fetch. That is what a page ships.
 */
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MountMode, RedisResource, Workspace } from '@struktoai/mirage-browser'
import {
  RedisResource as NodeRedisResource,
  Workspace as NodeWorkspace,
} from '@struktoai/mirage-node'
import { createClient, RESP_TYPES } from 'redis'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
const KEY_PREFIX = 'mirage:browser:'

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type Outcome = { result: Json } | { error: string }

// ── REST FRONT ──────────────────────────────────────────────────
// The three request shapes the browser store sends, answered the way Upstash
// answers them: a JSON command array POSTed to the base URL, an array of those
// at /pipeline, and the path form /<command>/<arg>... whose POST body is the
// last argument, which is the one way to carry bytes that are not UTF-8.
// `Upstash-Encoding: base64` base64-encodes every bulk string in the reply.

function encodeReply(reply: unknown, base64: boolean): Json {
  if (reply === null || typeof reply === 'number' || typeof reply === 'string') return reply
  if (Buffer.isBuffer(reply)) return base64 ? reply.toString('base64') : reply.toString('utf8')
  if (Array.isArray(reply)) return reply.map((item: unknown) => encodeReply(item, base64))
  throw new Error(`front: unexpected reply type ${typeof reply}`)
}

function jsonArgs(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('ERR command must be an array')
  return raw.map((item: unknown) => {
    if (typeof item === 'string') return item
    if (typeof item === 'number' || typeof item === 'boolean') return String(item)
    throw new Error('ERR unsupported argument type')
  })
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : 'unknown error'
}

function reply(res: ServerResponse, status: number, payload: Json): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function startRestFront(token: string): Promise<{ url: string; close: () => Promise<void> }> {
  const client = createClient({ url: REDIS_URL, socket: { reconnectStrategy: false } })
  await client.connect()
  // Bulk strings as Buffers, so a value that is not UTF-8 survives the hop.
  // On the options, not through withTypeMapping: sendCommand reads the
  // mapping from the underlying client, not from the proxy that returns.
  const typeMapping = { [RESP_TYPES.BLOB_STRING]: Buffer }

  const run = async (args: (string | Buffer)[], base64: boolean): Promise<Outcome> => {
    try {
      return { result: encodeReply(await client.sendCommand(args, { typeMapping }), base64) }
    } catch (err) {
      return { error: errorText(err) }
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      reply(res, 401, { error: 'WRONGPASS invalid or missing auth token' })
      return
    }
    const base64 = req.headers['upstash-encoding'] === 'base64'
    const body = await readBody(req)
    const segments = new URL(req.url ?? '/', 'http://front').pathname
      .split('/')
      .filter((s) => s !== '')
    if (segments.length === 0) {
      const out = await run(jsonArgs(JSON.parse(body.toString('utf8'))), base64)
      reply(res, 'error' in out ? 400 : 200, out)
      return
    }
    if (segments[0] === 'pipeline') {
      const raw: unknown = JSON.parse(body.toString('utf8'))
      if (!Array.isArray(raw)) {
        reply(res, 400, { error: 'ERR pipeline must be an array' })
        return
      }
      const outs: Outcome[] = []
      for (const item of raw) outs.push(await run(jsonArgs(item), base64))
      reply(res, 200, outs)
      return
    }
    const args: (string | Buffer)[] = segments.map((s) => decodeURIComponent(s))
    if (req.method === 'POST' && body.length > 0) args.push(body)
    const out = await run(args, base64)
    reply(res, 'error' in out ? 400 : 200, out)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      reply(res, 400, { error: errorText(err) })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      server.close()
      await once(server, 'close')
      client.destroy()
    },
  }
}

// ── BROWSER CODE ────────────────────────────────────────────────

interface Shell {
  execute: (cmd: string) => Promise<{ stdoutText: string; stderrText: string; exitCode: number }>
}

async function run(ws: Shell, cmd: string): Promise<void> {
  console.log(`$ ${cmd}`)
  const r = await ws.execute(cmd)
  const out = r.stdoutText.replace(/\s+$/, '')
  if (out !== '') console.log(out)
  const err = r.stderrText.replace(/\s+$/, '')
  if (err !== '') console.log(err)
  if (r.exitCode !== 0) console.log(`exit=${String(r.exitCode)}`)
}

async function main(): Promise<void> {
  const token = randomBytes(16).toString('hex')
  const front = await startRestFront(token)

  // maxRequestBytes is lowered from its 8 MiB default only so a small file
  // takes the chunked path: Upstash caps a request at 10 MB, and a file above
  // the cap goes out as one SET followed by APPENDs.
  const browserRedis = new RedisResource({
    url: front.url,
    token,
    keyPrefix: KEY_PREFIX,
    maxRequestBytes: 64,
  })
  await browserRedis.open()
  // Clear any previous state so the demo is reproducible.
  await browserRedis.store.clear()
  await browserRedis.open()
  const ws = new Workspace({ '/data': browserRedis }, { mode: MountMode.WRITE })

  const nodeRedis = new NodeRedisResource({ url: REDIS_URL, keyPrefix: KEY_PREFIX })
  const nodeWs = new NodeWorkspace({ '/data': nodeRedis }, { mode: MountMode.WRITE })

  try {
    console.log('=== browser mount, over REST ===')
    await run(ws, 'mkdir /data/notes')
    await run(ws, 'echo "hello from the browser" | tee /data/notes/hello.txt')
    await run(ws, "printf 'alpha\\nbeta\\ngamma\\n' > /data/notes/words.txt")
    await run(ws, 'ls /data/notes')
    await run(ws, 'cat /data/notes/hello.txt')
    await run(ws, 'grep -n beta /data/notes/words.txt')
    await run(ws, 'find /data -type f')
    await run(ws, 'du -a /data/notes')

    console.log('')
    console.log('=== bytes survive the REST hop ===')
    await run(ws, "printf '\\x00\\xff\\x89' > /data/notes/bytes.bin")
    await run(ws, 'wc -c /data/notes/bytes.bin')
    await run(ws, 'xxd /data/notes/bytes.bin')
    await run(ws, 'touch /data/notes/empty')
    await run(ws, 'wc -c /data/notes/empty')

    console.log('')
    console.log('=== a file above the request cap goes out as SET + APPENDs ===')
    await run(ws, 'seq 1 40 > /data/notes/seq.txt')
    await run(ws, 'wc -c /data/notes/seq.txt')
    await run(ws, 'md5sum /data/notes/seq.txt')

    console.log('')
    console.log('=== attributes persist in the attrs hash ===')
    await run(ws, 'chmod 640 /data/notes/hello.txt')
    await run(ws, "stat -c '%a %s %n' /data/notes/hello.txt")

    console.log('')
    console.log('=== the node mount reads the same keys over the redis protocol ===')
    await run(nodeWs, 'cat /data/notes/hello.txt')
    await run(nodeWs, 'xxd /data/notes/bytes.bin')
    await run(nodeWs, 'md5sum /data/notes/seq.txt')
    await run(nodeWs, "stat -c '%a %s %n' /data/notes/hello.txt")
    await run(nodeWs, 'echo "written by node" | tee /data/notes/from-node.txt')

    console.log('')
    console.log('=== and the browser mount sees what node wrote ===')
    await run(ws, 'cat /data/notes/from-node.txt')
    await run(ws, 'ls /data/notes')

    console.log('')
    console.log('=== cleanup ===')
    await run(ws, 'rm -r /data/notes')
    await run(ws, 'ls /data')
  } finally {
    await ws.close()
    await nodeWs.close()
    await front.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
