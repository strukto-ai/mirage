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

import type { DiskAccessor } from '../../accessor/disk.ts'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { PathSpec } from '@struktoai/mirage-core'
import { norm, resolveSafe } from './utils.ts'
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
  accessor: DiskAccessor
  base: string
  baseDepth: number
  options: FindOptions
  tree: PredNode
  results: string[]
}

async function walk(ctx: WalkCtx, full: string, current: string, depth: number): Promise<void> {
  const opts = ctx.options
  if (opts.maxDepth !== null && opts.maxDepth !== undefined && depth > opts.maxDepth) return
  let entries
  try {
    entries = await readdir(full, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const kind: 'f' | 'd' = e.isDirectory() ? 'd' : 'f'
    const entryPath = current === '/' ? `/${e.name}` : `${current}/${e.name}`
    const entryName = e.name
    const entrySlashCount = (entryPath.match(/\//g) ?? []).length
    const entryDepth = entrySlashCount - ctx.baseDepth

    let accept = true
    if (opts.maxDepth !== null && opts.maxDepth !== undefined && entryDepth > opts.maxDepth) {
      accept = false
    }
    let isEmpty: boolean | null = null
    if (accept && opts.empty === true) {
      try {
        isEmpty =
          kind === 'f'
            ? (await stat(path.join(full, e.name))).size === 0
            : (await readdir(path.join(full, e.name))).length === 0
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
        const st = await stat(path.join(full, e.name))
        if (opts.minSize !== null && opts.minSize !== undefined && st.size < opts.minSize)
          accept = false
        if (opts.maxSize !== null && opts.maxSize !== undefined && st.size > opts.maxSize)
          accept = false
        if (accept && (opts.mtimeMin !== undefined || opts.mtimeMax !== undefined)) {
          const mtime = st.mtime.getTime() / 1000
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
      await walk(ctx, path.join(full, e.name), entryPath, depth + 1)
    }
  }
}

export async function find(
  accessor: DiskAccessor,
  p: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const virtual = norm(p.mountPath)
  const startName = startBasename(p.virtual)
  const full = resolveSafe(accessor.root, virtual)
  const baseDepth = virtual === '/' ? 0 : (virtual.match(/\//g) ?? []).length
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
  if (options.maxDepth == null || options.maxDepth >= 0) {
    let isDir = false
    try {
      isDir = (await stat(full)).isDirectory()
    } catch {
      isDir = false
    }
    let rootEmpty: boolean | null = null
    if (isDir && options.empty === true) {
      try {
        rootEmpty = (await readdir(full)).length === 0
      } catch {
        rootEmpty = null
      }
    }
    emitStartPath(results, virtual, startName, {
      kind: 'd',
      isEmpty: rootEmpty,
      exists: isDir,
      tree,
      maxDepth: options.maxDepth,
      minDepth: options.minDepth,
    })
  }
  await walk({ accessor, base: virtual, baseDepth, options, tree, results }, full, virtual, 0)
  results.sort()
  return results
}
