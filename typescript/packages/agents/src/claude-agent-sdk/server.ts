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
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  MirageToolOperations,
  type MirageToolOperationsOptions,
  type ToolResult,
} from '../tool-operations.ts'
import {
  EDIT_DESCRIPTION,
  EXECUTE_DESCRIPTION,
  GREP_DESCRIPTION,
  LS_DESCRIPTION,
  READ_DESCRIPTION,
  WRITE_DESCRIPTION,
} from './descriptions.ts'

export async function runExecute(ws: Workspace, command: string): Promise<ToolResult> {
  return new MirageToolOperations(ws).execute(command)
}

export async function runRead(
  ws: Workspace,
  path: string,
  offset = 0,
  limit = 2000,
): Promise<ToolResult> {
  return new MirageToolOperations(ws).read(path, offset, limit)
}

export async function runWrite(ws: Workspace, path: string, content: string): Promise<ToolResult> {
  return new MirageToolOperations(ws).write(path, content)
}

export async function runEdit(
  ws: Workspace,
  path: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): Promise<ToolResult> {
  return new MirageToolOperations(ws).edit(path, oldString, newString, replaceAll)
}

export async function runLs(ws: Workspace, path: string): Promise<ToolResult> {
  return new MirageToolOperations(ws).ls(path)
}

export async function runGrep(ws: Workspace, pattern: string, path: string): Promise<ToolResult> {
  return new MirageToolOperations(ws).grep(pattern, path)
}

export function MirageServer(workspace: Workspace, options: MirageToolOperationsOptions = {}) {
  const operations = new MirageToolOperations(workspace, options)
  return createSdkMcpServer({
    name: 'mirage',
    version: VERSION,
    alwaysLoad: true,
    tools: [
      tool('execute_command', EXECUTE_DESCRIPTION, { command: z.string() }, (args) =>
        operations.execute(args.command),
      ),
      tool(
        'read',
        READ_DESCRIPTION,
        { path: z.string(), offset: z.number().optional(), limit: z.number().optional() },
        (args) => operations.read(args.path, args.offset, args.limit),
        { annotations: { readOnlyHint: true } },
      ),
      tool('write', WRITE_DESCRIPTION, { path: z.string(), content: z.string() }, (args) =>
        operations.write(args.path, args.content),
      ),
      tool(
        'edit',
        EDIT_DESCRIPTION,
        {
          path: z.string(),
          old_string: z.string(),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
        },
        (args) => operations.edit(args.path, args.old_string, args.new_string, args.replace_all),
      ),
      tool('ls', LS_DESCRIPTION, { path: z.string() }, (args) => operations.ls(args.path), {
        annotations: { readOnlyHint: true },
      }),
      tool(
        'grep',
        GREP_DESCRIPTION,
        { pattern: z.string(), path: z.string() },
        (args) => operations.grep(args.pattern, args.path),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  })
}
