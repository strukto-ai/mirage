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

import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type Tool,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server'
import { MAX_REPLY } from '../../src/core/mcp/constants.ts'

export const TOKEN = 'fixture-token'
export const API_KEY = 'fixture-key'
export const PAGE = 2
export const TITLE = 'Fixture Tools'

export const TOOLS: Tool[] = [
  {
    name: 'list_items',
    description: 'List the items.\nEvery item, oldest first.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_item',
    description: 'Add an item.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  { name: 'fail_always', description: 'Always fails.', inputSchema: { type: 'object' } },
  { name: 'wait_forever', description: 'Never answers.', inputSchema: { type: 'object' } },
  { name: 'echo_args', description: 'Echo the arguments back.', inputSchema: { type: 'object' } },
]

/** A running fixture server and what it saw. */
export interface FakeMCP {
  url: string
  /** One entry per HTTP request: its method, JSON-RPC method, MCP session id and auth headers. */
  requests: {
    method: string
    rpc: string
    session: string
    authorization: string
    'x-api-key': string
  }[]
  /** Tools whose call began. */
  started: string[]
  /** Tools whose call was abandoned. */
  cancelled: string[]
  /** MCP session ids answered 404 from now on. */
  expired: Set<string>
  /** List the tools over exactly this many pages, empty past the last tool. */
  pages: number | null
  /** Requests are never answered. */
  stalling: boolean
  /** Every request is answered 503. */
  down: boolean
  /** JSON-RPC methods answered with a body past the reply cap, of the content type each maps to. */
  oversized: Record<string, string>
  /** `tools/call` is answered with the text `inflated`, gzip-compressed and labelled with this content encoding. */
  encoding: string | null
  /** Bytes of `_meta` padding in that answer, which no rendering prints. */
  padding: number
  close: () => Promise<void>
}

/** An MCP CLI config that reaches `fake` with its token. */
export function bearerConfig(fake: FakeMCP): {
  url: string
  auth: { type: string; token: string }
} {
  return { url: fake.url, auth: { type: 'bearer', token: TOKEN } }
}

/** How many clients connected: each sends `initialize` once. */
export function opens(fake: FakeMCP): number {
  return fake.requests.filter((r) => r.rpc === 'initialize').length
}

/** Answer 404 to every MCP session seen so far, as a server that restarted or timed them out does. */
export function expire(fake: FakeMCP): void {
  for (const r of fake.requests) if (r.session !== '') fake.expired.add(r.session)
}

function text(
  value: string,
  isError = false,
): { content: { type: 'text'; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: value }], isError }
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(', ')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${sortedJson(v)}`).join(', ')}}`
}

function mcpServer(fake: FakeMCP, tools: Tool[]): McpServer {
  const server = new McpServer({ name: 'fixture', title: TITLE, version: '1.0.0' })
  server.server.registerCapabilities({ tools: {} })
  server.server.setRequestHandler('tools/list', (request) => {
    const cursor = request.params?.cursor
    const start = cursor === undefined ? 0 : Number(cursor)
    if (fake.pages !== null) {
      return {
        tools: tools.slice(start * PAGE, (start + 1) * PAGE),
        ...(start + 1 < fake.pages ? { nextCursor: String(start + 1) } : {}),
      }
    }
    const end = start + PAGE
    return {
      tools: tools.slice(start, end),
      ...(end < tools.length ? { nextCursor: String(end) } : {}),
    }
  })
  server.server.setRequestHandler('tools/call', async (request, ctx) => {
    const name = request.params.name
    const args = request.params.arguments ?? {}
    if (!tools.some((tool) => tool.name === name)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `no tool ${name}`)
    }
    fake.started.push(name)
    if (name === 'list_items') return text('apple\nbanana')
    if (name === 'add_item') return text(`added ${String(args.name)}`)
    if (name === 'fail_always') {
      return args.quiet === true ? { content: [], isError: true } : text('boom', true)
    }
    if (name === 'wait_forever') {
      const signal = ctx.mcpReq.signal
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        signal.addEventListener('abort', () => {
          resolve()
        })
      })
      fake.cancelled.push(name)
      return text('cancelled', true)
    }
    if (typeof args.delay === 'number') {
      await new Promise((resolve) => setTimeout(resolve, args.delay as number))
    }
    return text(sortedJson(args))
  })
  return server
}

