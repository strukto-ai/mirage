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

import type { Ops } from '../../ops/ops.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { isEacces } from '../../utils/errors.ts'
import { gnuDirname } from '../../utils/path.ts'
import type { Session, SessionExecuteOptions } from '../workspace/handle.ts'
import type { ExecuteResult } from '../workspace/types.ts'
import { FileVersionTracker, StaleMirageFileError } from './file_version.ts'
import { decode, ioToStr, replaceText } from './io_text.ts'
import { mediaOf, type WorkspaceMediaRead } from './read_file.ts'

export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

/** What an adapter takes to pick a session's tool table. */
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

/**
 * Whether a path a read just failed on is absent, which picks the
 * failure's wording. A probe the workspace refuses means the path is
 * there: a hidden one answers absent, never refused. A probe that fails
 * for any other filesystem reason proves nothing either way. In both
 * cases the read's own error stands rather than the probe's.
 */
async function missing(vfs: Ops, path: string): Promise<boolean> {
  try {
    return !(await vfs.exists(path))
  } catch (err) {
    // An errno-stamped error is the TypeScript shape of Python's OSError;
    // anything else (an unknown session) is not a probe answer.
    if (typeof (err as { code?: unknown } | null)?.code !== 'string') throw err
    // A policy refusal is routine (the policy that refused the read refuses
    // the probe too); any other failure, a backend EACCES included, warns.
    if (!(err instanceof PolicyDenied)) {
      console.warn(`exists probe failed for ${path}: ${String(err)}`)
    }
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The agent tools for one session, independent of any agent framework.
 * `session.tools` is the session's own table. Every guarded table of a
 * session shares the session's read history, so a read through one
 * guards a write through another. Build one directly only to turn the
 * guard off.
 */
export class MirageToolOperations {
  private readonly own: FileVersionTracker | null

  /**
   * @param session The session the tools act as, with its cwd,
   *   environment and mount grants.
   * @param staleWriteProtection False lets an agent overwrite a file that
   *   changed since it read it.
   */
  constructor(
    private readonly session: Session,
    staleWriteProtection = true,
  ) {
    this.own = staleWriteProtection ? null : new FileVersionTracker(session.vfs, false)
  }

  /**
   * The read history this call uses: the session's, which every guarded
   * table of the session shares, or this table's own when the guard is
   * off. A call keeps the one it started with, so a restore during the
   * call cannot mix two histories.
   */
  private versions(): Promise<FileVersionTracker> {
    return this.own !== null ? Promise.resolve(this.own) : this.session.reads()
  }

  private lineOptions(signal: AbortSignal | undefined): SessionExecuteOptions {
    return signal === undefined ? {} : { signal }
  }

  /** Run a line in the session's shell; `signal` aborts it, as in-app. */
  async shell(command: string, signal?: AbortSignal): Promise<ToolResult> {
    return ioResult(await this.session.shell(command, this.lineOptions(signal)))
  }

  async read(path: string, offset = 0, limit = 2000): Promise<ToolResult> {
    const versions = await this.versions()
    let data: Uint8Array
    try {
      data = await versions.read(path)
    } catch (err) {
      return this.readFailure(versions, path, err)
    }
    return this.numbered(versions, path, data, offset, limit)
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
    const versions = await this.versions()
    let data: Uint8Array
    try {
      data = await versions.read(path)
    } catch (err) {
      return this.readFailure(versions, path, err)
    }
    const media = mediaOf(path, data)
    if (media === undefined) return this.numbered(versions, path, data, offset, limit)
    versions.markSeen(path)
    return media
  }

  private async readFailure(
    versions: FileVersionTracker,
    path: string,
    err: unknown,
  ): Promise<ToolResult> {
    if (await missing(versions.vfs, path)) {
      return errorResult(`Error: file '${path}' not found`)
    }
    return errorResult(`Error: ${errorMessage(err)}`)
  }

  private numbered(
    versions: FileVersionTracker,
    path: string,
    data: Uint8Array,
    offset: number,
    limit: number,
  ): ToolResult {
    const text = decode(data)
    const raw = text.length === 0 ? [] : text.split(/(?<=\n)/)
    const lines = raw.length > 0 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw
    if (offset <= 0 && offset + limit >= lines.length) versions.markSeen(path)
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
    const versions = await this.versions()
    let present: boolean
    try {
      present = await versions.vfs.exists(path)
    } catch (err) {
      if (typeof (err as { code?: unknown } | null)?.code !== 'string') throw err
      return errorResult(`Error: ${errorMessage(err)}`)
    }
    if (present && !versions.hasRead(path)) {
      return errorResult(`Error: file '${path}' exists; read all of it before overwriting it`)
    }
    try {
      await ensureParents(versions.vfs, path)
      await versions.write(path, content)
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
    const versions = await this.versions()
    let content: string
    try {
      content = decode(await versions.readForEdit(path))
    } catch (err) {
      if (err instanceof StaleMirageFileError) return errorResult(`Error: ${err.message}`)
      if (await missing(versions.vfs, path)) {
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
      await versions.writeEdit(path, newContent)
    } catch (err) {
      return errorResult(`Error: ${errorMessage(err)}`)
    }
    const occurrences = replaceAll ? count : 1
    return textResult(`Edited: ${path} (${String(occurrences)} occurrence(s))`)
  }

  async ls(path: string, signal?: AbortSignal): Promise<ToolResult> {
    return ioResult(await this.session.shell(`ls ${shQuote(path)}`, this.lineOptions(signal)))
  }

  /**
   * Search recursively for a pattern, as `grep -rn` does. Each option is
   * the GNU grep flag of the same name, and the line runs in the
   * session's shell, so the search is the shell's own: the same policy,
   * push-down and history as typing it. grep exits 1 when nothing
   * matched, an empty answer rather than a failure, so only an exit above
   * 1 (a bad regex, an unreadable path) is a tool error.
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
    signal?: AbortSignal,
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
    const io = await this.session.shell(words.join(' '), this.lineOptions(signal))
    const result = textResult(ioToStr(io))
    if (io.exitCode > 1) result.isError = true
    return result
  }

  /**
   * Find files, not directories, whose path matches a pattern. The
   * pattern is expanded by `Session.glob`, the shell's own resolver:
   * `**` matches any number of directories, and a relative pattern is
   * matched under `path`. A symlink to a file counts; a dangling one does
   * not, nor does a match the workspace refuses to stat, since nothing
   * says what it is. Any other failure propagates rather than pass for a
   * short list.
   */
  async glob(pattern: string, path = '/'): Promise<ToolResult> {
    const full =
      pattern.startsWith('/') || path === ''
        ? pattern
        : path.endsWith('/')
          ? `${path}${pattern}`
          : `${path}/${pattern}`
    let matches: string[]
    try {
      matches = await this.session.glob(full)
    } catch (err) {
      if (!isEacces(err)) throw err
      matches = []
    }
    const files: string[] = []
    for (const match of matches) {
      try {
        if (await this.session.vfs.isFile(match)) files.push(match)
      } catch (err) {
        if (!isEacces(err)) throw err
      }
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
  async call(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    switch (name) {
      case 'shell':
        return this.shell(args.command as string, signal)
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
        return this.ls(args.path as string, signal)
      case 'grep':
        return this.grep(
          args.pattern as string,
          args.path as string,
          {
            ignoreCase: args.ignore_case as boolean | undefined,
            fixedStrings: args.fixed_strings as boolean | undefined,
            include: args.include as string | undefined,
            context: args.context as number | undefined,
            filesWithMatches: args.files_with_matches as boolean | undefined,
            count: args.count as boolean | undefined,
            maxCount: args.max_count as number | undefined,
          },
          signal,
        )
      case 'glob':
        return this.glob(args.pattern as string, (args.path as string | undefined) ?? '/')
      default:
        throw new Error(`unknown tool: ${name}`)
    }
  }
}
