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

import type { Ops } from '@struktoai/mirage-core/ops/ops'
import { gnuDirname } from '@struktoai/mirage-core/utils/path'
import type {
  ExecuteOptions,
  ExecuteResult,
  Workspace,
} from '@struktoai/mirage-core/workspace/workspace/workspace'
import { FileVersionTracker, StaleMirageFileError } from './file_version.ts'
import { decode, ioToStr, replaceText } from './io_text.ts'
import { mediaOf, type WorkspaceMediaRead } from './read_file.ts'

export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export interface MirageToolOperationsOptions {
  staleWriteProtection?: boolean
  /**
   * The session the tools act as, with its cwd, environment and mount
   * grants; the workspace's default session when absent.
   */
  sessionId?: string
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function ioResult(io: ExecuteResult): ToolResult {
  const result = textResult(ioToStr(io))
  if (io.exitCode !== 0) result.isError = true
  return result
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function ensureParents(vfs: Ops, path: string): Promise<void> {
  const parent = gnuDirname(path)
  if (parent === '/' || parent === '' || parent === '.') return
  if (await vfs.exists(parent)) return
  await ensureParents(vfs, parent)
  try {
    await vfs.mkdir(parent)
  } catch (err) {
    if (!(await vfs.exists(parent))) throw err
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MirageToolOperations {
  private readonly versions: FileVersionTracker
  private readonly sessionId: string | undefined
  private readonly shellOptions: ExecuteOptions

  constructor(
    private readonly ws: Workspace,
    options: MirageToolOperationsOptions = {},
  ) {
    this.versions = new FileVersionTracker(
      ws,
      options.staleWriteProtection ?? true,
      options.sessionId,
    )
    this.sessionId = options.sessionId
    this.shellOptions = options.sessionId === undefined ? {} : { sessionId: options.sessionId }
  }

  async shell(command: string): Promise<ToolResult> {
    return ioResult(await this.ws.shell(command, this.shellOptions))
  }

  async read(path: string, offset = 0, limit = 2000): Promise<ToolResult> {
    let data: Uint8Array
    try {
      data = await this.versions.read(path)
    } catch (err) {
      return this.readFailure(path, err)
    }
    return this.numbered(path, data, offset, limit)
  }

  /**
   * Read a file for a door that hands media to the model, in one fetch:
   * an image or a PDF comes back as media and counts as seen in full;
   * anything else is the `read` answer for the same bytes. Either way
   * the file is stamped for a later edit.
   */
  async readMedia(
    path: string,
    offset = 0,
    limit = 2000,
  ): Promise<ToolResult | WorkspaceMediaRead> {
    let data: Uint8Array
    try {
      data = await this.versions.read(path)
    } catch (err) {
      return this.readFailure(path, err)
    }
    const media = mediaOf(path, data)
    if (media === undefined) return this.numbered(path, data, offset, limit)
    this.versions.markSeen(path)
    return media
  }

  private async readFailure(path: string, err: unknown): Promise<ToolResult> {
    if (!(await this.versions.vfs.exists(path))) {
      return errorResult(`Error: file '${path}' not found`)
    }
    return errorResult(`Error: ${errorMessage(err)}`)
  }

  private numbered(path: string, data: Uint8Array, offset: number, limit: number): ToolResult {
    const text = decode(data)
    const raw = text.length === 0 ? [] : text.split(/(?<=\n)/)
    const lines = raw.length > 0 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw
    if (offset <= 0 && offset + limit >= lines.length) this.versions.markSeen(path)
    const sliced = lines.slice(offset, offset + limit)
    const numbered = sliced.map((line, i) => `${String(i + offset + 1).padStart(6)}\t${line}`)
    return textResult(numbered.join(''))
  }

  /**
   * Write a file; an existing one must have been read in full first. A
   * new file is created with its missing parents. An existing one is
   * overwritten only when the agent was shown all of it and it did not
   * change since, so a write never clobbers text the agent has not seen.
   */
  async write(path: string, content: string): Promise<ToolResult> {
    if ((await this.versions.vfs.exists(path)) && !this.versions.hasRead(path)) {
      return errorResult(`Error: file '${path}' exists; read all of it before overwriting it`)
    }
    try {
      await ensureParents(this.versions.vfs, path)
      await this.versions.write(path, content)
    } catch (err) {
      return errorResult(`Error: ${errorMessage(err)}`)
    }
    return textResult(`Written: ${path}`)
  }

  async edit(
    path: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<ToolResult> {
    let content: string
    try {
      content = (await this.versions.readForEdit(path)).toString('utf8')
    } catch (err) {
      if (err instanceof StaleMirageFileError) return errorResult(`Error: ${err.message}`)
      if (!(await this.versions.vfs.exists(path))) {
        return errorResult(`Error: file '${path}' not found`)
      }
      return errorResult(`Error: ${errorMessage(err)}`)
    }
    const [newContent, count] = replaceText(content, oldString, newString, replaceAll)
    if (count === 0) {
      return errorResult(`Error: string not found in file: '${oldString}'`)
    }
    if (count > 1 && !replaceAll) {
      return errorResult(`Error: string appears ${String(count)} times. Pass replace_all=true`)
    }
    try {
      await this.versions.writeEdit(path, newContent)
    } catch (err) {
      return errorResult(`Error: ${errorMessage(err)}`)
    }
    const occurrences = replaceAll ? count : 1
    return textResult(`Edited: ${path} (${String(occurrences)} occurrence(s))`)
  }

  async ls(path: string): Promise<ToolResult> {
    return ioResult(await this.ws.shell(`ls ${shQuote(path)}`, this.shellOptions))
  }

  /**
   * Search recursively for a pattern, as `grep -rn` does. Each option is
   * the GNU grep flag of the same name, and the line runs in the
   * session's shell, so the search is the shell's own: the same policy,
   * push-down and history as typing it.
   */
  async grep(
    pattern: string,
    path: string,
    options: {
      ignoreCase?: boolean | undefined
      fixedStrings?: boolean | undefined
      include?: string | undefined
      context?: number | undefined
      filesWithMatches?: boolean | undefined
      count?: boolean | undefined
      maxCount?: number | undefined
    } = {},
  ): Promise<ToolResult> {
    const words = ['grep', '-rn']
    if (options.ignoreCase === true) words.push('-i')
    if (options.fixedStrings === true) words.push('-F')
    if (options.filesWithMatches === true) words.push('-l')
    if (options.count === true) words.push('-c')
    if (options.maxCount !== undefined) words.push('-m', String(options.maxCount))
    if (options.context !== undefined) words.push('-C', String(options.context))
    if (options.include !== undefined) words.push(shQuote(`--include=${options.include}`))
    words.push('-e', shQuote(pattern), shQuote(path))
    const io = await this.ws.shell(words.join(' '), this.shellOptions)
    // grep exits 1 for "no match", which is a normal empty answer, and
    // >1 for a real failure (bad regex, unreadable path). Only the
    // second is a tool error; reporting the first as one would tell the
    // agent its search broke every time nothing matched.
    const result = textResult(ioToStr(io))
    if (io.exitCode > 1) result.isError = true
    return result
  }

  /**
   * Find files, not directories, whose path matches a pattern. The
   * pattern is expanded by `Workspace.glob`, the shell's own resolver:
   * `**` matches any number of directories, and a relative pattern is
   * matched under `path`. A symlink to a file counts; a dangling one does
   * not.
   */
  async glob(pattern: string, path = '/'): Promise<ToolResult> {
    const full =
      pattern.startsWith('/') || path === ''
        ? pattern
        : path.endsWith('/')
          ? `${path}${pattern}`
          : `${path}/${pattern}`
    const matches = await this.ws.glob(full, this.sessionId)
    const files: string[] = []
    for (const match of matches) {
      if (await this.ws.vfs.isFile(match, this.sessionId)) files.push(match)
    }
    return textResult(files.map((match) => `${match}\n`).join(''))
  }

  /**
   * Run one tool by name with its JSON input. The one entry every door
   * shares: MCP, the HTTP routes, the CLI and the agent adapters hand a
   * tool's name and its input, as the tool's `*_INPUT` schema reads it,
   * to this method, so each tool answers the same way through each of
   * them. Throws for a name no tool has. Mirrors Python's `call`.
   */
  async call(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
    if (name === 'session') {
      await this.ws.ensureSessionsLoaded()
      const action = args.action
      const row = (session: { sessionId: string; profile: string | null; cwd: string }) => ({
        session_id: session.sessionId,
        profile: session.profile,
        cwd: session.cwd,
      })
      if (action === 'list') return textResult(JSON.stringify(this.ws.listSessions().map(row)))
      const sid = args.session_id
      if (typeof sid !== 'string' || sid.length === 0) throw new Error('session_id is required')
      const profile = typeof args.profile === 'string' ? args.profile : undefined
      if (action === 'create') {
        const session = this.ws.createSession(sid, profile === undefined ? {} : { profile })
        await this.ws.flushSessions()
        return textResult(JSON.stringify(row(session)))
      }
      if (action === 'update') {
        if (!('profile' in args)) throw new Error('profile is required for update')
        return textResult(
          JSON.stringify(row(await this.ws.setSessionProfile(sid, profile ?? null))),
        )
      }
      if (action === 'close') {
        this.ws.getSession(sid)
        await this.ws.closeSession(sid)
        return textResult(JSON.stringify({ session_id: sid }))
      }
      throw new Error('unknown session action')
    }
    switch (name) {
      case 'shell':
        return this.shell(args.command as string)
      case 'read':
        return this.read(
          args.path as string,
          (args.offset as number | undefined) ?? 0,
          (args.limit as number | undefined) ?? 2000,
        )
      case 'write':
        return this.write(args.path as string, args.content as string)
      case 'edit':
        return this.edit(
          args.path as string,
          args.old_string as string,
          args.new_string as string,
          (args.replace_all as boolean | undefined) ?? false,
        )
      case 'ls':
        return this.ls(args.path as string)
      case 'grep':
        return this.grep(args.pattern as string, args.path as string, {
          ignoreCase: args.ignore_case as boolean | undefined,
          fixedStrings: args.fixed_strings as boolean | undefined,
          include: args.include as string | undefined,
          context: args.context as number | undefined,
          filesWithMatches: args.files_with_matches as boolean | undefined,
          count: args.count as boolean | undefined,
          maxCount: args.max_count as number | undefined,
        })
      case 'glob':
        return this.glob(args.pattern as string, (args.path as string | undefined) ?? '/')
      default:
        throw new Error(`unknown tool: ${name}`)
    }
  }
}
