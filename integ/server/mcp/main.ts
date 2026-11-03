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

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'

// A stateless streamable-HTTP MCP server for the `mcp` CLI cases. Every
// request is its own session, so both hosts share one instance. It takes
// the token as a bearer or as `X-Api-Key`, the two auth types.

const TOKEN = 'integ-token'
const PAGE = 2

const TOOLS: Tool[] = [
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
  { name: 'echo_args', description: 'Echo the arguments back.', inputSchema: { type: 'object' } },
  {
    name: 'repeat_x',
    description: 'Answer with x repeated count times.',
    inputSchema: { type: 'object', properties: { count: { type: 'integer' } } },
  },
]

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], isError }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

function mcpServer(): Server {
  const server = new Server(
    { name: 'integ-items', title: 'Integ Items', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const start = Number(request.params?.cursor ?? 0)
    const end = start + PAGE
    return {
      tools: TOOLS.slice(start, end),
      ...(end < TOOLS.length ? { nextCursor: String(end) } : {}),
    }
  })
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const args = request.params.arguments ?? {}
    switch (request.params.name) {
      case 'list_items':
        return text('apple\nbanana')
      case 'add_item':
        return text(`added ${String(args.name)}`)
      case 'fail_always':
        return text('boom', true)
      case 'repeat_x':
        return text('x'.repeat(Number(args.count)))
      default:
        return text(JSON.stringify(sorted(args)))
    }
  })
  return server
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.headers.authorization !== `Bearer ${TOKEN}` && req.headers['x-api-key'] !== TOKEN) {
    res.writeHead(401).end('denied')
    return
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0])
  const server = mcpServer()
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport as Parameters<typeof server.connect>[0])
  await transport.handleRequest(req, res, req.method === 'POST' ? await body(req) : undefined)
}

const flag = process.argv.indexOf('--port')
const port = flag === -1 ? 0 : Number(process.argv[flag + 1])
const http = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    console.error(error)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})
http.listen(port, '127.0.0.1', () => {
  const address = http.address()
  const bound = typeof address === 'object' && address !== null ? address.port : port
  console.log(`MCP_URL=http://127.0.0.1:${bound}/mcp`)
})
