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

interface CandidateMeta {
  size: number
  mtime: number | null
}

function matchesFilters(
  entryPath: string,
  kind: 'f' | 'd',
  meta: CandidateMeta,
  baseDepth: number,
  options: FindOptions,
  tree: PredNode,
): boolean {
  const entryName = entryPath.split('/').pop() ?? ''
  const depth = (entryPath.match(/\//g) ?? []).length - baseDepth
  if (options.maxDepth !== null && options.maxDepth !== undefined && depth > options.maxDepth) {
    return false
  }
  if (!keep({ key: entryPath, name: entryName, kind, depth }, tree, options.minDepth)) {
    return false
  }
  if (kind === 'f' && (options.minSize !== null || options.maxSize !== null)) {
    if (options.minSize !== null && options.minSize !== undefined && meta.size < options.minSize) {
      return false
    }
    if (options.maxSize !== null && options.maxSize !== undefined && meta.size > options.maxSize) {
      return false
    }
  }
  if (
    (options.mtimeMin !== null && options.mtimeMin !== undefined) ||
    (options.mtimeMax !== null && options.mtimeMax !== undefined)
  ) {
    if (meta.mtime === null) return false
    if (
      options.mtimeMin !== null &&
      options.mtimeMin !== undefined &&
      meta.mtime < options.mtimeMin
    ) {
      return false
    }
    if (
      options.mtimeMax !== null &&
      options.mtimeMax !== undefined &&
      meta.mtime > options.mtimeMax
    ) {
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
  const startName = startBasename(path.original)
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
    const lm = meta.lastModified
    const candidateMeta: CandidateMeta = {
      size: length !== null ? Number(length) : 0,
      mtime: lm !== null ? Date.parse(lm) / 1000 : null,
    }
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
      if (matchesFilters(ep, k, candidateMeta, baseDepth, options, tree)) {
        results.push(ep)
      }
    }
  }
  if (sawDescendant || dirExists) {
    emitStartPath(results, base, startName, {
      kind: 'd',
      isEmpty: null,
      exists: true,
      tree,
      maxDepth: options.maxDepth,
      minDepth: options.minDepth,
    })
  }
  return [...new Set(results)].sort()
}
