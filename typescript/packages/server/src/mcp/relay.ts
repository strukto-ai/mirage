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

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { VERSION } from '@struktoai/mirage-core/version'

/**
 * Answers MCP over one stream by asking the daemon's HTTP endpoint.
 *
 * Every way into mirage's MCP tools ends at the daemon's
 * `/v1/workspaces/:workspaceId/mcp`: the stdio CLI and the SSH subsystem
 * only carry messages to it, so auth, sessions, jobs and history are
 * decided in one place. The endpoint's protocol errors come back as this
 * server's.
 */
export class McpRelay {
  readonly server: McpServer

  constructor(
    private readonly upstream: Client,
    private readonly sessionId?: string,
  ) {
    this.server = new McpServer({ name: 'mirage', version: VERSION })
    const inner = this.server.server
    inner.registerCapabilities({ tools: {} })
    inner.setRequestHandler('tools/list', async (request) => {
      const result = await this.upstream.listTools(request.params)
      if (this.sessionId !== undefined) {
        result.tools = result.tools
          .filter((tool) => tool.name !== 'session')
          .map((tool) => ({
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: Object.fromEntries(
                Object.entries(tool.inputSchema.properties ?? {}).filter(
                  ([key]) => key !== 'session_id',
                ),
              ),
            },
          }))
      }
      return result
    })
    inner.setRequestHandler('tools/call', (request) => {
      if (
        this.sessionId !== undefined &&
        (request.params.name === 'session' || 'session_id' in (request.params.arguments ?? {}))
      ) {
        return Promise.resolve({
          content: [{ type: 'text' as const, text: 'SSH MCP is bound to its login session' }],
          isError: true,
        })
      }
      return this.upstream.callTool(request.params)
    })
  }
}

/**
 * Relay this process's stdio to a daemon's MCP endpoint, until stdin
 * ends.
 */
export async function relayStdio(url: string, headers: Record<string, string>): Promise<void> {
  const upstream = new Client({ name: 'mirage', version: VERSION })
  await upstream.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
  )
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
