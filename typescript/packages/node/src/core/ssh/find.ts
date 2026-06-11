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

import type { FileEntryWithStats } from 'ssh2'
import type { PathSpec } from '@struktoai/mirage-core'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isDirectoryAttrs, joinRoot, stripPrefix } from './utils.ts'
import { norm } from '@struktoai/mirage-core'
import { fnmatch } from '@struktoai/mirage-core'

export interface FindOptions {
  name?: string | null
  type?: 'f' | 'd' | 'file' | 'directory' | null
  minSize?: number | null
  maxSize?: number | null
  maxDepth?: number | null
  minDepth?: number | null
  nameExclude?: string | null
  orNames?: string[] | null
  iname?: string | null
  pathPattern?: string | null
  mtimeMin?: number | null
  mtimeMax?: number | null
}

interface WalkCtx {
  accessor: SSHAccessor
  options: FindOptions
  results: string[]
  baseDepth: number
}

function isFileType(t: FindOptions['type']): boolean {
  return t === 'f' || t === 'file'
}

function isDirType(t: FindOptions['type']): boolean {
  return t === 'd' || t === 'directory'
}

function matches(
  entry: FileEntryWithStats,
  entryPath: string,
  isDir: boolean,
  depth: number,
  opts: FindOptions,
): boolean {
  if (opts.maxDepth !== null && opts.maxDepth !== undefined && depth > opts.maxDepth) return false
  if (opts.minDepth !== null && opts.minDepth !== undefined && depth < opts.minDepth) return false
  if (isFileType(opts.type) && isDir) return false
  if (isDirType(opts.type) && !isDir) return false
  const basename = entryPath.slice(entryPath.lastIndexOf('/') + 1)
  if (opts.orNames !== null && opts.orNames !== undefined && opts.orNames.length > 0) {
    if (!opts.orNames.some((pat) => fnmatch(basename, pat))) return false
  } else if (opts.name !== null && opts.name !== undefined) {
    if (!fnmatch(basename, opts.name)) return false
  }
  if (
    opts.iname !== null &&
    opts.iname !== undefined &&
    !fnmatch(basename.toLowerCase(), opts.iname.toLowerCase())
  ) {
    return false
  }
  if (
    opts.nameExclude !== null &&
    opts.nameExclude !== undefined &&
    fnmatch(basename, opts.nameExclude)
  ) {
    return false
  }
  if (
    opts.pathPattern !== null &&
    opts.pathPattern !== undefined &&
    !fnmatch(entryPath, opts.pathPattern)
  ) {
    return false
  }
  if (!isDir) {
    const size = entry.attrs.size
    if (opts.minSize !== null && opts.minSize !== undefined && size < opts.minSize) return false
    if (opts.maxSize !== null && opts.maxSize !== undefined && size > opts.maxSize) return false
  }
  if (
    (opts.mtimeMin !== null && opts.mtimeMin !== undefined) ||
    (opts.mtimeMax !== null && opts.mtimeMax !== undefined)
  ) {
    const mtime = entry.attrs.mtime
    if (opts.mtimeMin !== null && opts.mtimeMin !== undefined && mtime < opts.mtimeMin) return false
    if (opts.mtimeMax !== null && opts.mtimeMax !== undefined && mtime > opts.mtimeMax) return false
  }
  return true
}

async function readRemoteDir(
  accessor: SSHAccessor,
  remote: string,
): Promise<FileEntryWithStats[] | null> {
  const sftp = await accessor.sftp()
  return new Promise<FileEntryWithStats[] | null>((resolveFn, rejectFn) => {
    sftp.readdir(remote, (err, entries) => {
      if (err !== undefined) {
        const code = (err as { code?: unknown }).code
        if (code === 2) {
          resolveFn(null)
          return
        }
        rejectFn(err)
        return
      }
      resolveFn(entries)
    })
  })
}

async function walk(ctx: WalkCtx, virtual: string, depth: number): Promise<void> {
  const opts = ctx.options
  if (opts.maxDepth !== null && opts.maxDepth !== undefined && depth > opts.maxDepth) return
  const remote = joinRoot(ctx.accessor.config.root ?? '/', virtual)
  const entries = await readRemoteDir(ctx.accessor, remote)
  if (entries === null) return
  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') continue
    const childPath = virtual === '/' ? `/${entry.filename}` : `${virtual}/${entry.filename}`
    const isDir = isDirectoryAttrs(entry.attrs)
    if (isFileType(opts.type) && isDir) {
      await walk(ctx, childPath, depth + 1)
      continue
    }
    if (matches(entry, childPath, isDir, depth + 1, opts)) {
      ctx.results.push(childPath)
    }
    if (isDir) {
      await walk(ctx, childPath, depth + 1)
    }
  }
}

export async function find(
  accessor: SSHAccessor,
  p: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const virtual = norm(stripPrefix(p))
  const results: string[] = []
  const baseDepth = (virtual.match(/\//g) ?? []).length
  await walk({ accessor, options, results, baseDepth }, virtual, 0)
  results.sort()
  return results
}