/** Answer with a body past the reply cap, in 1 MiB chunks, as one unfinished SSE event for SSE. */
function flood(res: ServerResponse, contentType: string): void {
  res.writeHead(200, { 'content-type': contentType })
  res.write('event: message\ndata: ')
  const chunk = Buffer.alloc(1024 * 1024, 'x')
  let left = Math.floor(MAX_REPLY / chunk.length) + 1
  const more = (): void => {
    while (left > 0) {
      left -= 1
      if (!res.write(chunk)) {
        res.once('drain', more)
        return
      }
    }
    res.end('\n\n')
  }
  more()
}

/**
 * Serve the fixture MCP server over streamable HTTP on a free port.
 *
 * It accepts `Authorization: Bearer fixture-token` or
 * `x-api-key: fixture-key` and answers 401 otherwise. It serves the
 * 2025 handshake with an MCP session per client, as hosted servers do.
 * Mirrors Python's `tests/fixtures/mcp_server.py` with `legacy=True`.
 */
export async function servedMcp(tools: Tool[] = TOOLS): Promise<FakeMCP> {
  const fake: FakeMCP = {
    url: '',
    requests: [],
    started: [],
    cancelled: [],
    expired: new Set(),
    pages: null,
    stalling: false,
    down: false,
    oversized: {},
    encoding: null,
    padding: 0,
    close: () => Promise.resolve(),
  }
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
  const serve = async (request: Request, session: string): Promise<Response> => {
    let transport = sessions.get(session)
    if (transport === undefined) {
      const opened: WebStandardStreamableHTTPServerTransport =
        new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            sessions.set(id, opened)
          },
          onsessionclosed: (id) => {
            sessions.delete(id)
          },
        })
      await mcpServer(fake, tools).connect(opened)
      transport = opened
    }
    return transport.handleRequest(request)
  }
  const http = createServer((req, res) => {
    const header = (name: string): string => {
      const value = req.headers[name]
      return Array.isArray(value) ? value.join(', ') : (value ?? '')
    }
    const session = header('mcp-session-id')
    const entry = {
      method: req.method ?? '',
      rpc: '',
      session,
      authorization: header('authorization'),
      'x-api-key': header('x-api-key'),
    }
    fake.requests.push(entry)
    if (fake.stalling) return
    if (fake.down) {
      res.writeHead(503).end('down')
      return
    }
    if (header('authorization') !== `Bearer ${TOKEN}` && header('x-api-key') !== API_KEY) {
      res.writeHead(401).end('denied')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (chunks.length > 0) {
        const message = JSON.parse(Buffer.concat(chunks).toString()) as { method?: string }
        entry.rpc = message.method ?? ''
      }
      if (fake.expired.has(session)) {
        res.writeHead(404).end('expired')
        return
      }
      const oversized = fake.oversized[entry.rpc]
      if (oversized !== undefined) {
        flood(res, oversized)
        return
      }
      if (fake.encoding !== null && entry.rpc === 'tools/call') {
        const { id } = JSON.parse(Buffer.concat(chunks).toString()) as { id: number }
        const reply = {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: 'inflated' }],
            _meta: { padding: 'x'.repeat(fake.padding) },
          },
        }
        res
          .writeHead(200, { 'content-type': 'application/json', 'content-encoding': fake.encoding })
          .end(gzipSync(JSON.stringify(reply)))
        return
      }
      const gone = new AbortController()
      res.once('close', () => {
        if (!res.writableFinished) gone.abort()
      })
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      const body = chunks.length > 0 ? Buffer.concat(chunks) : null
      const request = new Request(`http://${header('host')}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? null : body,
        signal: gone.signal,
      })
      void (async () => {
        const response = await serve(request, session)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        if (response.body !== null) {
          for await (const chunk of response.body) res.write(chunk)
        }
        res.end()
      })().catch(() => {
        res.destroy()
      })
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  fake.url = `http://127.0.0.1:${String(port)}/mcp`
  fake.close = async () => {
    http.closeAllConnections()
    await new Promise<void>((resolve) =>
      http.close(() => {
        resolve()
      }),
    )
    await Promise.all([...sessions.values()].map((transport) => transport.close()))
  }
  return fake
}
