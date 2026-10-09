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

import { Client, StreamableHTTPClientTransport, type Progress } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { VERSION } from '@struktoai/mirage-core/version'

/**
 * Answers MCP over one stream by asking the daemon's HTTP endpoint.
 *
 * Every way into mirage's MCP tools ends at the daemon's
 * `/v1/workspaces/:workspaceId/mcp`: the stdio CLI only carries messages
 * to it, so auth, sessions, jobs and history are decided in one place. The endpoint's protocol errors come back as this
 * server's, and a client's cancel goes on to the endpoint.
 */
export class McpRelay {
  readonly server: McpServer

  constructor(private readonly upstream: Client) {
    this.server = new McpServer({ name: 'mirage', version: VERSION })
    const inner = this.server.server
    inner.registerCapabilities({ tools: {} })
    inner.setRequestHandler('tools/list', (request) => this.upstream.listTools(request.params))
    inner.setRequestHandler('tools/call', async (request, ctx) => {
      const token = ctx.mcpReq._meta?.progressToken
      if (token === undefined)
        return this.upstream.callTool(request.params, { signal: ctx.mcpReq.signal })
      const controller = new AbortController()
      const cancel = (): void => {
        controller.abort(ctx.mcpReq.signal.reason)
      }
      ctx.mcpReq.signal.addEventListener('abort', cancel, { once: true })
      if (ctx.mcpReq.signal.aborted) cancel()
      let pending: Progress | undefined
      let sending: Promise<void> | undefined
      let failure: { reason: unknown } | undefined
      const flush = async (): Promise<void> => {
        try {
          while (pending !== undefined) {
            const update = pending
            pending = undefined
            await ctx.mcpReq.notify({
              method: 'notifications/progress',
              params: { ...update, progressToken: token },
            })
          }
        } catch (error) {
          failure = { reason: error }
          controller.abort(error)
        } finally {
          sending = undefined
        }
      }
      try {
        const result = await this.upstream.callTool(request.params, {
          signal: controller.signal,
          onprogress: (update) => {
            pending = update
            sending ??= flush()
          },
        })
        await sending
        if (failure !== undefined) throw failure.reason
        return result
      } finally {
        controller.abort()
        ctx.mcpReq.signal.removeEventListener('abort', cancel)
        await sending
      }
    })
  }
}

/**
 * Relay this process's stdio to a daemon's MCP endpoint, until stdin
 * ends. The bearer token is asked for on every request, so a login
 * refreshed while the relay runs is sent; an empty one sends none.
 */
export async function relayStdio(url: string, token: () => Promise<string>): Promise<void> {
  const upstream = new Client({ name: 'mirage', version: VERSION })
  const authProvider = {
    token: async (): Promise<string | undefined> => {
      const bearer = await token()
      return bearer !== '' ? bearer : undefined
    },
  }
  await upstream.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider }))
  try {
    const { server } = new McpRelay(upstream)
    const closed = new Promise<void>((resolve) => {
      server.server.onclose = resolve
    })
    await server.connect(new StdioServerTransport())
    await closed
  } finally {
    await upstream.close()
  }
}
