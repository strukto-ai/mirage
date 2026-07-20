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

import { tool, type Plugin, type ToolContext, type ToolDefinition } from '@opencode-ai/plugin'
import type { Workspace } from '@struktoai/mirage-node'
import { encodeBase64, gnuDirname } from '@struktoai/mirage-core'
import { FileVersionTracker } from '../file-version.ts'
import { readWorkspaceFile } from '../read-file.ts'

const z = tool.schema

export type WsResolver = (ctx: ToolContext) => Workspace | Promise<Workspace>
export type WsLike = Workspace | WsResolver

export interface MirageOpenCodeOptions {
  staleWriteProtection?: boolean
}

type SessionTrackers = Map<string, FileVersionTracker>

function isResolver(ws: WsLike): ws is WsResolver {
  return typeof ws === 'function'
}

async function resolveWs(ws: WsLike, ctx: ToolContext): Promise<Workspace> {
  return isResolver(ws) ? ws(ctx) : ws
}

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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function trackerFor(
  trackers: WeakMap<Workspace, SessionTrackers>,
  ws: Workspace,
  ctx: ToolContext,
  enabled: boolean,
): FileVersionTracker {
  let sessions = trackers.get(ws)
  if (sessions === undefined) {
    sessions = new Map<string, FileVersionTracker>()
    trackers.set(ws, sessions)
  }
  let tracker = sessions.get(ctx.sessionID)
  if (tracker === undefined) {
    tracker = new FileVersionTracker(ws, enabled)
    sessions.set(ctx.sessionID, tracker)
  }
  return tracker
}

export function mirageTools(
  ws: WsLike,
  options: MirageOpenCodeOptions = {},
): Record<string, ToolDefinition> {
  const trackers = new WeakMap<Workspace, SessionTrackers>()
  const staleWriteProtection = options.staleWriteProtection ?? true
  const read = tool({
    description:
      'Read a file. Returns UTF-8 text for source/data files, attaches PDFs and images for multimodal models, and returns metadata for other binary files.',
    args: {
      filePath: z.string().describe('Absolute path of the file to read.'),
    },
    execute: async ({ filePath }, ctx) => {
      const w = await resolveWs(ws, ctx)
      const versions = trackerFor(trackers, w, ctx, staleWriteProtection)
      try {
        const result = await readWorkspaceFile(w, filePath, versions.read.bind(versions))
        if (result.kind === 'text') return result.content
        if (result.kind === 'image' || result.kind === 'file') {
          const filename = result.path.split('/').pop() ?? result.path
          return {
            output: `${result.path} (${result.mimeType}, ${String(result.bytes)} bytes)`,
            attachments: [
              {
                type: 'file' as const,
                mime: result.mimeType,
                url: `data:${result.mimeType};base64,${encodeBase64(result.data)}`,
                filename,
              },
            ],
          }
        }
        return result.note
      } catch (err) {
        return `Error: ${errMsg(err)}`
      }
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
      const versions = trackerFor(trackers, w, ctx, staleWriteProtection)
      try {
        await ensureParent(w, filePath)
        await versions.write(filePath, content)
        return `Wrote ${String(content.length)} bytes to ${filePath}`
      } catch (err) {
        return `Error: ${errMsg(err)}`
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
    execute: async ({ filePath, oldString, newString, replaceAll }, ctx) => {
      const w = await resolveWs(ws, ctx)
      const versions = trackerFor(trackers, w, ctx, staleWriteProtection)
      let current: string
      try {
        current = (await versions.readForEdit(filePath)).toString('utf8')
      } catch (err) {
        if (await w.fs.exists(filePath)) return `Error: ${errMsg(err)}`
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
      try {
        await versions.writeEdit(filePath, next)
      } catch (err) {
        return `Error: ${errMsg(err)}`
      }
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

export function miragePlugin(ws: WsLike, options: MirageOpenCodeOptions = {}): Plugin {
  return () => Promise.resolve({ tool: mirageTools(ws, options) })
}

export { StaleMirageFileError } from '../file-version.ts'
