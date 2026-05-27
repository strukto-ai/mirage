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

import type { Workspace } from '@struktoai/mirage-node'
import { z } from 'zod'

interface ToolResult {
  title?: string
  output: string
  metadata?: Record<string, unknown>
}

interface ToolDefinition<Args extends z.ZodRawShape = z.ZodRawShape> {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: unknown): Promise<ToolResult>
}

function tool<Args extends z.ZodRawShape>(input: ToolDefinition<Args>): ToolDefinition<Args> {
  return input
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

async function ensureParent(ws: Workspace, path: string): Promise<void> {
  const parent = parentOf(path)
  if (parent === '/' || parent === '') return
  if (await ws.fs.exists(parent)) return
  await ensureParent(ws, parent)
  try {
    await ws.fs.mkdir(parent)
  } catch (err) {
    if (!(await ws.fs.exists(parent))) throw err
  }
}

const TEXT_EXTS = new Set([
  'txt',
  'md',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'csv',
  'tsv',
  'xml',
  'html',
  'htm',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'sh',
  'bash',
  'zsh',
  'sql',
  'log',
  'env',
  'ini',
  'toml',
  'conf',
  'cfg',
])

function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return ''
  return path.slice(dot + 1).toLowerCase()
}

function isLikelyText(path: string): boolean {
  return TEXT_EXTS.has(extOf(path))
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function mirageTools(ws: Workspace): Record<string, ToolDefinition> {
  const read = tool({
    description:
      'Read a file from the Mirage workspace. Returns UTF-8 text for source/data files; for binary files returns a metadata stub. Use the bash tool to inspect binaries.',
    args: {
      filePath: z.string().describe('Absolute path of the file to read.'),
    },
    execute: async ({ filePath }) => {
      let bytes: Uint8Array
      try {
        bytes = await ws.fs.readFile(filePath)
      } catch (err) {
        return { title: filePath, output: `Error: ${errMsg(err)}` }
      }
      if (isLikelyText(filePath)) {
        return {
          title: filePath,
          output: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
          metadata: { bytes: bytes.length },
        }
      }
      return {
        title: filePath,
        output: `Binary file ${filePath} (${String(bytes.length)} bytes). Use the bash tool with head/file/wc/od to inspect.`,
        metadata: { bytes: bytes.length, binary: true },
      }
    },
  })

  const write = tool({
    description:
      'Write content to a file in the Mirage workspace. Creates missing parent directories.',
    args: {
      filePath: z.string().describe('Absolute path of the file to write.'),
      content: z.string().describe('UTF-8 text content to write.'),
    },
    execute: async ({ filePath, content }) => {
      await ensureParent(ws, filePath)
      await ws.fs.writeFile(filePath, content)
      return {
        title: filePath,
        output: `Wrote ${String(content.length)} bytes to ${filePath}`,
      }
    },
  })

  const edit = tool({
    description:
      'Replace a string inside an existing file. Errors if the string appears more than once unless replaceAll is true.',
    args: {
      filePath: z.string().describe('Absolute path of the file to edit.'),
      oldString: z.string().describe('The exact string to replace.'),
      newString: z.string().describe('The replacement string.'),
      replaceAll: z
        .boolean()
        .optional()
        .describe('Replace every occurrence rather than requiring a unique match.'),
    },
    execute: async ({ filePath, oldString, newString, replaceAll }) => {
      let current: string
      try {
        current = await ws.fs.readFileText(filePath)
      } catch {
        return { title: filePath, output: `Error: file '${filePath}' not found` }
      }
      const count = current.split(oldString).length - 1
      if (count === 0) {
        return { title: filePath, output: `Error: string not found in file: '${oldString}'` }
      }
      if (count > 1 && replaceAll !== true) {
        return {
          title: filePath,
          output: `Error: string '${oldString}' appears ${String(count)} times. Use replaceAll=true`,
        }
      }
      const next =
        replaceAll === true
          ? current.split(oldString).join(newString)
          : current.replace(oldString, newString)
      await ws.fs.writeFile(filePath, next)
      const occurrences = replaceAll === true ? count : 1
      return {
        title: filePath,
        output: `Edited ${filePath} (${String(occurrences)} occurrence${occurrences === 1 ? '' : 's'})`,
        metadata: { occurrences },
      }
    },
  })

  const ls = tool({
    description: 'List entries of a directory in the Mirage workspace.',
    args: {
      path: z.string().describe('Absolute directory path inside the workspace.'),
    },
    execute: async ({ path }) => {
      let entries: string[]
      try {
        entries = await ws.fs.readdir(path)
      } catch (err) {
        return { title: path, output: `Error: ${errMsg(err)}` }
      }
      const lines: string[] = []
      for (const entry of entries) {
        const isDir = await ws.fs.isDir(entry)
        lines.push(isDir ? `${entry}/` : entry)
      }
      return { title: path, output: lines.join('\n') }
    },
  })

  const bash = tool({
    description:
      'Execute a shell command inside the Mirage workspace. Routes through Mirage shell so all mounted resources are reachable as files.',
    args: {
      command: z.string().describe('The shell command to execute.'),
    },
    execute: async ({ command }) => {
      const io = await ws.execute(command)
      const parts: string[] = []
      if (io.stdoutText.length > 0) parts.push(io.stdoutText)
      if (io.stderrText.length > 0) parts.push(io.stderrText)
      return {
        title: command,
        output: parts.join('\n').trim(),
        metadata: { exitCode: io.exitCode },
      }
    },
  })

  const glob = tool({
    description:
      'Find files matching a glob-like pattern under the Mirage workspace. Uses Mirage shell `find` so all mounted resources are searchable.',
    args: {
      pattern: z.string().describe('Filename pattern (e.g. "*.ts").'),
      path: z.string().optional().describe('Directory to search under. Defaults to /.'),
    },
    execute: async ({ pattern, path }) => {
      const root = path ?? '/'
      const io = await ws.execute(`find ${root} -name '${pattern.replace(/'/g, "'\\''")}'`)
      return {
        title: pattern,
        output: io.stdoutText.trim(),
        metadata: { exitCode: io.exitCode },
      }
    },
  })

  const grep = tool({
    description:
      'Search for a regex pattern in files under the Mirage workspace. Uses Mirage shell `grep` so all mounted resources are searchable.',
    args: {
      pattern: z.string().describe('Pattern to search for.'),
      path: z.string().optional().describe('Directory or file to search under. Defaults to /.'),
    },
    execute: async ({ pattern, path }) => {
      const root = path ?? '/'
      const escaped = pattern.replace(/'/g, "'\\''")
      const io = await ws.execute(`grep -rn '${escaped}' ${root}`)
      return {
        title: pattern,
        output: io.stdoutText.trim(),
        metadata: { exitCode: io.exitCode },
      }
    },
  })

  return { read, write, edit, ls, bash, glob, grep }
}

interface Hooks {
  tool?: Record<string, ToolDefinition>
}

type PluginFn = (input: unknown) => Promise<Hooks>

export function miragePlugin(ws: Workspace): PluginFn {
  return () => Promise.resolve({ tool: mirageTools(ws) })
}
