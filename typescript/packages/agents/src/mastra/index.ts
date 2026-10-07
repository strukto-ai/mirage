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

import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { toStandardSchema } from '@mastra/core/schema'
import { createTool } from '@mastra/core/tools'
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
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'

/**
 * Mirage's tool table as Mastra tools: shell, read, write, edit, ls, grep
 * and glob, each with the shared input schema, as far as the session's
 * profile leaves them (`MirageToolOperations.names`), and answering
 * `{ text, isError }` as the MCP tool of the same name does.
 */
export function mirageTools(ws: Workspace, options: MirageToolOperationsOptions = {}) {
  const session = new Session(ws, options.sessionId ?? null)
  const operations =
    options.staleWriteProtection === false
      ? new MirageToolOperations(session, false)
      : session.tools
  const mirageTool = (name: string, description: string, input: object) =>
    createTool({
      id: `mirage-${name}`,
      description,
      inputSchema: toStandardSchema<Record<string, unknown>>(input as never),
      execute: async (args) => {
        const result = await operations.call(name, args)
        return { text: result.content[0]?.text ?? '', isError: result.isError === true }
      },
    })
  const all = {
    shell: mirageTool('shell', SHELL_DESCRIPTION, SHELL_INPUT),
    read: mirageTool('read', READ_DESCRIPTION, READ_INPUT),
    write: mirageTool('write', WRITE_DESCRIPTION, WRITE_INPUT),
    edit: mirageTool('edit', EDIT_DESCRIPTION, EDIT_INPUT),
    ls: mirageTool('ls', LS_DESCRIPTION, LS_INPUT),
    grep: mirageTool('grep', GREP_DESCRIPTION, GREP_INPUT),
    glob: mirageTool('glob', GLOB_DESCRIPTION, GLOB_INPUT),
  }
  const names = operations.names()
  return Object.fromEntries(
    Object.entries(all).filter(([name]) => names.includes(name)),
  ) as Partial<typeof all>
}
