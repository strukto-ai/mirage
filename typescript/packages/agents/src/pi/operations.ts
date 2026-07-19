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

import { createHash } from 'node:crypto'
import { rstripSlash, type ExecuteResult, type Workspace } from '@struktoai/mirage-core'
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from '@earendil-works/pi-coding-agent'
import picomatch from 'picomatch'

export interface MirageOperationsOptions {
  staleWriteProtection?: boolean
}

export class StaleMirageFileError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`File changed since it was last read: ${path}. Read the file again before modifying it.`)
    this.name = 'StaleMirageFileError'
    this.path = path
  }
}

export interface MirageOperationsBundle {
  read: ReadOperations
  write: WriteOperations
  edit: EditOperations
  bash: BashOperations
  grep: GrepOperations
  find: FindOperations
  ls: LsOperations
}

function fingerprint(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('base64url')
}

async function readBuffer(ws: Workspace, path: string): Promise<Buffer> {
  const bytes = await ws.fs.readFile(path, { raw: true })
  return Buffer.from(bytes)
}

class FileVersionTracker {
  private readonly readVersions = new Map<string, string>()
  private readonly editVersions = new Map<string, string>()

  constructor(
    private readonly ws: Workspace,
    private readonly enabled: boolean,
  ) {}

  private async currentVersion(path: string): Promise<string | null> {
    if (!(await this.ws.fs.exists(path))) return null
    return fingerprint(await readBuffer(this.ws, path))
  }

  private async assertVersion(path: string, expected: string): Promise<void> {
    if ((await this.currentVersion(path)) !== expected) {
      throw new StaleMirageFileError(path)
    }
  }

  private recordWrite(path: string, content: string): void {
    if (!this.enabled) return
    this.readVersions.set(path, fingerprint(content))
    this.editVersions.delete(path)
  }

  async read(path: string): Promise<Buffer> {
    const content = await readBuffer(this.ws, path)
    if (this.enabled) this.readVersions.set(path, fingerprint(content))
    return content
  }

  async readForEdit(path: string): Promise<Buffer> {
    const content = await readBuffer(this.ws, path)
    if (!this.enabled) return content
    const version = fingerprint(content)
    const readVersion = this.readVersions.get(path)
    if (readVersion !== undefined && readVersion !== version) {
      throw new StaleMirageFileError(path)
    }
    this.editVersions.set(path, version)
    return content
  }

  async write(path: string, content: string): Promise<void> {
    if (this.enabled) {
      const readVersion = this.readVersions.get(path)
      if (readVersion !== undefined) await this.assertVersion(path, readVersion)
    }
    await this.ws.fs.writeFile(path, content)
    this.recordWrite(path, content)
  }

  async writeEdit(path: string, content: string): Promise<void> {
    if (this.enabled) {
      const editVersion = this.editVersions.get(path)
      if (editVersion !== undefined) await this.assertVersion(path, editVersion)
    }
    await this.ws.fs.writeFile(path, content)
    this.recordWrite(path, content)
  }
}

async function ensureParent(ws: Workspace, dir: string): Promise<void> {
  const norm = rstripSlash(dir) || '/'
  if (norm === '/' || (await ws.fs.exists(norm))) return
  const parent = norm.substring(0, norm.lastIndexOf('/')) || '/'
  await ensureParent(ws, parent)
  try {
    await ws.fs.mkdir(norm)
  } catch (err) {
    if (await ws.fs.isDir(norm)) return
    throw err
  }
}

interface WalkOptions {
  ignoreMatchers: ((path: string) => boolean)[]
  limit: number
}

