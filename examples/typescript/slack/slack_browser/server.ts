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

import { Buffer } from 'node:buffer'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.development' })

const TOKEN = process.env.SLACK_BOT_TOKEN
if (TOKEN === undefined || TOKEN === '') {
  console.error('SLACK_BOT_TOKEN env var is required')
  process.exit(1)
}

const PREFIX = '/api/slack/'
const HOST = '127.0.0.1'
const PORT = 8901
const UPSTREAM_ORIGIN = 'https://slack.com'
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

function isSafeEndpoint(endpoint: string): boolean {
  if (endpoint === '') return false
  return endpoint
    .split('/')
    .every((seg) => seg !== '.' && seg !== '..' && SAFE_SEGMENT.test(seg))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${String(PORT)}`)
  if (!url.pathname.startsWith(PREFIX)) {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'path must start with /api/slack/' }))
    return
  }
  const endpoint = url.pathname.slice(PREFIX.length)
  if (!isSafeEndpoint(endpoint)) {
    res.statusCode = 400
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'invalid slack api endpoint' }))
    return
  }
  const upstream = new URL(`/api/${endpoint}`, UPSTREAM_ORIGIN)
  upstream.search = url.search

  const method = (req.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN!}`,
  }
  const contentType = req.headers['content-type']
  if (typeof contentType === 'string' && contentType !== '') {
    headers['content-type'] = contentType
  }

  let body: string | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const buf = await readBody(req)
    body = buf.toString('utf-8')
  }

  try {
    const upstreamRes = await fetch(upstream, {
      method,
      headers,
      ...(body !== undefined && body.length > 0 ? { body } : {}),
    })
    const text = await upstreamRes.text()
    res.statusCode = upstreamRes.status
    const upstreamCt = upstreamRes.headers.get('content-type')
    if (upstreamCt !== null) res.setHeader('content-type', upstreamCt)
    res.end(text)
  } catch (err) {
    console.error('upstream fetch error:', err)
    res.statusCode = 502
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'upstream error' }))
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error('proxy handler error:', err)
    if (!res.headersSent) {
      res.statusCode = 500
      res.end()
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`proxy listening on ${HOST}:${String(PORT)}`)
  console.log(`forwarding ${PREFIX}* → https://slack.com/api/*`)
})
