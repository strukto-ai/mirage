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
import { HttpError, paramOf } from '../errors.ts'
import type { RouteApp } from '../routes.ts'
import type { McpEndpoint } from '../mcp/http.ts'
import { TOOLS } from '../mcp/server.ts'
import { jsonBody } from './vfs.ts'

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
 * back. A caller that disconnects cancels the call, as an MCP client's
 * cancel does. Mirrors Python's `call_tool`.
 */
async function callTool(
  mcp: McpEndpoint,
  workspaceId: string,
  name: string,
  input: JsonSchemaType,
  args: unknown,
  sessionId: string | null,
  account: string | null,
  signal: AbortSignal,
): Promise<ToolResponse> {
  const arguments_ = jsonBody(args)
  const issue = (await fromJsonSchema(input)['~standard'].validate(arguments_)).issues?.[0]
  if (issue !== undefined) {
    const at = /^data(\/\S+)? /.exec(issue.message)?.[1] ?? ''
    const param = paramOf(
      at
        .split('/')
        .filter((key) => key !== '')
        .map((key) => (/^\d+$/.test(key) ? Number(key) : key)),
    )
    throw new HttpError(
      param === '' ? 'invalid_request' : 'invalid_value',
      `arguments do not fit tool ${name}'s input schema`,
      { param: param === '' ? undefined : param },
    )
  }
  const tools = await mcp.tools(workspaceId, sessionId, account)
  if (typeof tools === 'string') throw new HttpError('not_found', tools)
  if (!(await tools.offered()).includes(name)) {
    throw new HttpError('not_found', `tool ${name} not found`)
  }
  try {
    const result = await tools.call(name, arguments_, signal)
    return { text: result.content[0]?.text ?? '', is_error: result.isError === true }
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), is_error: true }
  }
}

/**
 * Serve each tool at `POST /v1/workspaces/:wsId/tools/<tool>`, with the
 * MCP route's body limit, so an input MCP takes is one these take.
 */
export function registerToolsRoutes(
  app: RouteApp,
  deps: {
    mcp: McpEndpoint
  },
): void {
  for (const [name, input] of INPUTS) {
    app.post<{ Params: { wsId: string }; Querystring: { session_id?: string } }>(
      `/v1/workspaces/:wsId/tools/${name}`,
      { bodyLimit: DEFAULT_MAX_REQUEST_BODY_SIZE },
      async (req) =>
        await callTool(
          deps.mcp,
          req.params.wsId,
          name,
          input,
          req.body,
          req.query.session_id ?? null,
          req.account,
          req.closed,
        ),
    )
  }
}
