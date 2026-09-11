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

import { isEacces, isEnoent } from '../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../../resource/base.ts'
import {
  buildTree,
  hasLinkChildren,
  optionsTree,
  prefixPathNodes,
  startBasename,
  treeHasEmpty,
  treeHasType,
  type FindEntry,
  type PredNode,
  keep,
} from '../../commands/builtin/find_eval.ts'
import { FileType, PathSpec, type FileStat } from '../../types.ts'
import type { LinkView } from '../../ops/types.ts'
import { lstripSlash, rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'

export interface WalkFindDeps {
  readdir: (spec: PathSpec, index?: IndexCacheStore) => Promise<string[]>
  stat: (spec: PathSpec, index?: IndexCacheStore) => Promise<FileStat>
  // `-empty` asks whether a directory has entries, and a namespace symlink
  // is one that no backend readdir can see. Without this a directory
  // holding only a link reads as empty.
  links?: LinkView | null
  // Where a directory the walk could not open (a rule refused it at the
  // guarded readdir) is recorded, as its virtual path: GNU names it and
  // walks on, so a caller that collects those gets the path and the walk
  // continues; one that does not is not left with a silent gap in its
  // listing, the refusal propagates.
  unreadable?: string[]
}

interface WalkEntry {
  path: string
  depth: number
  file: boolean
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

async function isEmptyEntry(
  deps: WalkFindDeps,
  path: string,
  isDir: boolean,
  prefix: string,
  index: IndexCacheStore | undefined,
): Promise<boolean> {
  if (isDir) {
    if (hasLinkChildren(deps.links, path)) return false
    const spec = new PathSpec({
      virtual: path,
      directory: path,
      resolved: false,
      resourcePath: mountKey(path, prefix),
    })
    try {
      return (await deps.readdir(spec, index)).length === 0
    } catch (err) {
      if (isEnoent(err)) return false
      throw err
    }
  }
  const st = await statEntry(deps, path, prefix, index)
  return st !== null && (st.size ?? 0) === 0
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
    if (isEacces(err) && deps.unreadable !== undefined) {
      deps.unreadable.push(spec.virtual)
      return
    }
    throw err
  }
  for (const child of children) {
    // Classification is stat's job (an index lookup right after the readdir
    // that populated it). The one in-band proof is a trailing slash on a
    // cold listing: no backend renders a file with one. Name heuristics
    // beyond that guessed wrong (attachments and uploads carry whatever
    // name the sender gave them) and are gone.
    const trimmed = child.endsWith('/') ? rstripSlash(child) : child
    let isFolder: boolean
    if (child.endsWith('/')) {
      isFolder = true
    } else {
      const s = await statEntry(
        deps,
        trimmed,
        mountPrefixOf(spec.virtual, spec.resourcePath),
        index,
      )
      isFolder = s !== null && s.type === FileType.DIRECTORY
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
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  // GNU lists the search root itself at depth 0 (even for the mount
  // root), so `-maxdepth 0` prints just the root and `-name` can match
  // the root's own basename.
  const rootPath = path.virtual !== '/' ? rstripSlash(path.virtual) : '/'
  let rootStat: FileStat | null = null
  try {
    rootStat = await deps.stat(path, index)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  if (rootStat !== null) {
    collected.push({ path: rootPath, depth: 0, file: rootStat.type !== FileType.DIRECTORY })
  }
  // GNU depth convention: the search root is depth 0, its children are
  // depth 1, so the walk starts at 1 and -maxdepth 0 descends nowhere. A
  // start point that is not a directory has no children, so readdir on it
  // is either an error the walk would have to swallow (Box answers
  // ENOTDIR) or a wasted round trip everywhere else.
  if (rootStat === null || rootStat.type === FileType.DIRECTORY) {
    await walk(deps, path, index, options.maxDepth ?? null, 1, collected)
  }
  const results: string[] = []
  const tree = prefixPathNodes(optionsTree(options), prefix)
  const needEmpty = treeHasEmpty(tree)
  collected.sort((a, b) => compareCodePoints(a.path, b.path))
  for (const entry of collected) {
    const name = entry.path.split('/').pop() ?? ''
    const stripped =
      prefix !== '' && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path
    // The mount root strips to ''; its mount-relative key is '/'.
    const key = stripped === '' ? '/' : stripped
    let isEmpty: boolean | null = null
    if (needEmpty) {
      isEmpty = await isEmptyEntry(deps, entry.path, !entry.file, prefix, index)
    }
    const findEntry: FindEntry = {
      key,
      name,
      kind: entry.file ? 'f' : 'd',
      depth: entry.depth,
      isEmpty,
    }
    if (!keep(findEntry, tree, options.minDepth)) continue
    const needSize = options.minSize != null || options.maxSize != null
    const needMtime = options.mtimeMin != null || options.mtimeMax != null
    let st: FileStat | null = null
    if ((needSize && entry.file) || needMtime) {
      st = await statEntry(deps, entry.path, prefix, index)
      if (st === null) continue
    }
    if (needSize) {
      // Directories count as size 0 for -size: GNU compares the inode size (e.g. 4096 on ext4); see CLAUDE.md Rules.
      const size = entry.file ? (st?.size ?? 0) : 0
      if (options.minSize != null && size < options.minSize) continue
      if (options.maxSize != null && size > options.maxSize) continue
    }
    if (needMtime && st !== null) {
      const mt = modifiedTs(st.modified)
      if (mt === null) continue
      if (options.mtimeMin != null && mt < options.mtimeMin) continue
      if (options.mtimeMax != null && mt > options.mtimeMax) continue
    }
    results.push(key)
  }
  return results
}

export interface SearchFindDeps<A> {
  resolvePath: (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<{ isDir: boolean }>
  stat: (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<FileStat>
  walk: (
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
    options?: { includeRoot?: boolean; maxDepth?: number | null; stripPrefix?: boolean },
  ) => Promise<string[]>
}

function searchRelativeDepth(item: string, root: string): number {
  const rootNorm = rstripSlash(root) !== '' ? rstripSlash(root) : '/'
  const itemNorm = rstripSlash(item) !== '' ? rstripSlash(item) : '/'
  if (itemNorm === rootNorm) return 0
  let relative: string
  if (rootNorm === '/') {
    relative = stripSlash(itemNorm)
  } else {
    relative = itemNorm.startsWith(rootNorm) ? itemNorm.slice(rootNorm.length) : itemNorm
    relative = lstripSlash(relative)
  }
  if (relative === '') return 0
  return relative.split('/').length
}

async function searchMatches<A>(
  deps: SearchFindDeps<A>,
  accessor: A,
  item: string,
  prefix: string,
  index: IndexCacheStore | undefined,
  root: string,
  options: FindOptions,
  tree: PredNode,
  needsKind: boolean,
  startName: string,
  allItems: readonly string[],
): Promise<boolean> {
  const rootNorm = rstripSlash(root) !== '' ? rstripSlash(root) : '/'
  const itemNorm = rstripSlash(item) !== '' ? rstripSlash(item) : '/'
  const itemName = itemNorm === rootNorm ? startName : (rstripSlash(item).split('/').pop() ?? '')
  // The walk strips its mount prefix; backend probes still need both paths.
  const virtual = rstripSlash(rstripSlash(prefix) + '/' + lstripSlash(item)) || '/'
  const spec = PathSpec.fromStrPath(virtual, lstripSlash(item))
  let kind: 'd' | 'f' = 'f'
  if (needsKind) {
    const resolved = await deps.resolvePath(accessor, spec, index)
    kind = resolved.isDir ? 'd' : 'f'
  }
  let itemStat: FileStat | null = null
  // -empty answers off the walked list, not a readdir: the whole subtree
  // arrived in one `walk`, so a directory is empty exactly when no other
  // walked key sits under it. `walkFind` has to ask readdir instead,
  // because it drives its own traversal.
  let isEmpty: boolean | null = null
  if (treeHasEmpty(tree)) {
    if (kind === 'd') {
      const childPrefix = rstripSlash(item) + '/'
      isEmpty = !allItems.some((other) => other !== item && other.startsWith(childPrefix))
    } else {
      itemStat = await deps.stat(accessor, spec, index)
      isEmpty = (itemStat.size ?? 0) === 0
    }
  }
  const entry: FindEntry = {
    key: item,
    name: itemName,
    kind,
    depth: searchRelativeDepth(item, root),
    isEmpty,
  }
  if (!keep(entry, tree, options.minDepth)) return false
  // Directories count as size 0 for -size (deliberate GNU divergence).
  if (options.minSize != null || options.maxSize != null) {
    let size = 0
    if (kind === 'f') {
      itemStat ??= await deps.stat(accessor, spec, index)
      // Sizeless rendered files count as size 0, same as dirs and the FUSE
      // view (CLAUDE.md find -size rules); never drop them.
      size = itemStat.size ?? 0
    }
    if (options.minSize != null && size < options.minSize) return false
    if (options.maxSize != null && size > options.maxSize) return false
  }
  if (options.mtimeMin != null || options.mtimeMax != null) {
    itemStat ??= await deps.stat(accessor, spec, index)
    const modTs = modifiedTs(itemStat.modified)
    if (modTs === null) return false
    if (options.mtimeMin != null && modTs < options.mtimeMin) return false
    if (options.mtimeMax != null && modTs > options.mtimeMax) return false
  }
  return true
}

/**
 * Build `find` for a backend whose walk comes from a search index.
 *
 * The search-backed backends (chroma, dify) get the whole subtree from
 * one `walk` call and then filter it, where the API backends drive the
 * traversal themselves through `walkFind`'s `readdir`. That is the only
 * difference between them, so everything after the walk lives here once
 * rather than once per backend. Mirrors python's
 * `mirage/core/generic/find.py`.
 */
export function makeSearchBackedFind<A>(
  deps: SearchFindDeps<A>,
): (
  accessor: A,
  path: PathSpec,
  options?: FindOptions,
  index?: IndexCacheStore,
) => Promise<string[]> {
  return async (accessor, path, options = {}, index) => {
    if (index === undefined) {
      throw new Error('find: missing index')
    }
    const results = await deps.walk(accessor, path, index, {
      includeRoot: true,
      maxDepth: options.maxDepth ?? null,
      stripPrefix: true,
    })
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
    const needsKind =
      treeHasType(tree) || options.minSize != null || options.maxSize != null || treeHasEmpty(tree)
    const startName = startBasename(path.virtual)
    const filtered: string[] = []
    for (const item of results) {
      if (
        await searchMatches(
          deps,
          accessor,
          item,
          mountPrefixOf(path.virtual, path.resourcePath),
          index,
          path.mountPath,
          options,
          tree,
          needsKind,
          startName,
          results,
        )
      ) {
        filtered.push(item)
      }
    }
    return filtered.sort(compareCodePoints)
  }
}
