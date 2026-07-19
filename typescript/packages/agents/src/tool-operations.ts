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

import type { ExecuteResult, Workspace } from '@struktoai/mirage-core'
import { gnuDirname } from '@struktoai/mirage-core'
import { FileVersionTracker, StaleMirageFileError } from './file-version.ts'
import { decode, ioToStr } from './io-text.ts'

export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export interface MirageToolOperationsOptions {
  staleWriteProtection?: boolean
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

async function ensureParents(ws: Workspace, path: string): Promise<void> {
  const parent = gnuDirname(path)
  if (parent === '/' || parent === '' || parent === '.') return
  if (await ws.fs.exists(parent)) return
  await ensureParents(ws, parent)
  try {
    await ws.fs.mkdir(parent)
  } catch (err) {
    if (!(await ws.fs.exists(parent))) throw err
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MirageToolOperations {
  private readonly versions: FileVersionTracker

  constructor(
    private readonly ws: Workspace,
    options: MirageToolOperationsOptions = {},
  ) {
    this.versions = new FileVersionTracker(ws, options.staleWriteProtection ?? true)
  }

  async execute(command: string): Promise<ToolResult> {
    return ioResult(await this.ws.execute(command))
  }

  async read(path: string, offset = 0, limit = 2000): Promise<ToolResult> {
    let data: Uint8Array
    try {
      data = await this.versions.read(path)
    } catch (err) {
      if (!(await this.ws.fs.exists(path))) {
        return errorResult(`Error: file '${path}' not found`)
      }
      return errorResult(`Error: ${errorMessage(err)}`)
    }
    const text = decode(data)
    const raw = text.length === 0 ? [] : text.split(/(?<=\n)/)
    const lines = raw.length > 0 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw
    const sliced = lines.slice(offset, offset + limit)
    const numbered = sliced.map((line, i) => `${String(i + offset + 1).padStart(6)}\t${line}`)
    return textResult(numbered.join(''))
  }

  async write(path: string, content: string): Promise<ToolResult> {
    if (await this.ws.fs.exists(path)) {
      return errorResult(`Error: file '${path}' already exists`)
    }
    await ensureParents(this.ws, path)
    await this.versions.write(path, content)
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
      if (!(await this.ws.fs.exists(path))) {
        return errorResult(`Error: file '${path}' not found`)
      }
      return errorResult(`Error: ${errorMessage(err)}`)
    }
    const count = content.split(oldString).length - 1
    if (count === 0) {
      return errorResult(`Error: string not found in file: '${oldString}'`)
    }
    if (count > 1 && !replaceAll) {
      return errorResult(`Error: string appears ${String(count)} times. Pass replace_all=true`)
    }
    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString)
    try {
      await this.versions.writeEdit(path, newContent)
    } catch (err) {
      return errorResult(`Error: ${errorMessage(err)}`)
    }
    const occurrences = replaceAll ? count : 1
    return textResult(`Edited: ${path} (${String(occurrences)} occurrence(s))`)
  }

  async ls(path: string): Promise<ToolResult> {
    return ioResult(await this.ws.execute(`ls ${shQuote(path)}`))
  }

  async grep(pattern: string, path: string): Promise<ToolResult> {
    const io = await this.ws.execute(`grep -rn ${shQuote(pattern)} ${shQuote(path)}`)
    return textResult(ioToStr(io))
  }
}
