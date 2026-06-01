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

export interface ToolContext {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
}

export type WsResolver = (ctx: ToolContext) => Workspace | Promise<Workspace>
export type WsLike = Workspace | WsResolver

interface ToolDefinition<Args extends z.ZodRawShape = z.ZodRawShape> {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string>
}

function tool<Args extends z.ZodRawShape>(input: ToolDefinition<Args>): ToolDefinition<Args> {
  return input
}

function isResolver(ws: WsLike): ws is WsResolver {
  return typeof ws === 'function'
}

async function resolveWs(ws: WsLike, ctx: ToolContext): Promise<Workspace> {
  return isResolver(ws) ? ws(ctx) : ws
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

export function mirageTools(ws: WsLike): Record<string, ToolDefinition> {
  const read = tool({
    description:
      'Read a file. Returns UTF-8 text for source/data files; for binary files returns a metadata stub. Use the bash tool to inspect binaries.',
    args: {
      filePath: z.string().describe('Absolute path of the file to read.'),
    },
    execute: async ({ filePath }, ctx) => {
      const w = await resolveWs(ws, ctx)
      let bytes: Uint8Array
      try {
        bytes = await w.fs.readFile(filePath)
      } catch (err) {
        return `Error: ${errMsg(err)}`
      }
      if (isLikelyText(filePath)) {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      }
      return `Binary file ${filePath} (${String(bytes.length)} bytes). Use the bash tool with head/file/wc/od to inspect.`
    },
  })

  const write = tool({
    description: 'Write content to a file. Creates missing parent directories.',
    args: {
      filePath: z.string().describe('Absolute path of the file to write.'),
      content: z.string().describe('UTF-8 text content to write.'),
    },
    execute: async ({ filePath, content }, ctx) => {
      const w = await resolveWs(ws, ctx)
      await ensureParent(w, filePath)
      await w.fs.writeFile(filePath, content)
      return `Wrote ${String(content.length)} bytes to ${filePath}`
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
    execute: async ({ filePath, oldString, newString, replaceAll }, ctx) => {
      const w = await resolveWs(ws, ctx)
      let current: string
      try {
        current = await w.fs.readFileText(filePath)
      } catch {
        return `Error: file '${filePath}' not found`
      }
      const count = current.split(oldString).length - 1
      if (count === 0) {
        return `Error: string not found in file: '${oldString}'`
      }
      if (count > 1 && replaceAll !== true) {
        return `Error: string '${oldString}' appears ${String(count)} times. Use replaceAll=true`
      }
      const next =
        replaceAll === true
          ? current.split(oldString).join(newString)
          : current.replace(oldString, newString)
      await w.fs.writeFile(filePath, next)
      const occurrences = replaceAll === true ? count : 1
      return `Edited ${filePath} (${String(occurrences)} occurrence${occurrences === 1 ? '' : 's'})`
    },
  })

  const ls = tool({
    description: 'List entries of a directory.',
    args: {
      path: z.string().describe('Absolute directory path.'),
    },
    execute: async ({ path }, ctx) => {
      const w = await resolveWs(ws, ctx)
      let entries: string[]
      try {
        entries = await w.fs.readdir(path)
      } catch (err) {
        return `Error: ${errMsg(err)}`
      }
      const lines: string[] = []
      for (const entry of entries) {
        const isDir = await w.fs.isDir(entry)
        lines.push(isDir ? `${entry}/` : entry)
      }
      return lines.join('\n')
    },
  })

  const bash = tool({
    description: 'Execute a shell command and return stdout, stderr, and exit code.',
    args: {
      command: z.string().describe('The shell command to execute.'),
    },
    execute: async ({ command }, ctx) => {
      const w = await resolveWs(ws, ctx)
      const io = await w.execute(command)
      const parts: string[] = []
      if (io.stdoutText.length > 0) parts.push(io.stdoutText)
      if (io.stderrText.length > 0) parts.push(io.stderrText)
      return parts.join('\n').trim()
    },
  })

  const glob = tool({
    description: 'Find files matching a name pattern.',
    args: {
      pattern: z.string().describe('Filename pattern (e.g. "*.ts").'),
      path: z.string().optional().describe('Directory to search under. Defaults to /.'),
    },
    execute: async ({ pattern, path }, ctx) => {
      const w = await resolveWs(ws, ctx)
      const root = path ?? '/'
      const io = await w.execute(`find ${root} -name '${pattern.replace(/'/g, "'\\''")}'`)
      return io.stdoutText.trim()
    },
  })

  const grep = tool({
    description: 'Search for a regex pattern in files.',
    args: {
      pattern: z.string().describe('Pattern to search for.'),
      path: z.string().optional().describe('Directory or file to search under. Defaults to /.'),
    },
    execute: async ({ pattern, path }, ctx) => {
      const w = await resolveWs(ws, ctx)
      const root = path ?? '/'
      const escaped = pattern.replace(/'/g, "'\\''")
      const io = await w.execute(`grep -rn '${escaped}' ${root}`)
      return io.stdoutText.trim()
    },
  })

  return { read, write, edit, ls, bash, glob, grep }
}

interface Hooks {
  tool?: Record<string, ToolDefinition>
}

type PluginFn = (input: unknown) => Promise<Hooks>

export function miragePlugin(ws: WsLike): PluginFn {
  return () => Promise.resolve({ tool: mirageTools(ws) })
}
