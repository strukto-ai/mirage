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

import type { Files } from '@struktoai/mirage-core/workspace/files'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { ExecuteResult, Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
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
import { FileVersionTracker } from '@struktoai/mirage-core/workspace/tools/file_version'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { decode, refusalLine } from '@struktoai/mirage-core/workspace/tools/io_text'

export { StaleMirageFileError } from '@struktoai/mirage-core/workspace/tools/file_version'

export interface MirageOperationsOptions {
  staleWriteProtection?: boolean
  /**
   * The session the operations act as, so its profile judges every
   * call; the workspace's default session when absent.
   */
  sessionId?: string
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

async function ensureParent(vfs: Files, dir: string): Promise<void> {
  const norm = rstripSlash(dir) || '/'
  if (norm === '/' || (await vfs.exists(norm))) return
  const parent = norm.substring(0, norm.lastIndexOf('/')) || '/'
  await ensureParent(vfs, parent)
  try {
    await vfs.mkdir(norm)
  } catch (err) {
    if (await vfs.isDir(norm)) return
    throw err
  }
}

interface WalkOptions {
  ignoreMatchers: ((path: string) => boolean)[]
  limit: number
}

async function walkDirectory(
  vfs: Files,
  dir: string,
  cwdPrefix: string,
  matcher: (relativePath: string) => boolean,
  opts: WalkOptions,
  results: string[],
): Promise<void> {
  if (results.length >= opts.limit) return
  const entries = await vfs.readdir(dir)
  for (const full of entries) {
    if (results.length >= opts.limit) return
    const rel = full.startsWith(cwdPrefix) ? full.slice(cwdPrefix.length) : full
    if (opts.ignoreMatchers.some((m) => m(rel))) continue
    const isDir = await vfs.isDir(full)
    if (matcher(rel)) results.push(full)
    if (isDir) await walkDirectory(vfs, full, cwdPrefix, matcher, opts, results)
  }
}

export function mirageOperations(
  ws: Workspace,
  options: MirageOperationsOptions = {},
): MirageOperationsBundle {
  const sessionId = options.sessionId
  const versions = new FileVersionTracker(
    sessionId === undefined ? ws.vfs : new Session(ws, sessionId).vfs,
    options.staleWriteProtection ?? true,
  )
  const vfs = versions.vfs
  const read: ReadOperations = {
    readFile: async (absolutePath: string) => Buffer.from(await versions.read(absolutePath)),
    access: async (absolutePath: string) => {
      await vfs.stat(absolutePath)
    },
  }

  const write: WriteOperations = {
    writeFile: (absolutePath: string, content: string) => versions.write(absolutePath, content),
    mkdir: async (dir: string) => {
      await ensureParent(vfs, dir)
      if (!(await vfs.exists(dir))) {
        await vfs.mkdir(dir)
      }
    },
  }

  const edit: EditOperations = {
    readFile: async (absolutePath: string) => Buffer.from(await versions.readForEdit(absolutePath)),
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
        result = await ws.shell(command, {
          cwd,
          ...(signal === undefined ? {} : { signal }),
          ...(sessionId === undefined ? {} : { sessionId }),
        })
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
      // The record, described once, unless what was just streamed
      // already says why (an operand-scoped refusal's own line).
      const why = refusalLine(decode(result.stdout) + decode(result.stderr), result.refusal)
      if (why.length > 0) options.onData(Buffer.from(why))
      return { exitCode: result.exitCode }
    },
  }

  const grep: GrepOperations = {
    isDirectory: async (absolutePath: string) => vfs.isDir(absolutePath),
    readFile: async (absolutePath: string) => decode(await versions.read(absolutePath)),
  }

  const find: FindOperations = {
    exists: async (absolutePath: string) => vfs.exists(absolutePath),
    glob: async (pattern, cwd, options) => {
      const matcher = picomatch(pattern, { dot: false })
      const ignoreMatchers = options.ignore.map((p) => picomatch(p, { dot: false }))
      const root = rstripSlash(cwd) || '/'
      const cwdPrefix = root === '/' ? '/' : `${root}/`
      const results: string[] = []
      await walkDirectory(
        vfs,
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
    exists: async (absolutePath: string) => vfs.exists(absolutePath),
    stat: async (absolutePath: string) => {
      const isDir = await vfs.isDir(absolutePath)
      return { isDirectory: () => isDir }
    },
    readdir: async (absolutePath: string) => {
      const entries = await vfs.readdir(absolutePath)
      const prefix = absolutePath === '/' ? '/' : `${rstripSlash(absolutePath)}/`
      return entries.map((e) => (e.startsWith(prefix) ? e.slice(prefix.length) : e))
    },
  }

  return { read, write, edit, bash, grep, find, ls }
}
