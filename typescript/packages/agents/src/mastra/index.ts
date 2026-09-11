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

import { gnuDirname } from '@struktoai/mirage-core/utils/path'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

async function ensureParent(ws: Workspace, path: string): Promise<void> {
  const parent = gnuDirname(path)
  if (parent === '/' || parent === '' || parent === '.') return
  if (await ws.fs.exists(parent)) return
  await ensureParent(ws, parent)
  try {
    await ws.fs.mkdir(parent)
  } catch (err) {
    if (!(await ws.fs.exists(parent))) throw err
  }
}

export function mirageTools(ws: Workspace) {
  return {
    execute: createTool({
      id: 'mirage-execute',
      description:
        'Execute a shell command in the Mirage workspace and return stdout, stderr, and exitCode.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute.'),
      }),
      outputSchema: z.object({
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number(),
        // Why the line did not run, null on every ordinary run; the
        // reason a bash-voiced stderr leaves out.
        refusal: z
          .object({
            kind: z.enum(['deny', 'pending', 'failed']),
            reason: z.string(),
            policy: z.string(),
            scope: z.enum(['command', 'operand']),
            askId: z.string().nullable(),
          })
          .nullable(),
      }),
      execute: async (inputData) => {
        const { command } = inputData as { command: string }
        const io = await ws.execute(command)
        return {
          stdout: io.stdoutText,
          stderr: io.stderrText,
          exitCode: io.exitCode,
          refusal: io.refusal,
        }
      },
    }),

    readFile: createTool({
      id: 'mirage-read-file',
      description: 'Read the contents of a file from the Mirage workspace as UTF-8 text.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path inside the workspace.'),
      }),
      outputSchema: z.object({
        content: z.string().optional(),
        error: z.string().optional(),
      }),
      execute: async (inputData) => {
        const { path } = inputData as { path: string }
        try {
          const content = await ws.fs.readFileText(path)
          return { content }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    writeFile: createTool({
      id: 'mirage-write-file',
      description:
        'Write content to a file in the Mirage workspace. Creates missing parent directories.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path inside the workspace.'),
        content: z.string().describe('UTF-8 text content to write.'),
      }),
      outputSchema: z.object({ path: z.string() }),
      execute: async (inputData) => {
        const { path, content } = inputData as { path: string; content: string }
        await ensureParent(ws, path)
        await ws.fs.writeFile(path, content)
        return { path }
      },
    }),

    editFile: createTool({
      id: 'mirage-edit-file',
      description:
        'Replace a string inside an existing file. Errors if the string appears more than once unless replaceAll is true.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path of the file to edit.'),
        oldString: z.string().describe('The exact string to replace.'),
        newString: z.string().describe('The replacement string.'),
        replaceAll: z
          .boolean()
          .optional()
          .describe('Replace every occurrence rather than requiring a unique match.'),
      }),
      outputSchema: z.object({
        path: z.string().optional(),
        occurrences: z.number().optional(),
        error: z.string().optional(),
      }),
      execute: async (inputData) => {
        const { path, oldString, newString, replaceAll } = inputData as {
          path: string
          oldString: string
          newString: string
          replaceAll?: boolean
        }
        let current: string
        try {
          current = await ws.fs.readFileText(path)
        } catch {
          return { error: `Error: file '${path}' not found` }
        }
        const count = current.split(oldString).length - 1
        if (count === 0) {
          return { error: `Error: string not found in file: '${oldString}'` }
        }
        if (count > 1 && replaceAll !== true) {
          return {
            error: `Error: string '${oldString}' appears ${String(count)} times. Use replaceAll=true`,
          }
        }
        const next =
          replaceAll === true
            ? current.split(oldString).join(newString)
            : current.replace(oldString, newString)
        await ws.fs.writeFile(path, next)
        return { path, occurrences: replaceAll === true ? count : 1 }
      },
    }),

    ls: createTool({
      id: 'mirage-ls',
      description: 'List entries of a directory in the Mirage workspace.',
      inputSchema: z.object({
        path: z.string().describe('Absolute directory path inside the workspace.'),
      }),
      outputSchema: z.object({
        files: z.array(z.object({ path: z.string(), is_dir: z.boolean() })).optional(),
        error: z.string().optional(),
      }),
      execute: async (inputData) => {
        const { path } = inputData as { path: string }
        let entries: string[]
        try {
          entries = await ws.fs.readdir(path)
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
        const files: { path: string; is_dir: boolean }[] = []
        for (const entry of entries) {
          const isDir = await ws.fs.isDir(entry)
          files.push({ path: entry, is_dir: isDir })
        }
        return { files }
      },
    }),
  }
}
