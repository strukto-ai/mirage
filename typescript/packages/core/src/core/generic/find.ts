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

import { activeCacheManager } from '../../cache/context.ts'
import { isEacces, isEnoent } from '../../errors/fs.ts'
import { isEntryError } from '../../errors/classify.ts'
import {
  bindTree,
  dropPruned,
  optionsTree,
  settlePrunes,
  treeHasEmpty,
  treeHasPrune,
  prunedKeys,
  type FindEntry,
  keep,
  type PredNode,
} from './find_eval.ts'
import { FileType, PathSpec, type FileStat } from '../../types.ts'
import type { LinkView } from '../../view/types.ts'
import { followedStat } from '../../view/namespace_view.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { DIR_SIZE } from '../../utils/stat_view.ts'
import { type PrintfKind, printfKind } from './find_eval.ts'

/** What a find walk filters by: the expression's predicates, parsed. */
export interface FindOptions {
  name?: string | null
  type?: string | null
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

export interface WalkFindDeps {
  readdir: (spec: PathSpec) => Promise<string[]>
  stat: (spec: PathSpec) => Promise<FileStat>
  // The table's stat and readdir see the namespace's links, so a link is an
  // entry like any other, kind `l`. Under -L (`follow`, the links it follows)
  // an entry is what it leads to instead: a link to a directory is walked, a
  // dangling one stays `l` (GNU reports the link when its target cannot be
  // statted), one whose chain loops is an error, and a directory reached
  // again lands in `loops` with the one above it that it repeats, neither a
  // row nor entered.
  follow?: LinkView | null
  loops?: [string, string][]
  // Where a directory the walk could not open (a rule refused it at the
  // guarded readdir) is recorded, as its virtual path: GNU names it and
  // walks on, so a caller that collects those gets the path and the walk
  // continues; one that does not is not left with a silent gap in its
  // listing, the refusal propagates.
  unreadable?: string[]
  // Where an entry the walk could not stat is recorded, with its error, in
  // walk order: GNU's find names it and carries on, and the entry stays in
  // the walk unclassified, a leaf, as a missing one already does, that
  // fails every test only its stat could answer. It is never statted
  // again. A caller that does not collect them gets the failure
  // propagated instead.
  unstatted?: Map<string, unknown>
  // -xdev's test of a directory's virtual path: one it fails is an entry
  // still, and -empty still reads it, but the walk does not descend.
  enters?: (virtual: string) => boolean
  // The walk's own listing of a directory, where the caller bounds it;
  // absent lists with `readdir`, which -empty still reads.
  listing?: (spec: PathSpec) => Promise<string[]>
}

interface WalkEntry {
  path: string
  depth: number
  file: boolean
  // What -type tests: the stat's own kind (a device is `c`), `d` for a
  // directory a trailing slash proves.
  kind: PrintfKind
}

export function modifiedTs(modified: string | null): number | null {
  // Naive timestamps are UTC, mirroring the Python implementation.
  if (modified === null || modified === '') return null
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(modified)
  const iso = hasTz ? modified : modified.includes(':') ? `${modified}Z` : `${modified}T00:00:00Z`
  const ts = Date.parse(iso) / 1000
  return Number.isNaN(ts) ? null : ts
}

async function statEntry(deps: WalkFindDeps, path: string): Promise<FileStat | null> {
  const spec = new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    vfsPath: stripSlash(path),
  })
  if (deps.unstatted?.has(path) === true) return null
  try {
    const row = await deps.stat(spec)
    const size =
      row.type === FileType.FILE && row.size === null
        ? await activeCacheManager()?.cachedSize(spec)
        : null
    return size == null ? row : row.with({ size })
  } catch (err) {
    // Missing entries resolve to null. Any other failure does too when the
    // caller collects it; otherwise it (a rate limit, an auth failure)
    // propagates.
    if (isEnoent(err)) return null
    if (deps.unstatted === undefined || !isEntryError(err)) throw err
    deps.unstatted.set(path, err)
    return null
  }
}

async function isEmptyEntry(deps: WalkFindDeps, path: string, isDir: boolean): Promise<boolean> {
  if (isDir) {
    const spec = new PathSpec({
      virtual: path,
      directory: path,
      resolved: false,
      vfsPath: stripSlash(path),
    })
    try {
      return (await deps.readdir(spec)).length === 0
    } catch (err) {
      if (isEnoent(err)) return false
      if (isEacces(err) && deps.unreadable !== undefined) {
        if (!deps.unreadable.includes(path)) deps.unreadable.push(path)
        return false
      }
      throw err
    }
  }
  const st = await statEntry(deps, path)
  return st !== null && st.type === FileType.FILE && st.size === 0
}

