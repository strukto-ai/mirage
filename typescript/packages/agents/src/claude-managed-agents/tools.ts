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

import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError'
import {
  MirageToolOperations,
  type MirageToolOperationsOptions,
  type ToolResult,
} from '@struktoai/mirage-core/workspace/tools/tool_operations'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'

function answer(result: ToolResult): string {
  const text = result.content.map((c) => c.text).join('')
  if (result.isError === true) throw new ToolError(text)
  return text
}

/**
 * The agent toolset's file and shell tools, run in a Mirage session, for a
 * self-hosted environment's `new EnvironmentWorker({ tools })`: `bash`,
 * `read`, `write`, `edit`, `glob` and `grep` answer the agent's calls
 * through the session's own tools, so its profile, mounts and policies
 * apply. A tool every call of which the profile would refuse is left out. A
 * relative path resolves against the session's working directory, as
 * `bash` sees it.
 */
export function mirageTools(
  workspace: Workspace,
  options: MirageToolOperationsOptions = {},
): BetaRunnableTool[] {
  const session = new Session(workspace, options.sessionId ?? null)
  const ops =
    options.staleWriteProtection === false
      ? new MirageToolOperations(session, false)
      : session.tools
  const tools: [string, BetaRunnableTool][] = [
    [
      'shell',
      betaTool({
        name: 'bash',
        description: 'Run a command in the Mirage session.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            restart: { type: 'boolean' },
            timeout_ms: { type: 'integer' },
          },
        },
        run: async ({ command, restart, timeout_ms }) => {
          if (restart === true) return 'bash session restarted'
          if (command === undefined || command === '') {
            throw new ToolError('bash: command is required')
          }
          const signal = timeout_ms === undefined ? undefined : AbortSignal.timeout(timeout_ms)
          const timedOut = new ToolError(`bash: timed out after ${String(timeout_ms)} ms`)
          let result: ToolResult
          try {
            result = await ops.call('shell', { command }, signal)
          } catch (err) {
            if (signal?.aborted === true) throw timedOut
            throw err
          }
          if (signal?.aborted === true) throw timedOut
          return answer(result)
        },
      }),
    ],
    [
      'read',
      betaTool({
        name: 'read',
        description: 'Read a file in the Mirage session.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            view_range: { type: 'array', items: { type: 'integer' } },
          },
          required: ['file_path'],
        },
        run: async ({ file_path, view_range }) => {
          const args: Record<string, string | number> = { path: file_path }
          if (view_range !== undefined && view_range.length > 0) {
            const [first, last] = view_range
            if (view_range.length !== 2 || first === undefined || last === undefined) {
              throw new ToolError('read: view_range must be [start_line, end_line]')
            }
            const start = Math.max(0, first - 1)
            args.offset = start
            if (last > 0) args.limit = Math.max(1, last - start)
          }
          return answer(await ops.call('read', args))
        },
      }),
    ],
    [
      'write',
      betaTool({
        name: 'write',
        description: 'Write a file in the Mirage session.',
        inputSchema: {
          type: 'object',
          properties: { file_path: { type: 'string' }, content: { type: 'string' } },
          required: ['file_path', 'content'],
        },
        run: async ({ file_path, content }) =>
          answer(await ops.call('write', { path: file_path, content })),
      }),
    ],
    [
      'edit',
      betaTool({
        name: 'edit',
        description: 'Replace text in a file in the Mirage session.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
        run: async ({ file_path, old_string, new_string, replace_all }) =>
          answer(
            await ops.call('edit', {
              path: file_path,
              old_string,
              new_string,
              replace_all: replace_all === true,
            }),
          ),
      }),
    ],
    [
      'glob',
      betaTool({
        name: 'glob',
        description: 'List files matching a glob pattern in the Mirage session.',
        inputSchema: {
          type: 'object',
          properties: { pattern: { type: 'string' }, path: { type: 'string' } },
          required: ['pattern'],
        },
        run: async ({ pattern, path }) =>
          answer(await ops.call('glob', { pattern, path: path ?? '.' })),
      }),
    ],
    [
      'grep',
      betaTool({
        name: 'grep',
        description: 'Search file contents in the Mirage session.',
        inputSchema: {
          type: 'object',
          properties: { pattern: { type: 'string' }, path: { type: 'string' } },
          required: ['pattern'],
        },
        run: async ({ pattern, path }) =>
          answer(await ops.call('grep', { pattern, path: path ?? '.' })),
      }),
    ],
  ]
  const names = ops.names()
  return tools.filter(([name]) => names.includes(name)).map(([, tool]) => tool)
}