async function walkDirectory(
  ws: Workspace,
  dir: string,
  cwdPrefix: string,
  matcher: (relativePath: string) => boolean,
  opts: WalkOptions,
  results: string[],
): Promise<void> {
  if (results.length >= opts.limit) return
  const entries = await ws.fs.readdir(dir)
  for (const full of entries) {
    if (results.length >= opts.limit) return
    const rel = full.startsWith(cwdPrefix) ? full.slice(cwdPrefix.length) : full
    if (opts.ignoreMatchers.some((m) => m(rel))) continue
    const isDir = await ws.fs.isDir(full)
    if (matcher(rel)) results.push(full)
    if (isDir) await walkDirectory(ws, full, cwdPrefix, matcher, opts, results)
  }
}

export function mirageOperations(
  ws: Workspace,
  options: MirageOperationsOptions = {},
): MirageOperationsBundle {
  const versions = new FileVersionTracker(ws, options.staleWriteProtection ?? true)
  const read: ReadOperations = {
    readFile: (absolutePath: string) => versions.read(absolutePath),
    access: async (absolutePath: string) => {
      await ws.fs.stat(absolutePath)
    },
  }

  const write: WriteOperations = {
    writeFile: (absolutePath: string, content: string) => versions.write(absolutePath, content),
    mkdir: async (dir: string) => {
      await ensureParent(ws, dir)
      if (!(await ws.fs.exists(dir))) {
        await ws.fs.mkdir(dir)
      }
    },
  }

  const edit: EditOperations = {
    readFile: (absolutePath: string) => versions.readForEdit(absolutePath),
    writeFile: (absolutePath: string, content: string) => versions.writeEdit(absolutePath, content),
    access: read.access,
  }

  const bash: BashOperations = {
    exec: async (command, cwd, options) => {
      const timeoutSignal =
        options.timeout !== undefined && options.timeout > 0
          ? AbortSignal.timeout(options.timeout * 1000)
          : undefined
      const signal =
        options.signal !== undefined && timeoutSignal !== undefined
          ? AbortSignal.any([options.signal, timeoutSignal])
          : (options.signal ?? timeoutSignal)
      let result: ExecuteResult
      try {
        result =
          signal === undefined
            ? await ws.execute(command, { cwd })
            : await ws.execute(command, { cwd, signal })
      } catch (error) {
        if (options.signal?.aborted === true) {
          throw new Error('aborted')
        }
        if (timeoutSignal?.aborted === true) {
          throw new Error('timeout:' + String(options.timeout))
        }
        throw error
      }
      if (result.stdout.length > 0) {
        options.onData(Buffer.from(result.stdout))
      }
      if (result.stderr.length > 0) {
        options.onData(Buffer.from(result.stderr))
      }
      return { exitCode: result.exitCode }
    },
  }

  const grep: GrepOperations = {
    isDirectory: async (absolutePath: string) => ws.fs.isDir(absolutePath),
    readFile: async (absolutePath: string) => (await versions.read(absolutePath)).toString('utf-8'),
  }

  const find: FindOperations = {
    exists: async (absolutePath: string) => ws.fs.exists(absolutePath),
    glob: async (pattern, cwd, options) => {
      const matcher = picomatch(pattern, { dot: false })
      const ignoreMatchers = options.ignore.map((p) => picomatch(p, { dot: false }))
      const root = rstripSlash(cwd) || '/'
      const cwdPrefix = root === '/' ? '/' : `${root}/`
      const results: string[] = []
      await walkDirectory(
        ws,
        root,
        cwdPrefix,
        matcher,
        { ignoreMatchers, limit: options.limit },
        results,
      )
      return results
    },
  }

  const ls: LsOperations = {
    exists: async (absolutePath: string) => ws.fs.exists(absolutePath),
    stat: async (absolutePath: string) => {
      const isDir = await ws.fs.isDir(absolutePath)
      return { isDirectory: () => isDir }
    },
    readdir: async (absolutePath: string) => {
      const entries = await ws.fs.readdir(absolutePath)
      const prefix = absolutePath === '/' ? '/' : `${rstripSlash(absolutePath)}/`
      return entries.map((e) => (e.startsWith(prefix) ? e.slice(prefix.length) : e))
    },
  }

  return { read, write, edit, bash, grep, find, ls }
}
