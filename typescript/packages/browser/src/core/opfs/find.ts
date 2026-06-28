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

import type { PathSpec } from '@struktoai/mirage-core'
import type { OPFSAccessor } from '../../accessor/opfs.ts'
import { isNotFound, iterEntries, norm, resolveDirHandle } from './utils.ts'
import {
  buildTree,
  emitStartPath,
  keep,
  type PredNode,
  startBasename,
} from '@struktoai/mirage-core'

export interface FindOptions {
  name?: string | null
  type?: 'f' | 'd' | null
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
  options: FindOptions
  tree: PredNode
  results: string[]
}

async function walk(
  ctx: WalkCtx,
  dir: FileSystemDirectoryHandle,
  current: string,
  depth: number,
): Promise<void> {
  const opts = ctx.options
  if (opts.maxDepth !== null && opts.maxDepth !== undefined && depth > opts.maxDepth) return
  let iter: AsyncIterable<[string, FileSystemHandle]>
  try {
    iter = iterEntries(dir)
  } catch {
    return
  }
  for await (const [entryName, handle] of iter) {
    const kind: 'f' | 'd' = handle.kind === 'directory' ? 'd' : 'f'
    const entryPath = current === '/' ? `/${entryName}` : `${current}/${entryName}`
    const entryDepth = depth + 1

    let accept = true
    if (opts.maxDepth !== null && opts.maxDepth !== undefined && entryDepth > opts.maxDepth) {
      accept = false
    }
    let isEmpty: boolean | null = null
    if (accept && opts.empty === true) {
      try {
        if (kind === 'f') {
          isEmpty = (await (handle as FileSystemFileHandle).getFile()).size === 0
        } else {
          isEmpty = true
          for await (const _child of iterEntries(handle as FileSystemDirectoryHandle)) {
            void _child
            isEmpty = false
            break
          }
        }
      } catch {
        isEmpty = null
      }
    }
    if (
      accept &&
      !keep(
        { key: entryPath, name: entryName, kind, depth: entryDepth, isEmpty },
        ctx.tree,
        opts.minDepth,
      )
    ) {
      accept = false
    }

    if (
      accept &&
      kind === 'f' &&
      (opts.minSize !== null ||
        opts.maxSize !== null ||
        opts.mtimeMin !== null ||
        opts.mtimeMax !== null)
    ) {
      try {
        const fh = await dir.getFileHandle(entryName, { create: false })
        const file = await fh.getFile()
        if (opts.minSize !== null && opts.minSize !== undefined && file.size < opts.minSize)
          accept = false
        if (opts.maxSize !== null && opts.maxSize !== undefined && file.size > opts.maxSize)
          accept = false
        if (accept && (opts.mtimeMin !== undefined || opts.mtimeMax !== undefined)) {
          const mtime = file.lastModified / 1000
          if (opts.mtimeMin !== null && opts.mtimeMin !== undefined && mtime < opts.mtimeMin)
            accept = false
          if (opts.mtimeMax !== null && opts.mtimeMax !== undefined && mtime > opts.mtimeMax)
            accept = false
        }
      } catch {
        accept = false
      }
    }

    if (accept) ctx.results.push(entryPath)

    if (kind === 'd') {
      try {
        const child = await dir.getDirectoryHandle(entryName, { create: false })
        await walk(ctx, child, entryPath, depth + 1)
      } catch {
        // ignore
      }
    }
  }
}

export async function find(
  accessor: OPFSAccessor,
  p: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const root = accessor.rootHandle
  const virtual = norm(p.stripPrefix)
  const startName = startBasename(p.original)
  const results: string[] = []
  const tree =
    options.tree ??
    buildTree({
      name: options.name,
      iname: options.iname,
      pathPattern: options.pathPattern,
      type: options.type,
      nameExclude: options.nameExclude,
      orNames: options.orNames,
      empty: options.empty,
    })
  let dir: FileSystemDirectoryHandle
  try {
    dir = await resolveDirHandle(root, virtual, { create: false })
  } catch (err) {
    if (isNotFound(err)) return results
    throw err
  }
  if (options.maxDepth == null || options.maxDepth >= 0) {
    let rootEmpty: boolean | null = null
    if (options.empty === true) {
      rootEmpty = true
      for await (const _child of iterEntries(dir)) {
        void _child
        rootEmpty = false
        break
      }
    }
    emitStartPath(results, virtual, startName, {
      kind: 'd',
      isEmpty: rootEmpty,
      exists: true,
      tree,
      maxDepth: options.maxDepth,
      minDepth: options.minDepth,
    })
  }
  await walk({ options, tree, results }, dir, virtual, 0)
  results.sort()
  return results
}
