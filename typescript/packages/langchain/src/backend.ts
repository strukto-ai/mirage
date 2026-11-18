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

import { ensureParents } from '@struktoai/mirage-core/workspace/tools/tool_operations'
import { TRUNCATION_NOTICE } from '@struktoai/mirage-core/commands/builtin/utils/limit'
import type { Workspace } from '@struktoai/mirage-node'
import type { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'
import { mimeTypeFor } from '@struktoai/mirage-core/utils/filetype'
import { resolvePath } from '@struktoai/mirage-core/utils/path'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import { readerOf, type Files } from '@struktoai/mirage-core/workspace/files'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import picomatch from 'picomatch'
import { normalizeReadPagination } from 'deepagents'
import type {
  DeleteResult,
  EditResult,
  ExecuteResponse,
  FileData,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  SandboxBackendProtocolV2 as SandboxBackendProtocol,
  WriteResult,
} from 'deepagents'
import { ioToExecuteResponse, ioToFileInfos, ioToGrepMatches } from './convert.ts'
import { decode, replaceText, withDecision } from '@struktoai/mirage-core/workspace/tools/io_text'

const BINARY_EXTENSIONS: Readonly<Record<string, string>> = {
  '.3gpp': 'video/3gpp',
  '.aac': 'audio/aac',
  '.aiff': 'audio/aiff',
  '.avi': 'video/x-msvideo',
  '.flac': 'audio/flac',
  '.flv': 'video/x-flv',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.wmv': 'video/x-ms-wmv',
}

function textContent(
  path: string,
  bytes: Uint8Array,
): { content: string | Uint8Array; mimeType: string } {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  const suffix = dot > 0 ? name.slice(dot) : ''
  const media = BINARY_EXTENSIONS[suffix]
  if (media !== undefined) return { content: bytes, mimeType: media }
  if (!bytes.includes(0)) {
    try {
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      const mime = suffix === '.jsonl' ? 'application/json' : mimeTypeFor(name)
      const mimeType = mime.startsWith('text/') || mime === 'application/json' ? mime : 'text/plain'
      return { content, mimeType }
    } catch (err) {
      if (!(err instanceof TypeError)) throw err
    }
  }
  return { content: bytes, mimeType: 'application/octet-stream' }
}

function commandError(io: ExecuteResult, successExitCodes = [0]): string | undefined {
  if (successExitCodes.includes(io.exitCode)) return undefined
  const stderr = withDecision(io.stderrText.trim(), io.decision).trim()
  return stderr || `Command failed with exit code ${String(io.exitCode)}`
}

function capped(io: ExecuteResult): boolean {
  return io.stderrText.includes(TRUNCATION_NOTICE)
}

function relativeTo(root: string, path: string): string {
  const prefix = `${rstripSlash(root)}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : (path.split('/').pop() ?? path)
}

/**
 * Options for `LangchainWorkspace`: `sandboxId` sets the backend's `id`
 * (default `mirage`), and `sessionId` names the Mirage session it acts as.
 */
export interface LangchainWorkspaceOptions {
  sandboxId?: string
  /**
   * The session the backend acts as, so its profile judges every call;
   * the workspace's default session when absent.
   */
  sessionId?: string
}

/**
 * A `SandboxBackendProtocolV2` implementation for Deep Agents that runs
 * reads, writes, edits, search and shell commands in a Mirage workspace.
 */
export class LangchainWorkspace implements SandboxBackendProtocol {
  readonly id: string
  private readonly ws: Workspace
  private readonly sessionId: string | undefined

  constructor(workspace: Workspace, options: LangchainWorkspaceOptions = {}) {
    this.ws = workspace
    this.id = options.sandboxId ?? 'mirage'
    this.sessionId = options.sessionId
  }

  /** The file API run as this backend's session. */
  private get vfs(): Files {
    if (this.sessionId === undefined) return this.ws.vfs
    return new Session(this.ws, this.sessionId).vfs
  }

  private exec(command: string): Promise<ExecuteResult> {
    return this.ws.shell(command, this.sessionId === undefined ? {} : { sessionId: this.sessionId })
  }

  async execute(command: string): Promise<ExecuteResponse> {
    const io = await this.exec(command)
    return ioToExecuteResponse(io)
  }

  async ls(path: string): Promise<LsResult> {
    const base = rstripSlash(path)
    const io = await this.exec(
      `ls -1Ap --zero --quoting-style=literal -- ${singleQuote(base + '/')}`,
    )
    const error = commandError(io)
    if (error !== undefined) return { error }
    if (capped(io)) return { error: io.stderrText.trim() }
    const entries = io.stdoutText.split('\0')
    if (entries.pop()) return { error: 'Incomplete directory listing' }

    const vfs = this.vfs
    const cwd = this.ws.getSession(this.sessionId ?? this.ws.defaultSessionId).cwd
    const directory = resolvePath(base || '/', cwd)
    const links = readerOf(vfs).linkNamesUnder(directory)
    const files: FileInfo[] = []
    try {
      for (const entry of entries) {
        const name = rstripSlash(entry)
        const isDir =
          entry.endsWith('/') ||
          (links.has(name) && (await vfs.isDir(`${rstripSlash(directory)}/${name}`)))
        files.push({ path: `${base}/${name}`, is_dir: isDir })
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    return { files }
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    let bytes: Uint8Array
    try {
      bytes = await this.vfs.read(filePath)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    const { content: text, mimeType } = textContent(filePath, bytes)
    if (typeof text !== 'string') {
      if (mimeType !== 'application/octet-stream') return { content: bytes, mimeType }
      return {
        error: `Binary file '${filePath}' (${mimeType}, ${String(bytes.length)} bytes). Use shell commands (head, file, wc, od) via execute() to inspect.`,
      }
    }
    const window = normalizeReadPagination(offset, limit)
    const lines = text.split('\n')
    const totalLines = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    if (window.offset > 0 && window.offset >= totalLines) {
      return {
        error: `Line offset ${String(window.offset)} exceeds file length (${String(totalLines)} lines)`,
      }
    }
    const content = lines.slice(window.offset, window.offset + window.limit).join('\n')
    const end = Math.min(window.offset + window.limit, totalLines)
    if (end <= window.offset) return { content, mimeType }
    return {
      content,
      mimeType,
      totalLines,
      startLine: window.offset + 1,
      endLine: end,
      ...(end < totalLines ? { nextOffset: end } : {}),
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    let stat: Awaited<ReturnType<Workspace['vfs']['stat']>>
    let bytes: Uint8Array
    try {
      stat = await this.vfs.stat(filePath)
      bytes = await this.vfs.read(filePath)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    const { content, mimeType } = textContent(filePath, bytes)
    const modified = stat.modified ?? new Date().toISOString()
    const data: FileData = {
      content,
      mimeType,
      created_at: modified,
      modified_at: modified,
    }
    return { data }
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    if (await this.vfs.exists(filePath)) {
      return { error: `Error: file '${filePath}' already exists` }
    }
    await ensureParents(this.vfs, filePath)
    await this.vfs.write(filePath, content)
    return { path: filePath }
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<EditResult> {
    let current: string
    try {
      current = decode(await this.vfs.read(filePath))
    } catch {
      return { error: `Error: file '${filePath}' not found` }
    }
    const [next, count] = replaceText(current, oldString, newString, replaceAll)
    if (count === 0) {
      return { error: `Error: string not found in file: '${oldString}'` }
    }
    if (count > 1 && !replaceAll) {
      return {
        error: `Error: string '${oldString}' appears ${String(count)} times. Use replaceAll=true`,
      }
    }
    await this.vfs.write(filePath, next)
    return { path: filePath, occurrences: replaceAll ? count : 1 }
  }

  // maxCount is a total cap across every file, which is not what `grep -m`
  // means (that one caps each file separately), so it is applied to the
  // collected matches rather than pushed onto the command line. A run that
  // hits the cap with matches left over is truncated; one that lands on it
  // exactly is complete.
  async grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepResult> {
    const root = path === '' ? '/' : (path ?? '/')
    const parts: string[] = ['grep', '-FrnH']
    if (glob !== undefined && glob !== null && glob.length > 0 && !glob.includes('/')) {
      parts.push('--include', singleQuote(glob))
    }
    parts.push('--', singleQuote(pattern), singleQuote(root))
    const io = await this.exec(parts.join(' '))
    const error = commandError(io, [0, 1])
    if (error !== undefined) return { error }
    const all = ioToGrepMatches(io)
    const included = glob ? picomatch(glob, { dot: true, basename: !glob.includes('/') }) : null
    const matches = included ? all.filter((m) => included(relativeTo(root, m.path))) : all
    if (maxCount === undefined || maxCount === null || matches.length <= maxCount) {
      return capped(io) ? { matches, truncated: true } : { matches }
    }
    return { matches: matches.slice(0, maxCount), truncated: true }
  }

  /**
   * The files under `path` that `pattern` matches, as Deep Agents' own
   * backends match them: against the path relative to `path`, dotfiles
   * included, regular files only. A listing the workspace's output cap cut
   * short is reported truncated.
   */
  async glob(pattern: string, path = '/'): Promise<GlobResult> {
    const matches = picomatch(pattern, { dot: true })
    const io = await this.exec(`find ${singleQuote(path)} -type f`)
    const error = commandError(io)
    if (error !== undefined) return { error }
    const files = ioToFileInfos(io).filter((info) => matches(relativeTo(path, info.path)))
    return capped(io) ? { files, truncated: true } : { files }
  }

  /** Remove a file, or a directory with everything under it. */
  async delete(filePath: string): Promise<DeleteResult> {
    const io = await this.exec(`rm -r -- ${singleQuote(filePath)}`)
    const error = commandError(io)
    if (error !== undefined) return { error }
    return { path: filePath }
  }

  async uploadFiles(
    files: readonly (readonly [string, Uint8Array])[],
  ): Promise<FileUploadResponse[]> {
    const results: FileUploadResponse[] = []
    for (const [path, data] of files) {
      await ensureParents(this.vfs, path)
      await this.vfs.write(path, data)
      results.push({ path, error: null })
    }
    return results
  }

  async downloadFiles(paths: readonly string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = []
    for (const path of paths) {
      try {
        const content = await this.vfs.read(path)
        results.push({ path, content, error: null })
      } catch {
        results.push({ path, content: null, error: 'file_not_found' })
      }
    }
    return results
  }
}
