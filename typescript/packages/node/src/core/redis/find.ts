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
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm } from './utils.ts'
import {
  buildTree,
  computeNonemptyDirs,
  emitStartPath,
  keep,
  type PredNode,
  rstripSlash,
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
}

export async function find(
  accessor: RedisAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const p = norm(path.mountPath)
  const startName = startBasename(path.virtual)
  const store = accessor.store
  const prefix = rstripSlash(p) + '/'
  const baseDepth = p === '/' ? 0 : (p.match(/\//g) ?? []).length
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
  const empty = options.empty === true
  const allFiles = await store.listFiles()
  const allDirs = await store.listDirs()
  const nonempty = empty
    ? computeNonemptyDirs([...allFiles, ...[...allDirs].filter((k) => k !== '/')])
    : new Set<string>()
  const candidates: [string, 'f' | 'd'][] = []
  if (options.type !== 'd') {
    for (const key of allFiles) candidates.push([key, 'f'])
  }
  if (options.type !== 'f') {
    for (const key of allDirs) {
      candidates.push([key, 'd'])
    }
  }
  let rootKind: 'f' | 'd' | null = null
  let rootIsEmpty: boolean | null = null
  let rootSize: number | null = null
  for (const [key, kind] of candidates) {
    if (key !== p && !key.startsWith(prefix)) continue
    if (key === p) {
      rootKind = kind
      if (empty) {
        rootIsEmpty = kind === 'f' ? (await store.fileLen(key)) === 0 : !nonempty.has(key)
      }
      if (kind === 'f') rootSize = await store.fileLen(key)
      continue
    }
    const depth = (key.match(/\//g) ?? []).length - baseDepth
    if (options.maxDepth !== null && options.maxDepth !== undefined && depth > options.maxDepth)
      continue
    const basename = key.slice(key.lastIndexOf('/') + 1)
    let isEmpty: boolean | null = null
    if (empty) {
      isEmpty = kind === 'f' ? (await store.fileLen(key)) === 0 : !nonempty.has(key)
    }
    if (!keep({ key, name: basename, kind, depth, isEmpty }, tree, options.minDepth)) continue
    if (options.minSize != null || options.maxSize != null) {
      // Directories count as size 0 for -size (deliberate GNU divergence).
      const size = kind === 'f' ? await store.fileLen(key) : 0
      if (options.minSize != null && size < options.minSize) continue
      if (options.maxSize != null && size > options.maxSize) continue
    }
    results.push(key)
  }
  if (rootKind !== null) {
    emitStartPath(results, p, startName, {
      kind: rootKind,
      isEmpty: rootIsEmpty,
      exists: true,
      tree,
      maxDepth: options.maxDepth,
      minDepth: options.minDepth,
      size: rootSize,
      minSize: options.minSize,
      maxSize: options.maxSize,
    })
  }
  results.sort()
  return results
}
