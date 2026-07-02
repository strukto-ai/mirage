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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../../resource/base.ts'
import { buildTree, type FindEntry, keep } from '../../commands/builtin/findEval.ts'
import { FileType, PathSpec, type FileStat } from '../../types.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'

export interface WalkFindDeps {
  readdir: (spec: PathSpec, index?: IndexCacheStore) => Promise<string[]>
  stat: (spec: PathSpec, index?: IndexCacheStore) => Promise<FileStat>
  isDirName: (child: string) => boolean | null
}

interface WalkEntry {
  path: string
  depth: number
  file: boolean
}

export function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === 'ENOENT'
}

export function modifiedTs(modified: string | null): number | null {
  // Naive timestamps are UTC, mirroring the Python implementation.
  if (modified === null || modified === '') return null
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(modified)
  const iso = hasTz ? modified : modified.includes(':') ? `${modified}Z` : `${modified}T00:00:00Z`
  const ts = Date.parse(iso) / 1000
  return Number.isNaN(ts) ? null : ts
}

async function statEntry(
  deps: WalkFindDeps,
  path: string,
  prefix: string,
  index: IndexCacheStore | undefined,
): Promise<FileStat | null> {
  const spec = new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    resourcePath: mountKey(path, prefix),
  })
  try {
    return await deps.stat(spec, index)
  } catch (err) {
    // Only missing entries resolve to null; API errors (rate limit, auth) propagate.
    if (isEnoent(err)) return null
    throw err
  }
}

async function walk(
  deps: WalkFindDeps,
  spec: PathSpec,
  index: IndexCacheStore | undefined,
  maxDepth: number | null,
  depth: number,
  out: WalkEntry[],
): Promise<void> {
  if (maxDepth !== null && depth > maxDepth) return
  let children: string[]
  try {
    children = await deps.readdir(spec, index)
  } catch (err) {
    if (isEnoent(err)) return
    throw err
  }
  for (const child of children) {
    const hint = deps.isDirName(child)
    const trimmed = child.endsWith('/') ? rstripSlash(child) : child
    let isFolder: boolean
    if (hint === null) {
      // Warm index-cache entries carry no trailing slash, so fall back to stat.
      const s = await statEntry(
        deps,
        trimmed,
        mountPrefixOf(spec.virtual, spec.resourcePath),
        index,
      )
      isFolder = s !== null && s.type === FileType.DIRECTORY
    } else {
      isFolder = hint
    }
    out.push({ path: trimmed, depth, file: !isFolder })
    if (isFolder) {
      const childSpec = new PathSpec({
        virtual: trimmed,
        directory: trimmed,
        resolved: false,
        resourcePath: mountKey(trimmed, mountPrefixOf(spec.virtual, spec.resourcePath)),
      })
      await walk(deps, childSpec, index, maxDepth, depth + 1, out)
    }
  }
}

export async function walkFind(
  path: PathSpec,
  deps: WalkFindDeps,
  options: FindOptions = {},
  index?: IndexCacheStore,
): Promise<string[]> {
  const collected: WalkEntry[] = []
  // GNU depth convention: the search root is depth 0, its children are
  // depth 1, so the walk starts at 1 and -maxdepth 0 lists nothing.
  await walk(deps, path, index, options.maxDepth ?? null, 1, collected)
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
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
  const searchKey = stripSlash(path.mountPath)
  if (searchKey !== '' && (options.maxDepth == null || options.maxDepth >= 0)) {
    let rootStat: FileStat | null = null
    try {
      rootStat = await deps.stat(path, index)
    } catch (err) {
      if (!isEnoent(err)) throw err
    }
    if (rootStat !== null) {
      const rootPath = prefix !== '' ? `${prefix}/${searchKey}` : `/${searchKey}`
      collected.push({ path: rootPath, depth: 0, file: rootStat.type !== FileType.DIRECTORY })
    }
  }
  collected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const entry of collected) {
    const name = entry.path.split('/').pop() ?? ''
    const key =
      prefix !== '' && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path
    const findEntry: FindEntry = {
      key,
      name,
      kind: entry.file ? 'f' : 'd',
      depth: entry.depth,
    }
    if (!keep(findEntry, tree, options.minDepth)) continue
    const needSize = entry.file && (options.minSize != null || options.maxSize != null)
    const needMtime = options.mtimeMin != null || options.mtimeMax != null
    if (needSize || needMtime) {
      const st = await statEntry(deps, entry.path, prefix, index)
      if (st === null) continue
      if (needSize) {
        const size = st.size ?? 0
        if (options.minSize != null && size < options.minSize) continue
        if (options.maxSize != null && size > options.maxSize) continue
      }
      if (needMtime) {
        const mt = modifiedTs(st.modified)
        if (mt === null) continue
        if (options.mtimeMin != null && mt < options.mtimeMin) continue
        if (options.mtimeMax != null && mt > options.mtimeMax) continue
      }
    }
    results.push(key)
  }
  return results
}
