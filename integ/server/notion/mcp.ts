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
import type { Server } from 'node:http'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { DEFAULT_RUN, Router, bindHost, start } from '../kit/typescript/index.ts'
import type { JsonValue, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { DEFAULT_API_VERSION, MAX_PAGE_SIZE } from './config.ts'
import { notionFake } from './fake.ts'
import { databaseRows, filterRefusal, searchResults } from './search.ts'
import { childrenOf } from './store.ts'
import type { DatabaseRow, Json, PageRow } from './types.ts'
import {
  asObject,
  blockJson,
  cursorOf,
  dataSourceJson,
  databaseIdOf,
  databaseJson,
  intOr,
  listTypeOf,
  pageJson,
  pageOf,
} from './wire.ts'
import { deleteBlock } from './writes.ts'

// The tool surface has exactly one mutation, and it takes the same queue every
// REST mutation takes rather than a second rule. An empty Router is the kit's
// queue with no routes attached, which is cheaper than a private copy of the
// same six lines and cannot drift from it.
const queue = new Router<C>([])

// A tool answers with a payload or throws; a refusal the REST arm would send
// as a 400 is thrown in its own words.
function payloadOf(reply: Reply): JsonValue {
  if (reply.status !== 200) throw new Error(`mock notion: ${JSON.stringify(reply.body)}`)
  return reply.body as JsonValue
}

async function toolPayload(db: C, tenant: string, name: string, args: Json): Promise<JsonValue> {
  const ws = tenant
  if (name === 'API-post-search') {
    const results = await searchResults(db, ws, args)
    const size = intOr(args.page_size, MAX_PAGE_SIZE)
    return payloadOf(
      pageOf(results, cursorOf(args.start_cursor), size, listTypeOf(DEFAULT_API_VERSION)),
    )
  }
  if (name === 'API-retrieve-a-page') {
    const id = String(args.page_id)
    const row = (await db.notionPage.findFirst({
      where: { tenant: ws, id },
    })) as PageRow | null
    if (row === null) throw new Error(`mock notion: unknown page ${id}`)
    return pageJson(row)
  }
  if (name === 'API-retrieve-a-database') {
    const id = String(args.database_id)
    const row = (await db.notionDatabase.findFirst({
      where: { tenant: ws, id },
    })) as DatabaseRow | null
    if (row === null) throw new Error(`mock notion: unknown database ${id}`)
    // No version to read: a tool call carries no Notion-Version, and this arm
    // exists to render byte-identically to the REST arm, which mirage's own
    // 2025-09-03 client drives. An external MCP server that pins 2022-06-28
    // reaches the fake over REST and gets that version's shape from there.
    return databaseJson(row)
  }
  if (name === 'API-retrieve-a-data-source') {
    const id = String(args.data_source_id)
    const all = (await db.notionDatabase.findMany({ where: { tenant: ws } })) as DatabaseRow[]
    const owner = databaseIdOf(id, all)
    const row = owner === null ? null : all.find((one) => one.id === owner)
    if (row === undefined || row === null) throw new Error(`mock notion: unknown data source ${id}`)
    return dataSourceJson(row)
  }
  if (name === 'API-post-data-source-query') {
    const all = (await db.notionDatabase.findMany({ where: { tenant: ws } })) as DatabaseRow[]
    const owner = databaseIdOf(String(args.data_source_id), all)
    if (owner === null) throw new Error(`mock notion: unknown data source`)
    const refused = filterRefusal(args.filter)
    if (refused !== null) return payloadOf(refused)
    const rows = await databaseRows(db, ws, owner, args)
    const size = intOr(args.page_size, MAX_PAGE_SIZE)
    return payloadOf(
      pageOf(rows, cursorOf(args.start_cursor), size, listTypeOf(DEFAULT_API_VERSION)),
    )
  }
  if (name === 'API-retrieve-block-children') {
    const rows = await childrenOf(db, ws, String(args.block_id))
    const size = intOr(args.page_size, MAX_PAGE_SIZE)
    return payloadOf(pageOf(rows.map(blockJson), cursorOf(args.start_cursor), size, 'block'))
  }
  // The one delete verb the tool surface has. It mutates, so it takes the same
  // per-workspace queue every REST mutation takes rather than a second rule.
  if (name === 'API-delete-a-block') {
    const id = String(args.block_id)
    const reply = await queue.enqueue(DEFAULT_RUN, () => deleteBlock(db, ws, id))
    if (reply.status !== 200) throw new Error(`mock notion: unknown block ${id}`)
    return reply.body as JsonValue
  }
  throw new Error(`mock notion: unsupported tool ${name}`)
}

function buildMcpServer(db: C, tenant: string): McpServer {
  const server = new McpServer(
    { name: 'mock-notion-mcp', version: '0.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
  server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
    const payload = await toolPayload(
      db,
      tenant,
      req.params.name,
      asObject(req.params.arguments ?? {}),
    )
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  })
  return server
}

// One kit runtime, serving MCP instead of REST. The tenant is the fake's own
// default, which is the token both this and the REST arm authenticate with, so
// a parity run compares two views of ONE seeded workspace.
export async function startMockMcpServer(): Promise<{
  server: Server
  port: number
  close: () => Promise<void>
}> {
  const rest = await start(notionFake, 0)
  const tenant = (notionFake.defaultTenants ?? [])[0] ?? DEFAULT_RUN
  const db = rest.runtime.pool.client(DEFAULT_RUN)
  const server = createServer((req, res) => {
    void (async () => {
      const mcp = buildMcpServer(db, tenant)
      // `sessionIdGenerator: undefined` is the SDK's STATELESS mode, not an
      // omitted option, so the property has to survive the cast. It needs one
      // because this project sets exactOptionalPropertyTypes and the SDK does
      // not; the file this came from was outside tsconfig.check.json, so it
      // never had to say so.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0])
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport as Parameters<typeof mcp.connect>[0])
      await transport.handleRequest(req, res)
    })().catch((err: unknown) => {
      res.writeHead(500)
      res.end(String(err))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, bindHost(), () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      resolve({
        server,
        port: address.port,
        close: async () => {
          // `close` only stops new connections and then WAITS for the open
          // ones, and the MCP client's keep-alive socket is still open by
          // then, so the wait ran to node's 300s `requestTimeout` and every
          // teardown cost five idle minutes. Destroy the sockets too; the
          // callback fires once they are gone.
          await new Promise<void>((ok) => {
            server.close(() => {
              ok()
            })
            server.closeAllConnections()
          })
          await rest.close()
        },
      })
    })
  })
}
