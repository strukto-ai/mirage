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

import type { RAMAccessor } from '../../accessor/ram.ts'
import type { PathSpec } from '../../types.ts'
import { norm } from './utils.ts'
import { rstripSlash } from '../../utils/slash.ts'
import {
  buildTree,
  computeNonemptyDirs,
  emitStartPath,
  keep,
  type PredNode,
  startBasename,
} from '../../commands/builtin/findEval.ts'

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

export function find(
  accessor: RAMAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const p = norm(path.stripPrefix)
  const startName = startBasename(path.original)
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
  const nonempty = empty
    ? computeNonemptyDirs([
        ...accessor.store.files.keys(),
        ...[...accessor.store.dirs].filter((k) => k !== '/'),
      ])
    : new Set<string>()
  const candidates: [string, 'f' | 'd'][] = []
  if (options.type !== 'd') {
    for (const key of accessor.store.files.keys()) candidates.push([key, 'f'])
  }
  if (options.type !== 'f') {
    for (const key of accessor.store.dirs) candidates.push([key, 'd'])
  }
  let rootKind: 'f' | 'd' | null = null
  let rootIsEmpty: boolean | null = null
  let rootSize: number | null = null
  for (const [key, kind] of candidates) {
    if (key !== p && !key.startsWith(prefix)) continue
    if (key === p) {
      rootKind = kind
      if (empty) {
        rootIsEmpty =
          kind === 'f' ? (accessor.store.files.get(key)?.byteLength ?? 0) === 0 : !nonempty.has(key)
      }
      if (kind === 'f') rootSize = accessor.store.files.get(key)?.byteLength ?? 0
      continue
    }
    const depth = (key.match(/\//g) ?? []).length - baseDepth
    if (options.maxDepth !== null && options.maxDepth !== undefined && depth > options.maxDepth)
      continue
    const basename = key.slice(key.lastIndexOf('/') + 1)
    let isEmpty: boolean | null = null
    if (empty) {
      isEmpty =
        kind === 'f' ? (accessor.store.files.get(key)?.byteLength ?? 0) === 0 : !nonempty.has(key)
    }
    if (!keep({ key, name: basename, kind, depth, isEmpty }, tree, options.minDepth)) continue
    if (kind === 'f' && (options.minSize !== null || options.maxSize !== null)) {
      const data = accessor.store.files.get(key)
      if (data === undefined) continue
      const size = data.byteLength
      if (options.minSize !== null && options.minSize !== undefined && size < options.minSize)
        continue
      if (options.maxSize !== null && options.maxSize !== undefined && size > options.maxSize)
        continue
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
  return Promise.resolve(results)
}
