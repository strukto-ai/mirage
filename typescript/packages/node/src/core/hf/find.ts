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

import {
  buildTree,
  emitStartPath,
  type FindOptions,
  keep,
  type PathSpec,
  type PredNode,
  rstripSlash,
  startBasename,
  stripSlash,
} from '@struktoai/mirage-core'
import type { HfAccessor } from '../../accessor/hf.ts'
import { isNotFound, rawPathOf } from './util.ts'

// -mtime is accepted for signature parity but not applied: buckets carry no
// per-object mtime, so filtering would drop everything (matches s3/onedrive).
function matchesFilters(
  entryPath: string,
  kind: 'f' | 'd',
  size: number,
  isEmpty: boolean | null,
  baseDepth: number,
  options: FindOptions,
  tree: PredNode,
): boolean {
  const entryName = entryPath.split('/').pop() ?? ''
  const depth = (entryPath.match(/\//g) ?? []).length - baseDepth
  if (options.maxDepth !== null && options.maxDepth !== undefined && depth > options.maxDepth) {
    return false
  }
  if (!keep({ key: entryPath, name: entryName, kind, depth, isEmpty }, tree, options.minDepth)) {
    return false
  }
  if (options.minSize != null || options.maxSize != null) {
    // Directories count as size 0 for -size (deliberate GNU divergence).
    const effective = kind === 'f' ? size : 0
    if (options.minSize != null && effective < options.minSize) {
      return false
    }
    if (options.maxSize != null && effective > options.maxSize) {
      return false
    }
  }
  return true
}

export async function find(
  accessor: HfAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const target = rawPathOf(path)
  const pfx = stripSlash(target)
  const scanPath = pfx !== '' ? `${pfx}/` : '/'
  const base = pfx !== '' ? `/${pfx}` : '/'
  const baseDepth = base === '/' ? 0 : (base.match(/\//g) ?? []).length
  const startName = startBasename(path.virtual)
  const empty = options.empty === true
  const op = await accessor.operator()
  const results: string[] = []
  const seenDirs = new Set<string>()
  let sawDescendant = false
  let dirExists = false
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
  let entries
  try {
    entries = await op.list(scanPath, { recursive: true })
  } catch (err) {
    if (isNotFound(err)) return []
    throw err
  }
  for (const entry of entries) {
    const rel = entry.path()
    if (rel === '') continue
    const meta = entry.metadata()
    const isDir = rel.endsWith('/') || meta.isDirectory()
    const entryPath = `/${stripSlash(rel)}`
    if (entryPath === base) {
      dirExists = true
      continue
    }
    sawDescendant = true
    const kind: 'f' | 'd' = isDir ? 'd' : 'f'
    const length = meta.contentLength
    const size = length !== null ? Number(length) : 0
    const fileEntries: [string, 'f' | 'd'][] = [[entryPath, kind]]
    if (!isDir) {
      let parent = rstripSlash(entryPath.slice(0, entryPath.lastIndexOf('/'))) || '/'
      while (parent !== '' && parent !== base && parent !== '/') {
        if (!seenDirs.has(parent)) {
          seenDirs.add(parent)
          fileEntries.push([parent, 'd'])
        }
        parent = parent.slice(0, parent.lastIndexOf('/')) || '/'
      }
    }
    for (const [ep, k] of fileEntries) {
      const isEmpty = !empty ? null : k === 'd' ? false : size === 0
      if (matchesFilters(ep, k, size, isEmpty, baseDepth, options, tree)) {
        results.push(ep)
      }
    }
  }
  if (sawDescendant || dirExists) {
    emitStartPath(results, base, startName, {
      kind: 'd',
      isEmpty: !sawDescendant,
      exists: true,
      tree,
      maxDepth: options.maxDepth,
      minDepth: options.minDepth,
      minSize: options.minSize,
      maxSize: options.maxSize,
    })
  }
  return [...new Set(results)].sort()
}
