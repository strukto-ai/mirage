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

import { encodeBase64, gnuDirname, type Workspace } from '@struktoai/mirage-core'
import { tool } from 'ai'
import { z } from 'zod'
import { readWorkspaceFile } from '../read-file.ts'

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

function bytesToBase64(bytes: Uint8Array): string {
  return encodeBase64(bytes)
}

type ReadFileResult =
  | { kind: 'text'; path: string; mimeType: string; content: string; bytes: number }
  | { kind: 'media'; path: string; mimeType: string; base64: string; bytes: number }
  | { kind: 'binary'; path: string; mimeType: string; bytes: number; note: string }
  | { error: string }

function isError(r: ReadFileResult): r is { error: string } {
  return 'error' in r
}

async function readFileResult(ws: Workspace, path: string): Promise<ReadFileResult> {
  try {
    const result = await readWorkspaceFile(ws, path)
    if (result.kind === 'text') return result
    if (result.kind === 'image' || result.kind === 'file') {
      return {
        kind: 'media',
        path: result.path,
        mimeType: result.mimeType,
        base64: bytesToBase64(result.data),
        bytes: result.bytes,
      }
    }
    return result
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function mirageTools(ws: Workspace) {
  return {
    execute: tool({
      description:
        'Execute a shell command in the Mirage workspace and return stdout, stderr, and exitCode.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute.'),
      }),
      execute: async ({ command }) => {
        const io = await ws.execute(command)
        return {
          stdout: io.stdoutText,
          stderr: io.stderrText,
          exitCode: io.exitCode,
        }
      },
    }),

    readFile: tool({
      description:
        'Read a file from the Mirage workspace. Text files (utf-8 source/data) come back as text; PDFs and images (png/jpeg/gif/webp) come back as base64 media that is forwarded to the model as a multimodal attachment; other binaries return a metadata stub.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path inside the workspace.'),
      }),
      execute: async ({ path }): Promise<ReadFileResult> => readFileResult(ws, path),
      toModelOutput: ({ output }) => {
        const out: ReadFileResult = output
        if (isError(out)) return { type: 'error-text', value: out.error }
        if (out.kind === 'text') return { type: 'text', value: out.content }
        if (out.kind === 'media') {
          return {
            type: 'content',
            value: [
              {
                type: 'text',
                text: `[${out.path}] ${out.mimeType} (${String(out.bytes)} bytes)`,
              },
              { type: 'media', data: out.base64, mediaType: out.mimeType },
            ],
          }
        }
        return { type: 'text', value: out.note }
      },
    }),

    writeFile: tool({
      description:
        'Write content to a file in the Mirage workspace. Creates missing parent directories.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path inside the workspace.'),
        content: z.string().describe('UTF-8 text content to write.'),
      }),
      execute: async ({ path, content }) => {
        await ensureParent(ws, path)
        await ws.fs.writeFile(path, content)
        return { path }
      },
    }),

    editFile: tool({
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
      execute: async ({ path, oldString, newString, replaceAll }) => {
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

    ls: tool({
      description: 'List entries of a directory in the Mirage workspace.',
      inputSchema: z.object({
        path: z.string().describe('Absolute directory path inside the workspace.'),
      }),
      execute: async ({ path }) => {
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
