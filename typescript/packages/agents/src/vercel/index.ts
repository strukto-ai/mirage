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

import { encodeBase64 } from '@struktoai/mirage-core/utils/base64'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { jsonSchema, tool, type ToolSet } from 'ai'
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
  type ToolResult,
} from '@struktoai/mirage-core/workspace/tools/tool_operations'
import { Session } from '@struktoai/mirage-core/workspace/workspace/handle'

interface Answer {
  text: string
  isError: boolean
}

type ReadAnswer =
  | Answer
  | { kind: 'media'; path: string; mimeType: string; base64: string; bytes: number }

function answer(result: ToolResult): Answer {
  return { text: result.content[0]?.text ?? '', isError: result.isError === true }
}

/**
 * Mirage's tool table as AI SDK tools: shell, read, write, edit, ls, grep
 * and glob, each with the shared input schema, as far as the session's
 * profile leaves them (`MirageToolOperations.names`), and answering
 * `{ text, isError }` as the MCP tool of the same name does. `read` also
 * hands an image or a PDF to the model as a file, which the AI SDK can
 * carry and the text answer cannot.
 */
export function mirageTools(ws: Workspace, options: MirageToolOperationsOptions = {}): ToolSet {
  const session = new Session(ws, options.sessionId ?? null)
  const operations =
    options.staleWriteProtection === false
      ? new MirageToolOperations(session, false)
      : session.tools
  const mirageTool = (name: string, description: string, input: object) =>
    tool({
      description,
      inputSchema: jsonSchema<Record<string, unknown>>(input as never),
      execute: async (args: Record<string, unknown>) => answer(await operations.call(name, args)),
    })
  const all: ToolSet = {
    shell: mirageTool('shell', SHELL_DESCRIPTION, SHELL_INPUT),
    read: tool({
      description: `${READ_DESCRIPTION} Images and PDFs come back as files the model can see.`,
      inputSchema: jsonSchema<Record<string, unknown>>(READ_INPUT as never),
      execute: async (args: Record<string, unknown>): Promise<ReadAnswer> => {
        const out = await operations.readMedia(
          args.path as string,
          args.offset as number | undefined,
          args.limit as number | undefined,
        )
        if ('content' in out) return answer(out)
        return {
          kind: 'media',
          path: out.path,
          mimeType: out.mimeType,
          base64: encodeBase64(out.data),
          bytes: out.bytes,
        }
      },
      toModelOutput: ({ output }) => {
        const out: ReadAnswer = output
        if ('kind' in out) {
          return {
            type: 'content',
            value: [
              { type: 'text', text: `[${out.path}] ${out.mimeType} (${String(out.bytes)} bytes)` },
              { type: 'file', data: { type: 'data', data: out.base64 }, mediaType: out.mimeType },
            ],
          }
        }
        return out.isError
          ? { type: 'error-text', value: out.text }
          : { type: 'text', value: out.text }
      },
    }),
    write: mirageTool('write', WRITE_DESCRIPTION, WRITE_INPUT),
    edit: mirageTool('edit', EDIT_DESCRIPTION, EDIT_INPUT),
    ls: mirageTool('ls', LS_DESCRIPTION, LS_INPUT),
    grep: mirageTool('grep', GREP_DESCRIPTION, GREP_INPUT),
    glob: mirageTool('glob', GLOB_DESCRIPTION, GLOB_INPUT),
  }
  const names = operations.names()
  return Object.fromEntries(Object.entries(all).filter(([name]) => names.includes(name)))
}