async function walk(
  deps: WalkFindDeps,
  spec: PathSpec,
  maxDepth: number | null,
  depth: number,
  out: WalkEntry[],
  chain: readonly (readonly [string, string])[] = [],
): Promise<void> {
  if (maxDepth !== null && depth > maxDepth) return
  let children: string[]
  try {
    children = await deps.readdir(spec)
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
    let kind: PrintfKind = 'd'
    if (!child.endsWith('/')) {
      const s = await statEntry(deps, trimmed)
      kind = s === null ? 'f' : printfKind(s)
    }
    const isFolder = kind === 'd'
    let below = chain
    if (isFolder && deps.follow != null) {
      // Under -L a directory is the one it resolves to, and one already open
      // above is GNU's file system loop: never a row, never entered.
      const here = deps.follow.resolve(trimmed)
      const ancestor = chain.find(([, real]) => real === here)
      if (ancestor !== undefined) {
        deps.loops?.push([trimmed, ancestor[0]])
        continue
      }
      below = [...chain, [trimmed, here] as const]
    }
    out.push({ path: trimmed, depth, file: !isFolder, kind })
    if (!isFolder) continue
    const childSpec = new PathSpec({
      virtual: trimmed,
      directory: trimmed,
      resolved: false,
      vfsPath: stripSlash(trimmed),
    })
    await walk(deps, childSpec, maxDepth, depth + 1, out, below)
  }
}

export async function walkFind(
  path: PathSpec,
  found: WalkFindDeps,
  options: FindOptions = {},
): Promise<string[]> {
  const links = found.follow
  const deps: WalkFindDeps = {
    ...found,
    stat: (spec) => followedStat((p: PathSpec) => found.stat(p), links, spec),
  }
  const collected: WalkEntry[] = []
  // GNU lists the search root itself at depth 0 (even for the mount
  // root), so `-maxdepth 0` prints just the root and `-name` can match
  // the root's own basename.
  const rootPath = path.virtual !== '/' ? rstripSlash(path.virtual) : '/'
  const pruneTree = bindTree(optionsTree(options), '', path.virtual, path.rawPath)
  const readDirectory = async (spec: PathSpec): Promise<string[]> => {
    if (deps.enters !== undefined && !deps.enters(spec.virtual)) return []
    if (treeHasPrune(pruneTree)) {
      const key = rstripSlash(spec.virtual) || '/'
      const depth =
        rstripSlash(spec.virtual).split('/').length - rstripSlash(rootPath).split('/').length
      const info = await statEntry(deps, spec.virtual)
      const isEmpty = treeHasEmpty(pruneTree) ? await isEmptyEntry(deps, spec.virtual, true) : null
      keep(
        {
          key,
          name: rstripSlash(spec.virtual).split('/').pop() ?? '',
          kind: 'd',
          depth,
          isEmpty,
          mtime: info === null ? null : modifiedTs(info.modified),
        },
        pruneTree,
        options.minDepth,
      )
      if (prunedKeys(pruneTree).includes(key)) return []
    }
    return (deps.listing ?? deps.readdir)(spec)
  }
  let rootStat: FileStat | null = null
  try {
    rootStat = await deps.stat(path)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  if (rootStat !== null) {
    collected.push({
      path: rootPath,
      depth: 0,
      file: rootStat.type !== FileType.DIRECTORY,
      kind: printfKind(rootStat),
    })
  }
  // GNU depth convention: the search root is depth 0, its children are
  // depth 1, so the walk starts at 1 and -maxdepth 0 descends nowhere. A
  // start point that is not a directory has no children, so readdir on it
  // is either an error the walk would have to swallow (Box answers
  // ENOTDIR) or a wasted round trip everywhere else.
  if (rootStat === null || rootStat.type === FileType.DIRECTORY) {
    await walk(
      { ...deps, readdir: readDirectory },
      path,
      options.maxDepth ?? null,
      1,
      collected,
      links != null ? [[rootPath, links.resolve(rootPath)]] : [],
    )
  }
  const results: string[] = []
  const tree = bindTree(optionsTree(options), '', path.virtual, path.rawPath)
  const needEmpty = treeHasEmpty(tree)
  const needSize = options.minSize != null || options.maxSize != null
  const needMtime = options.mtimeMin != null || options.mtimeMax != null
  const learned = new Map<string, number | null>()
  collected.sort((a, b) => compareCodePoints(a.path, b.path))
  for (const entry of collected) {
    const name = entry.path.split('/').pop() ?? ''
    const key = entry.path === '' ? '/' : entry.path
    let isEmpty: boolean | null = null
    if (needEmpty) {
      isEmpty = await isEmptyEntry(deps, entry.path, !entry.file)
    }
    // With a time test in the tree the stat comes first, so the entry
    // answers the test itself and a -prune after it fires only where GNU's
    // would; the stat that -size alone needs waits for the rows the tree
    // kept.
    let st: FileStat | null = null
    if (needMtime) {
      st = await statEntry(deps, entry.path)
      if (st === null) continue
      learned.set(key, modifiedTs(st.modified))
    }
    const findEntry: FindEntry = {
      key,
      name,
      kind: entry.kind,
      depth: entry.depth,
      isEmpty,
      mtime: learned.get(key) ?? null,
    }
    if (!keep(findEntry, tree, options.minDepth)) continue
    if (needSize && entry.file && st === null) {
      st = await statEntry(deps, entry.path)
      if (st === null) continue
    }
    if (needSize) {
      const size = entry.file ? (st?.size ?? 0) : DIR_SIZE
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
  settlePrunes(tree, learned)
  return dropPruned(results, tree)
}
