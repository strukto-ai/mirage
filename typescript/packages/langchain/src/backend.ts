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
import type { Workspace } from '@struktoai/mirage-node'
import type { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'
import type { Files } from '@struktoai/mirage-core/workspace/files'
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
import { decode, replaceText, withRefusal } from '@struktoai/mirage-core/workspace/tools/io_text'

const TEXT_EXTENSIONS = new Set([
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
  'fish',
  'sql',
  'log',
  'env',
  'ini',
  'toml',
  'conf',
  'cfg',
])

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s
  return `'${s.replaceAll(`'`, `'\\''`)}'`
}

function commandError(io: ExecuteResult): string | undefined {
  if (io.exitCode === 0) return undefined
  const stderr = withRefusal(io.stderrText.trim(), io.refusal).trim()
  return stderr || `Command failed with exit code ${String(io.exitCode)}`
}

function relativeTo(root: string, path: string): string {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : (path.split('/').pop() ?? path)
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return ''
  return path.slice(dot + 1).toLowerCase()
}

function mimeFor(path: string): string {
  const ext = extOf(path)
  if (ext === 'json' || ext === 'jsonl') return 'application/json'
  if (ext === 'csv') return 'text/csv'
  if (ext === 'html' || ext === 'htm') return 'text/html'
  if (ext === 'md') return 'text/markdown'
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain'
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'pdf') return 'application/pdf'
  return 'application/octet-stream'
}

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json'
}

const ANTHROPIC_BINARY_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

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
    let entries: string[]
    try {
      entries = await this.vfs.readdir(path)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    const files: FileInfo[] = []
    for (const entry of entries) {
      const isDir = await this.vfs.isDir(entry)
      files.push({ path: entry, is_dir: isDir })
    }
    return { files }
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    const mimeType = mimeFor(filePath)
    let bytes: Uint8Array
    try {
      bytes = await this.vfs.read(filePath)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (!isTextMime(mimeType)) {
      if (ANTHROPIC_BINARY_MIMES.has(mimeType)) {
        return { content: bytes, mimeType }
      }
      return {
        error: `Binary file '${filePath}' (${mimeType}, ${String(bytes.length)} bytes). Use shell commands (head, file, wc, od) via execute() to inspect.`,
      }
    }
    const window = normalizeReadPagination(offset, limit)
    const text = new TextDecoder('utf-8').decode(bytes)
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
    const mimeType = mimeFor(filePath)
    const content: string | Uint8Array = isTextMime(mimeType)
      ? new TextDecoder('utf-8').decode(bytes)
      : bytes
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
    const parts: string[] = ['grep', '-rnH']
    if (glob !== undefined && glob !== null && glob.length > 0) {
      parts.push('--include', shellQuote(glob))
    }
    parts.push(shellQuote(pattern))
    parts.push(shellQuote(path ?? '/'))
    const io = await this.exec(parts.join(' '))
    const matches = ioToGrepMatches(io)
    if (maxCount === undefined || maxCount === null || matches.length <= maxCount) {
      return { matches }
    }
    return { matches: matches.slice(0, maxCount), truncated: true }
  }

  /**
   * The files under `path` that `pattern` matches, as Deep Agents' own
   * backends match them: against the path relative to `path`, dotfiles
   * included, regular files only.
   */
  async glob(pattern: string, path = '/'): Promise<GlobResult> {
    const matches = picomatch(pattern, { dot: true })
    const io = await this.exec(`find ${shellQuote(path)} -type f`)
    const error = commandError(io)
    if (error !== undefined) return { error }
    return { files: ioToFileInfos(io).filter((info) => matches(relativeTo(path, info.path))) }
  }

  /** Remove a file, or a directory with everything under it. */
  async delete(filePath: string): Promise<DeleteResult> {
    const io = await this.exec(`rm -r -- ${shellQuote(filePath)}`)
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
