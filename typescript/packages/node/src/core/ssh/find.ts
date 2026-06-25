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
import { buildTree, keep, type PredNode, rstripSlash } from '@struktoai/mirage-core'

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
  empty?: boolean | null
  tree?: PredNode | null
  mtimeMin?: number | null
  mtimeMax?: number | null
}

interface WalkCtx {
  accessor: SSHAccessor
  options: FindOptions
  results: string[]
  baseDepth: number
  tree: PredNode
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
  tree: PredNode,
): boolean {
  if (opts.maxDepth !== null && opts.maxDepth !== undefined && depth > opts.maxDepth) return false
  const basename = entryPath.slice(entryPath.lastIndexOf('/') + 1)
  const isEmpty = isDir ? false : entry.attrs.size === 0
  if (
    !keep(
      { key: entryPath, name: basename, kind: isDir ? 'd' : 'f', depth, isEmpty },
      tree,
      opts.minDepth,
    )
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

async function statRemote(
  accessor: SSHAccessor,
  remote: string,
): Promise<{ isDir: boolean; size: number } | null> {
  const sftp = await accessor.sftp()
  return new Promise<{ isDir: boolean; size: number } | null>((resolveFn, rejectFn) => {
    sftp.stat(remote, (err, stats) => {
      if (err !== undefined) {
        const code = (err as { code?: unknown }).code
        if (code === 2) {
          resolveFn(null)
          return
        }
        rejectFn(err)
        return
      }
      resolveFn({ isDir: stats.isDirectory(), size: stats.size })
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
    if (matches(entry, childPath, isDir, depth + 1, opts, ctx.tree)) {
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
  const startName = rstripSlash(p.original).split('/').pop() ?? ''
  const results: string[] = []
  const baseDepth = (virtual.match(/\//g) ?? []).length
  const typeKind: 'f' | 'd' | null = isFileType(options.type)
    ? 'f'
    : isDirType(options.type)
      ? 'd'
      : null
  const tree =
    options.tree ??
    buildTree({
      name: options.name,
      iname: options.iname,
      pathPattern: options.pathPattern,
      type: typeKind,
      nameExclude: options.nameExclude,
      orNames: options.orNames,
    })
  if (options.maxDepth == null || options.maxDepth >= 0) {
    const st = await statRemote(accessor, joinRoot(accessor.config.root ?? '/', virtual))
    if (
      st !== null &&
      keep(
        {
          key: virtual,
          name: startName || virtual.slice(virtual.lastIndexOf('/') + 1),
          kind: st.isDir ? 'd' : 'f',
          depth: 0,
          isEmpty: st.isDir ? false : st.size === 0,
        },
        tree,
        options.minDepth,
      )
    ) {
      results.push(virtual)
    }
  }
  await walk({ accessor, options, results, baseDepth, tree }, virtual, 0)
  results.sort()
  return results
}
