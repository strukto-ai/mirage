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
import { fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server'
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
  SESSION_DESCRIPTION,
  SESSION_INPUT,
  SHELL_DESCRIPTION,
  SHELL_INPUT,
  WRITE_DESCRIPTION,
  WRITE_INPUT,
} from '@struktoai/mirage-agents/tool_descriptions'
import {
  MirageToolOperations,
  type MirageToolOperationsOptions,
} from '@struktoai/mirage-agents/tool_operations'

export interface MirageMcpServerOptions extends MirageToolOperationsOptions {
  name?: string
  version?: string
  /**
   * The tool table to serve, built from the workspace and these options
   * when absent. The HTTP door builds a server per request around one
   * table, so the read a request stamps guards the next request's edit.
   */
  operationsFor?: (sessionId: string) => Promise<MirageToolOperations>
  operations?: MirageToolOperations
}

function withSession(schema: { properties: Record<string, unknown> }): JsonSchemaType {
  return {
    ...schema,
    properties: {
      ...schema.properties,
      session_id: {
        type: 'string',
        description: 'Session to use for this call; omit for the connection default.',
      },
    },
  } as JsonSchemaType
}

export function createMirageMcpServer(
  workspace: Workspace,
  options: MirageMcpServerOptions = {},
): McpServer {
  const operations = options.operations ?? new MirageToolOperations(workspace, options)
  const sessions = new Map<string, { createdAt: number; operations: MirageToolOperations }>()
  const call = async (name: string, args: Record<string, unknown>) => {
    let selected = operations
    if (name !== 'session' && typeof args.session_id === 'string') {
      const sid = args.session_id
      if (options.operationsFor !== undefined) selected = await options.operationsFor(sid)
      else if (sid !== (options.sessionId ?? workspace.defaultSessionId)) {
        await workspace.ensureSessionsLoaded()
        const state = workspace.getSession(sid)
        let cached = sessions.get(sid)
        if (cached?.createdAt !== state.createdAt) {
          cached = {
            createdAt: state.createdAt,
            operations: new MirageToolOperations(workspace, { ...options, sessionId: sid }),
          }
          sessions.set(sid, cached)
        }
        selected = cached.operations
      }
      args = { ...args }
      delete args.session_id
    }
    return selected.call(name, args)
  }
  const server = new McpServer({
    name: options.name ?? 'mirage',
    version: options.version ?? VERSION,
  })

  server.registerTool(
    'shell',
    {
      description: SHELL_DESCRIPTION,
      inputSchema: fromJsonSchema<{ command: string }>(withSession(SHELL_INPUT)),
    },
    (args) => call('shell', args),
  )
  server.registerTool(
    'read',
    {
      description: READ_DESCRIPTION,
      inputSchema: fromJsonSchema<{ path: string; offset?: number; limit?: number }>(
        withSession(READ_INPUT),
      ),
      annotations: { readOnlyHint: true },
    },
    (args) => call('read', args),
  )
  server.registerTool(
    'write',
    {
      description: WRITE_DESCRIPTION,
      inputSchema: fromJsonSchema<{ path: string; content: string }>(withSession(WRITE_INPUT)),
    },
    (args) => call('write', args),
  )
  server.registerTool(
    'edit',
    {
      description: EDIT_DESCRIPTION,
      inputSchema: fromJsonSchema<{
        path: string
        old_string: string
        new_string: string
        replace_all?: boolean
      }>(withSession(EDIT_INPUT)),
    },
    (args) => call('edit', args),
  )
  server.registerTool(
    'ls',
    {
      description: LS_DESCRIPTION,
      inputSchema: fromJsonSchema<{ path: string }>(withSession(LS_INPUT)),
      annotations: { readOnlyHint: true },
    },
    (args) => call('ls', args),
  )
  server.registerTool(
    'grep',
    {
      description: GREP_DESCRIPTION,
      inputSchema: fromJsonSchema<{
        pattern: string
        path: string
        ignore_case?: boolean
        fixed_strings?: boolean
        include?: string
        context?: number
        files_with_matches?: boolean
        count?: boolean
        max_count?: number
      }>(withSession(GREP_INPUT)),
      annotations: { readOnlyHint: true },
    },
    (args) => call('grep', args),
  )
  server.registerTool(
    'glob',
    {
      description: GLOB_DESCRIPTION,
      inputSchema: fromJsonSchema<{ pattern: string; path?: string }>(withSession(GLOB_INPUT)),
      annotations: { readOnlyHint: true },
    },
    (args) => call('glob', args),
  )

  server.registerTool(
    'session',
    {
      description: SESSION_DESCRIPTION,
      inputSchema: fromJsonSchema<{ action: string; session_id?: string; profile?: string }>(
        SESSION_INPUT as JsonSchemaType,
      ),
    },
    (args) => call('session', args),
  )
  return server
}
