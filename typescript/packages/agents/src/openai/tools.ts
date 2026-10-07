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
import { tool } from '@openai/agents'
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
 * Mirage's tool table as OpenAI Agents function tools: shell, read, write,
 * edit, ls, grep and glob, each with the shared input schema, as far as the session's
 * profile leaves them (`MirageToolOperations.names`), and answering
 * with the text the MCP tool of the same name answers. `read` also hands an
 * image or a PDF to the model as input it can see. They work with Chat
 * Completions and Responses; with Responses, `shellTool` over
 * `MirageShell` and `applyPatchTool` over `MirageEditor` are the hosted
 * alternative.
 */
export function mirageTools(ws: Workspace, options: MirageToolOperationsOptions = {}) {
  const session = new Session(ws, options.sessionId ?? null)
  const operations =
    options.staleWriteProtection === false
      ? new MirageToolOperations(session, false)
      : session.tools
  const names = operations.names()
  const call = async (name: string, args: unknown): Promise<string> =>
    (await operations.call(name, args as Record<string, unknown>)).content[0]?.text ?? ''
  const mirageTool = (name: string, description: string, input: object) =>
    tool({
      name,
      description,
      parameters: { ...input, additionalProperties: true } as never,
      strict: false,
      execute: (args) => call(name, args),
    })
  return [
    mirageTool('shell', SHELL_DESCRIPTION, SHELL_INPUT),
    tool({
      name: 'read',
      description: `${READ_DESCRIPTION} Images and PDFs come back as input the model can see.`,
      parameters: { ...READ_INPUT, additionalProperties: true } as never,
      strict: false,
      execute: async (args) => {
        const { path, offset, limit } = args as { path: string; offset?: number; limit?: number }
        const out = await operations.readMedia(path, offset, limit)
        if ('content' in out) return out.content[0]?.text ?? ''
        const data = Uint8Array.from(out.data)
        if (out.kind === 'file') {
          return {
            type: 'file' as const,
            file: { data, mediaType: out.mimeType, filename: out.filename },
          }
        }
        return { type: 'image' as const, image: { data, mediaType: out.mimeType } }
      },
    }),
    mirageTool('write', WRITE_DESCRIPTION, WRITE_INPUT),
    mirageTool('edit', EDIT_DESCRIPTION, EDIT_INPUT),
    mirageTool('ls', LS_DESCRIPTION, LS_INPUT),
    mirageTool('grep', GREP_DESCRIPTION, GREP_INPUT),
    mirageTool('glob', GLOB_DESCRIPTION, GLOB_INPUT),
  ].filter((entry) => names.includes(entry.name))
}
