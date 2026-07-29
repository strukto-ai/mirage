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
import type {
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
import { gnuDirname } from '@struktoai/mirage-core'

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

export interface LangchainWorkspaceOptions {
  sandboxId?: string
}

export class LangchainWorkspace implements SandboxBackendProtocol {
  readonly id: string
  private readonly ws: Workspace

  constructor(workspace: Workspace, options: LangchainWorkspaceOptions = {}) {
    this.ws = workspace
    this.id = options.sandboxId ?? 'mirage'
  }

  async execute(command: string): Promise<ExecuteResponse> {
    const io = await this.ws.execute(command)
    return ioToExecuteResponse(io)
  }

  async ls(path: string): Promise<LsResult> {
    let entries: string[]
    try {
      entries = await this.ws.fs.readdir(path)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    const files: FileInfo[] = []
    for (const entry of entries) {
      const isDir = await this.ws.fs.isDir(entry)
      files.push({ path: entry, is_dir: isDir })
    }
    return { files }
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    const mimeType = mimeFor(filePath)
    let bytes: Uint8Array
    try {
      bytes = await this.ws.fs.readFile(filePath)
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
    const text = new TextDecoder('utf-8').decode(bytes)
    const lines = text.split('\n')
    if (offset >= lines.length) {
      return {
        error: `Line offset ${String(offset)} exceeds file length (${String(lines.length)} lines)`,
      }
    }
    const end = Math.min(offset + limit, lines.length)
    return { content: lines.slice(offset, end).join('\n'), mimeType }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    let stat: Awaited<ReturnType<Workspace['fs']['stat']>>
    let bytes: Uint8Array
    try {
      stat = await this.ws.fs.stat(filePath)
      bytes = await this.ws.fs.readFile(filePath)
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
    if (await this.ws.fs.exists(filePath)) {
      return { error: `Error: file '${filePath}' already exists` }
    }
    await ensureParent(this.ws, filePath)
    await this.ws.fs.writeFile(filePath, content)
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
      current = await this.ws.fs.readFileText(filePath)
    } catch {
      return { error: `Error: file '${filePath}' not found` }
    }
    const count = current.split(oldString).length - 1
    if (count === 0) {
      return { error: `Error: string not found in file: '${oldString}'` }
    }
    if (count > 1 && !replaceAll) {
      return {
        error: `Error: string '${oldString}' appears ${String(count)} times. Use replaceAll=true`,
      }
    }
    const next = replaceAll
      ? current.split(oldString).join(newString)
      : current.replace(oldString, newString)
    await this.ws.fs.writeFile(filePath, next)
    return { path: filePath, occurrences: replaceAll ? count : 1 }
  }

  async grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult> {
    const parts: string[] = ['grep', '-rn']
    if (glob !== undefined && glob !== null && glob.length > 0) {
      parts.push('--include', shellQuote(glob))
    }
    parts.push(shellQuote(pattern))
    parts.push(shellQuote(path ?? '/'))
    const io = await this.ws.execute(parts.join(' '))
    return { matches: ioToGrepMatches(io) }
  }

  async glob(pattern: string, path = '/'): Promise<GlobResult> {
    const name = pattern.includes('/') ? (pattern.split('/').pop() ?? pattern) : pattern
    const io = await this.ws.execute(`find ${shellQuote(path)} -name ${shellQuote(name)}`)
    return { files: ioToFileInfos(io) }
  }

  async uploadFiles(
    files: readonly (readonly [string, Uint8Array])[],
  ): Promise<FileUploadResponse[]> {
    const results: FileUploadResponse[] = []
    for (const [path, data] of files) {
      await ensureParent(this.ws, path)
      await this.ws.fs.writeFile(path, data)
      results.push({ path, error: null })
    }
    return results
  }

  async downloadFiles(paths: readonly string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = []
    for (const path of paths) {
      try {
        const content = await this.ws.fs.readFile(path)
        results.push({ path, content, error: null })
      } catch {
        results.push({ path, content: null, error: 'file_not_found' })
      }
    }
    return results
  }
}
