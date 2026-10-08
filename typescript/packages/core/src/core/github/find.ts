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
import type { FindOptions } from '../../vfs/base.ts'
import type { PathSpec } from '../../types.ts'
import {
  emitStartPath,
  keep,
  optionsTree,
  startBasename,
  treeHasEmpty,
} from '../generic/find_eval.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { DIR_SIZE } from '../../utils/stat_view.ts'

function strip(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  return stripSlash(p)
}

export function find(
  accessor: GitHubAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  // A git tree carries no timestamp, so every entry's mtime is unknown, which
  // -mtime excludes: nothing here is ever in the window. Mirrors Python's find.
  if (
    (options.mtimeMin !== null && options.mtimeMin !== undefined) ||
    (options.mtimeMax !== null && options.mtimeMax !== undefined)
  ) {
    return Promise.resolve([])
  }
  const base = strip(path)
  const prefix = base === '' ? '' : `${base}/`
  const baseDepth = base === '' ? 0 : (base.match(/\//g) ?? []).length + 1
  const startName = startBasename(path.virtual)
  const results: string[] = []
  const tree = optionsTree(options)
  const needEmpty = treeHasEmpty(tree)
  let startKind: 'd' | 'f' | null = base === '' ? 'd' : null
  let startSize = 0
  let hasChild = false
  const sortedKeys = Object.keys(accessor.tree).sort(compareCodePoints)
  // Every intermediate folder is itself an entry, so marking direct parents
  // is enough to classify all non-empty directories; a top-level entry's
  // parent is the root, keyed ''.
  const nonEmptyDirs = new Set(
    needEmpty ? sortedKeys.map((k) => (k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : '')) : [],
  )
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
    const size = isDir ? DIR_SIZE : (entry.size ?? 0)
    const isEmpty = needEmpty ? (isDir ? !nonEmptyDirs.has(p) : size === 0) : null
    if (
      !keep(
        { key: fullPath, name: entryName, kind: isDir ? 'd' : 'f', depth, isEmpty },
        tree,
        options.minDepth,
      )
    ) {
      continue
    }
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
      isEmpty: rootKind === 'd' ? !hasChild : startSize === 0,
      exists: true,
      tree,
      maxDepth: options.maxDepth,
      minDepth: options.minDepth,
      size: rootKind === 'f' ? startSize : null,
      minSize: options.minSize,
      maxSize: options.maxSize,
    })
  }
  return Promise.resolve(results.sort(compareCodePoints))
}
