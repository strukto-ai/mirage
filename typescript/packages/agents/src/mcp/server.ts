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

import type { Workspace } from '@struktoai/mirage-core'
import { VERSION } from '@struktoai/mirage-core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  EDIT_DESCRIPTION,
  EXECUTE_DESCRIPTION,
  GREP_DESCRIPTION,
  LS_DESCRIPTION,
  READ_DESCRIPTION,
  WRITE_DESCRIPTION,
} from '../tool-descriptions.ts'
import { MirageToolOperations, type MirageToolOperationsOptions } from '../tool-operations.ts'

export interface MirageMcpServerOptions extends MirageToolOperationsOptions {
  name?: string
  version?: string
}

export function createMirageMcpServer(
  workspace: Workspace,
  options: MirageMcpServerOptions = {},
): McpServer {
  const operations = new MirageToolOperations(workspace, options)
  const server = new McpServer({
    name: options.name ?? 'mirage',
    version: options.version ?? VERSION,
  })

  server.registerTool(
    'execute_command',
    { description: EXECUTE_DESCRIPTION, inputSchema: { command: z.string() } },
    (args) => operations.execute(args.command),
  )
  server.registerTool(
    'read',
    {
      description: READ_DESCRIPTION,
      inputSchema: {
        path: z.string(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => operations.read(args.path, args.offset, args.limit),
  )
  server.registerTool(
    'write',
    { description: WRITE_DESCRIPTION, inputSchema: { path: z.string(), content: z.string() } },
    (args) => operations.write(args.path, args.content),
  )
  server.registerTool(
    'edit',
    {
      description: EDIT_DESCRIPTION,
      inputSchema: {
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      },
    },
    (args) => operations.edit(args.path, args.old_string, args.new_string, args.replace_all),
  )
  server.registerTool(
    'ls',
    {
      description: LS_DESCRIPTION,
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true },
    },
    (args) => operations.ls(args.path),
  )
  server.registerTool(
    'grep',
    {
      description: GREP_DESCRIPTION,
      inputSchema: { pattern: z.string(), path: z.string() },
      annotations: { readOnlyHint: true },
    },
    (args) => operations.grep(args.pattern, args.path),
  )

  return server
}

export async function serveMirageMcp(
  workspace: Workspace,
  options: MirageMcpServerOptions = {},
): Promise<McpServer> {
  const server = createMirageMcpServer(workspace, options)
  await server.connect(new StdioServerTransport())
  return server
}
