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

import { strongestUnderSession } from '../../context/session_context.ts'
import type { Files } from '../files.ts'
import type { Decisions } from '../../policy/decisions.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { patternMatches } from '../../policy/match/pattern.ts'
import { MOUNT_MODE_RANK, MountMode } from '../../types.ts'
import { isEacces } from '../../errors/fs.ts'
import { pathVisible } from '../../utils/hidden.ts'
import { gnuDirname } from '../../utils/path.ts'
import { commandVisible } from '../lookup/lookup.ts'
import type { MountEntry } from '../mount/mount.ts'
import { DEV_PREFIX } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'
import type { ExecuteResult, SessionExecuteOptions } from '../workspace/types.ts'
import { FileVersionTracker, StaleMirageFileError } from './file_version.ts'
import { decode, errorText, ioToStr, replaceText } from './io_text.ts'
import { mediaOf, type WorkspaceMediaRead } from './read_file.ts'

export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

/** What a tool table acts through: one session's entry points (`Session`). */
export interface SessionLike {
  readonly sessionId: string
  readonly state: SessionState
  readonly decisions: Decisions
  readonly vfs: Files
  mounts(): readonly MountEntry[]
  shell(command: string, options?: SessionExecuteOptions): Promise<ExecuteResult>
  glob(pattern: string): Promise<string[]>
  loaded(): Promise<void>
  reads(): Promise<FileVersionTracker>
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

async function ensureParents(vfs: Files, path: string): Promise<void> {
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
async function missing(vfs: Files, path: string): Promise<boolean> {
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

/** Every tool, in the order the entry points list them. */
export const TOOL_NAMES = ['shell', 'read', 'write', 'edit', 'ls', 'grep', 'glob'] as const

/**
 * Whether a session can run a command at all: its allow list installs the
 * name and no rule refuses the bare command whole. Mirrors Python's `runs`.
 */
export function runs(name: string, session: SessionState): boolean {
  if (!commandVisible(name, session)) return false
  const rules = session.commands
  if (rules === null) return true
  return !rules.deny.some(
    (rule) =>
      (rule.paths ?? []).length === 0 &&
      ((rule.commands ?? []).length === 0 ||
        (rule.commands ?? []).some((p) => patternMatches(p, [name]))),
  )
}

/**
 * Whether a session may write anywhere: a mount it can see whose mode,
 * narrowed by the profile or opened by a show entry below it, reaches
 * write. `/dev` is left out: its null sink takes a write from anyone and
 * stores nothing. Mirrors Python's `writes`.
 */
export function writes(session: SessionState, mounts: readonly MountEntry[]): boolean {
  return mounts.some(
    (mount) =>
      mount.prefix !== DEV_PREFIX &&
      pathVisible(session.visibility, mount.prefix) &&
      MOUNT_MODE_RANK[strongestUnderSession(session, mount.prefix, mount.mode)] >=
        MOUNT_MODE_RANK[MountMode.WRITE],
  )
}

/**
 * A file tool's call as the unit an op-level answer covers
 * (`Decisions.withinCall`): an approval for a path runs every op the call
 * makes on it, and the call's end spends it. Mirrors Python's `one_call`.
 */
function oneCall<T>(session: SessionLike, run: () => Promise<T>): Promise<T> {
  return session.decisions.withinCall(session.sessionId, run)
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
    private readonly session: SessionLike,
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

  /**
   * The tools this session can use, in the order the entry points list them.
   * Read off the session's profile, so no entry point offers a tool every call
   * of which would be refused: `shell` needs a command the allow list
   * installs, `ls` and `grep` run those commands and need them, and
   * `write` and `edit` need somewhere the session may write. `read` and
   * `glob` are always offered; what they cannot reach answers as the
   * error it is. A session not loaded yet (a stored one before its first
   * call) is offered every tool, since its profile is not known here; the
   * policies still judge each call, and `offered` loads it first. Mirrors
   * Python's `names`.
   */
  names(): readonly string[] {
    let session: SessionState
    try {
      session = this.session.state
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('unknown session:')) return TOOL_NAMES
      throw err
    }
    const allow = session.visibility.commands
    const writable = writes(session, this.session.mounts())
    const offered: Record<string, boolean> = {
      shell: allow === null || allow.length > 0,
      read: true,
      write: writable,
      edit: writable,
      ls: runs('ls', session),
      grep: runs('grep', session),
      glob: true,
    }
    return TOOL_NAMES.filter((name) => offered[name] === true)
  }

  /**
   * The tools this session can use, its sessions loaded first, so a stored
   * session answers with its own profile: what an async entry point lists and
   * calls by. Mirrors Python's `offered`.
   */
  async offered(): Promise<readonly string[]> {
    await this.session.loaded()
    return this.names()
  }

  private lineOptions(signal: AbortSignal | undefined): SessionExecuteOptions {
    return signal === undefined ? {} : { signal }
  }

  /** Run a line in the session's shell; `signal` aborts it, as in-app. */
  async shell(command: string, signal?: AbortSignal): Promise<ToolResult> {
    return ioResult(await this.session.shell(command, this.lineOptions(signal)))
  }

  read(path: string, offset = 0, limit = 2000): Promise<ToolResult> {
    return oneCall(this.session, async () => {
      const versions = await this.versions()
      let data: Uint8Array
      try {
        data = await versions.read(path)
      } catch (err) {
        return this.readFailure(versions, path, err)
      }
      return this.numbered(versions, path, data, offset, limit)
    })
  }

  /**
   * Read a file for an entry point that hands media to the model, in one fetch:
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
    return errorResult(errorText(err))
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
  write(path: string, content: string): Promise<ToolResult> {
    return oneCall(this.session, async () => {
      const versions = await this.versions()
      let present: boolean
      try {
        present = await versions.vfs.exists(path)
      } catch (err) {
        if (typeof (err as { code?: unknown } | null)?.code !== 'string') throw err
        return errorResult(errorText(err))
      }
      if (present && !versions.hasRead(path)) {
        return errorResult(`Error: file '${path}' exists; read all of it before overwriting it`)
      }
      try {
        await ensureParents(versions.vfs, path)
        await versions.write(path, content)
      } catch (err) {
        return errorResult(errorText(err))
      }
      return textResult(`Written: ${path}`)
    })
  }

  edit(
    path: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<ToolResult> {
    return oneCall(this.session, async () => {
      const versions = await this.versions()
      let content: string
      try {
        content = decode(await versions.readForEdit(path))
      } catch (err) {
        if (err instanceof StaleMirageFileError) return errorResult(`Error: ${err.message}`)
        if (await missing(versions.vfs, path)) {
          return errorResult(`Error: file '${path}' not found`)
        }
        return errorResult(errorText(err))
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
        return errorResult(errorText(err))
      }
      const occurrences = replaceAll ? count : 1
      return textResult(`Edited: ${path} (${String(occurrences)} occurrence(s))`)
    })
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
  glob(pattern: string, path = '/'): Promise<ToolResult> {
    return oneCall(this.session, async () => {
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
    })
  }

  /**
   * Run one tool by name with its JSON input. The one entry every entry point
   * shares: MCP, the HTTP routes, the CLI and the agent adapters hand a
   * tool's name and its input, as the tool's `*_INPUT` schema reads it,
   * to this method, so each tool answers the same way through each of
   * them. Throws for a name no tool has, or one the session's profile does
   * not offer (`offered`). Mirrors Python's `call`.
   */
  async call(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (
      (TOOL_NAMES as readonly string[]).includes(name) &&
      !(await this.offered()).includes(name)
    ) {
      throw new Error(`unknown tool: ${name}`)
    }
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
