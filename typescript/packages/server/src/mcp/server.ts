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

import { VERSION } from '@struktoai/mirage-core/version'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import {
  fromJsonSchema,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type JsonSchemaType,
  type ToolAnnotations,
} from '@modelcontextprotocol/server'
import {
  EDIT_DESCRIPTION,
  EDIT_INPUT,
  GLOB_DESCRIPTION,
  GLOB_INPUT,
  GREP_DESCRIPTION,
  GREP_INPUT,
  LS_DESCRIPTION,
  LS_INPUT,
  READ_DESCRIPTION,
  READ_INPUT,
  SHELL_DESCRIPTION,
  SHELL_INPUT,
  WRITE_DESCRIPTION,
  WRITE_INPUT,
} from '@struktoai/mirage-core/workspace/tools/tool_descriptions'
import {
  MirageToolOperations,
  type MirageToolOperationsOptions,
} from '@struktoai/mirage-core/workspace/tools/tool_operations'
import type { ToolResult } from '@struktoai/mirage-core/workspace/tools/tool_operations'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { answered, checked, explanationToDict, failureToDict } from '../io_serde.ts'
import { VFS_CALLS, schemaOf, type VfsCall } from '../vfs_calls.ts'

const READ_ONLY: ToolAnnotations = { readOnlyHint: true }

/** The tools every dispatcher serves, in the order a client lists them. */
export const TOOLS: readonly {
  name: string
  description: string
  inputSchema: JsonSchemaType
  annotations?: ToolAnnotations
}[] = [
  {
    name: 'shell',
    description: SHELL_DESCRIPTION,
    inputSchema: SHELL_INPUT as JsonSchemaType,
  },
  {
    name: 'read',
    description: READ_DESCRIPTION,
    annotations: READ_ONLY,
    inputSchema: READ_INPUT as JsonSchemaType,
  },
  {
    name: 'write',
    description: WRITE_DESCRIPTION,
    inputSchema: WRITE_INPUT as JsonSchemaType,
  },
  {
    name: 'edit',
    description: EDIT_DESCRIPTION,
    inputSchema: EDIT_INPUT as JsonSchemaType,
  },
  {
    name: 'ls',
    description: LS_DESCRIPTION,
    annotations: READ_ONLY,
    inputSchema: LS_INPUT as JsonSchemaType,
  },
  {
    name: 'grep',
    description: GREP_DESCRIPTION,
    annotations: READ_ONLY,
    inputSchema: GREP_INPUT as JsonSchemaType,
  },
  {
    name: 'glob',
    description: GLOB_DESCRIPTION,
    annotations: READ_ONLY,
    inputSchema: GLOB_INPUT as JsonSchemaType,
  },
]

const EXPLAIN = {
  type: 'boolean',
  description: 'Answer what the call would do instead of doing it.',
}

function explainable(schema: object): JsonSchemaType {
  const { properties } = schema as { properties: object }
  return { ...schema, properties: { ...properties, explain: EXPLAIN } } as JsonSchemaType
}

const EXPLAINED_SHELL: (typeof TOOLS)[number] = {
  name: 'shell',
  description: SHELL_DESCRIPTION,
  inputSchema: explainable(SHELL_INPUT),
}

const VFS_TOOLS: ReadonlyMap<string, { tool: (typeof TOOLS)[number]; call: VfsCall }> = new Map(
  VFS_CALLS.map((call) => [
    `vfs_${call.name}`,
    {
      tool: {
        name: `vfs_${call.name}`,
        description: call.description,
        inputSchema: explainable(schemaOf(call)),
      },
      call,
    },
  ]),
)

function json(value: JsonValue, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError } : {}),
  }
}

export interface MirageMcpServerOptions extends MirageToolOperationsOptions {
  name?: string
  version?: string
  /**
   * The tool table to serve; the session's own (`session.tools`) when
   * absent. The HTTP endpoint passes one that runs each call through its API.
   */
  operations?: MirageToolOperations
  /**
   * Also serve each `session.vfs` call as a `vfs_<call>` tool, and take
   * `explain` on `shell` and on each of them, as the HTTP routes do.
   */
  allCalls?: boolean
}

export function createMirageMcpServer(
  workspace: Workspace,
  options: MirageMcpServerOptions = {},
): McpServer {
  const session = new Session(workspace, options.sessionId ?? null)
  const operations =
    options.operations ??
    (options.staleWriteProtection === false
      ? new MirageToolOperations(session, false)
      : session.tools)
  const server = new McpServer({
    name: options.name ?? 'mirage',
    version: options.version ?? VERSION,
  })
  // The session's profile leaves it these tools, read on every request:
  // a stored session loads after the server is built and a profile can
  // change while it serves, so a list fixed at construction would offer
  // what a call refuses and miss what a widened profile allows. A tool
  // the session is not offered is "not found", as Python's server says.
  server.server.registerCapabilities({ tools: { listChanged: true } })
  const listed = async (): Promise<(typeof TOOLS)[number][]> => {
    const names = await operations.offered()
    const tools = TOOLS.filter((tool) => names.includes(tool.name))
    if (options.allCalls !== true) return tools
    return [
      ...tools.map((tool) => (tool.name === 'shell' ? EXPLAINED_SHELL : tool)),
      ...[...VFS_TOOLS.values()].map(({ tool }) => tool),
    ]
  }
  server.server.setRequestHandler('tools/list', async () => ({
    tools: (await listed()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object' },
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    })),
  }))
  server.server.setRequestHandler('tools/call', async (request, ctx) => {
    const name = request.params.name
    const tool = (await listed()).find((candidate) => candidate.name === name)
    if (tool === undefined) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found`)
    }
    const args = request.params.arguments ?? {}
    const valid = await fromJsonSchema(tool.inputSchema)['~standard'].validate(args)
    if (valid.issues !== undefined) {
      const why = valid.issues.map((issue) => issue.message).join('; ')
      const text = `Input validation error: Invalid arguments for tool ${name}: ${why}`
      return { content: [{ type: 'text', text }], isError: true }
    }
    const { explain, ...given } = args
    const vfs = VFS_TOOLS.get(name)
    try {
      if (vfs !== undefined) {
        return json(
          await answered(session, vfs.call, await checked(vfs.call, given), explain === true),
        )
      }
      if (tool === EXPLAINED_SHELL && explain === true) {
        return json(explanationToDict(await session.explain.shell(String(given.command))))
      }
      return await operations.call(name, given, ctx.mcpReq.signal)
    } catch (err) {
      // A call that failed is a tool result the agent reads, not a
      // protocol error.
      if (vfs !== undefined) return json(failureToDict(err), true)
      const text = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text }], isError: true }
    }
  })
  return server
}
