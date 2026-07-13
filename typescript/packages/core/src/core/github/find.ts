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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { GitHubAccessor } from '../../accessor/github.ts'
import type { FindOptions } from '../../resource/base.ts'
import type { PathSpec } from '../../types.ts'
import { buildTree, emitStartPath, keep, startBasename } from '../../commands/builtin/findEval.ts'
import { stripSlash } from '../../utils/slash.ts'

function strip(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  return stripSlash(p)
}

export function find(
  accessor: GitHubAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const base = strip(path)
  const prefix = base === '' ? '' : `${base}/`
  const baseDepth = base === '' ? 0 : (base.match(/\//g) ?? []).length + 1
  const startName = startBasename(path.virtual)
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
    })
  let startKind: 'd' | 'f' | null = base === '' ? 'd' : null
  let startSize = 0
  let hasChild = false
  const sortedKeys = Object.keys(accessor.tree).sort()
  for (const p of sortedKeys) {
    const entry = accessor.tree[p]
    if (entry === undefined) continue
    if (p === base) {
      startKind = entry.type === 'tree' ? 'd' : 'f'
      startSize = entry.size ?? 0
      continue
    }
    if (base !== '' && !p.startsWith(prefix)) continue
    hasChild = true
    const isDir = entry.type === 'tree'
    const fullPath = `/${p}`
    const depth = (p.match(/\//g) ?? []).length + 1 - baseDepth
    if (options.maxDepth !== null && options.maxDepth !== undefined && depth > options.maxDepth) {
      continue
    }
    const entryName = p.split('/').pop() ?? p
    if (
      !keep(
        { key: fullPath, name: entryName, kind: isDir ? 'd' : 'f', depth },
        tree,
        options.minDepth,
      )
    ) {
      continue
    }
    // Directories count as size 0 for -size (deliberate GNU divergence).
    const size = isDir ? 0 : (entry.size ?? 0)
    if (options.minSize !== null && options.minSize !== undefined && size < options.minSize) {
      continue
    }
    if (options.maxSize !== null && options.maxSize !== undefined && size > options.maxSize) {
      continue
    }
    results.push(fullPath)
  }
  if (startKind !== null || hasChild) {
    const rootKind = startKind ?? 'd'
    emitStartPath(results, base === '' ? '/' : `/${base}`, startName, {
      kind: rootKind,
      isEmpty: null,
      exists: true,
      tree,
      maxDepth: options.maxDepth,
      minDepth: options.minDepth,
      size: rootKind === 'f' ? startSize : null,
      minSize: options.minSize,
      maxSize: options.maxSize,
    })
  }
  return Promise.resolve(results.sort())
}
