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

import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  fromJsonSchema,
  type JsonSchemaType,
} from '@modelcontextprotocol/server'
import type { FastifyInstance } from 'fastify'
import type { McpDoor } from '../mcp/http.ts'
import { TOOLS } from '../mcp/server.ts'

export interface ToolsRoutesDeps {
  mcp: McpDoor
}

const INPUTS: ReadonlyMap<string, JsonSchemaType> = new Map(
  TOOLS.map((tool) => [tool.name, tool.inputSchema]),
)

interface ToolResponse {
  text: string
  is_error: boolean
}

/**
 * Run one tool for an HTTP caller, as MCP runs it: the body is the
 * tool's input, checked against the same schema MCP checks it against,
 * and the call goes to the table the MCP endpoint serves the session
 * with, so a read over HTTP stamps the file for an edit over MCP and
 * back. Answers the status and body to send.
 */
async function callTool(
  mcp: McpDoor,
  workspaceId: string,
  name: string,
  input: JsonSchemaType,
  args: unknown,
  sessionId: string | null,
  account: string | null,
): Promise<{ status: number; body: ToolResponse | { detail: string } }> {
  const checked = await fromJsonSchema(input)['~standard'].validate(args)
  if (checked.issues !== undefined) {
    const why = checked.issues.map((issue) => issue.message).join('; ')
    return { status: 400, body: { detail: `Invalid arguments for tool ${name}: ${why}` } }
  }
  const tools = await mcp.tools(workspaceId, sessionId, account)
  if (typeof tools === 'string') return { status: 404, body: { detail: tools } }
  if (!(await tools.offered()).includes(name)) {
    return { status: 404, body: { detail: `Tool ${name} not found` } }
  }
  try {
    const result = await tools.call(name, args as Record<string, unknown>)
    return {
      status: 200,
      body: { text: result.content[0]?.text ?? '', is_error: result.isError === true },
    }
  } catch (err) {
    return {
      status: 200,
      body: { text: err instanceof Error ? err.message : String(err), is_error: true },
    }
  }
}

/**
 * Serve each tool at `POST /v1/workspaces/:wsId/tools/<tool>`, with the
 * MCP route's body limit, so an input MCP takes is one these take.
 */
export function registerToolsRoutes(app: FastifyInstance, deps: ToolsRoutesDeps): void {
  for (const [name, input] of INPUTS) {
    app.post<{ Params: { wsId: string }; Querystring: { session_id?: string } }>(
      `/v1/workspaces/:wsId/tools/${name}`,
      { bodyLimit: DEFAULT_MAX_REQUEST_BODY_SIZE },
      async (req, reply) => {
        const { status, body } = await callTool(
          deps.mcp,
          req.params.wsId,
          name,
          input,
          req.body,
          req.query.session_id ?? null,
          req.account,
        )
        return reply.status(status).send(body)
      },
    )
  }
}
