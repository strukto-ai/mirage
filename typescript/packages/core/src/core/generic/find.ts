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
import { isEntryError } from '../../errors/classify.ts'
import { isEacces, isEnoent } from '../../errors/fs.ts'
import { FileType, PathSpec, type FileStat } from '../../types.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { inMtimeWindow } from '../../utils/dates.ts'
import { DIR_SIZE } from '../../utils/stat_view.ts'
import { followedStat } from '../../view/namespace_view.ts'
import type { LinkView } from '../../view/types.ts'
import {
  bindTree,
  keep,
  argsToTree,
  primeRegexes,
  printfKind,
  prunedKeys,
  quitFired,
  treeHas,
  treeHasAction,
  treeHasEmpty,
  treeHasPrune,
  treeHasTime,
  treeReadsLink,
  treeReadsStat,
  timeTestsFailing,
} from './find_eval.ts'
import { type FindEntry, type PredNode, type PrintfKind } from './types.ts'

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
  depthFirst?: boolean | null
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
  // The namespace's links whether or not the walk follows them, which
  // -xtype reads past.
  links?: LinkView | null
  // Receives the entry a -quit was reached on; the walk evaluates nothing
  // after it.
  stopped?: string[]
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
        ? (await activeCacheManager()?.cachedSizes([spec]))?.[0]
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

/**
 * Walk readdir/stat under one start point, yielding each entry the
 * expression keeps as the walk reaches it. A directory's entries are visited
 * in name order, where findutils takes them in the order the directory lists
 * them, so the rows come in a tree walk's order: a directory, then what it
 * holds, or under -depth what it holds, then the directory. Each
 * entry is judged once, when it is reached: a -prune keeps the walk out of
 * the directory it holds for, a -quit ends the walk, and a reader that stops
 * reading stops the walk with it.
 */
export async function* walkFind(
  path: PathSpec,
  found: WalkFindDeps,
  options: FindOptions = {},
): AsyncGenerator<string> {
  const links = found.follow
  const deps: WalkFindDeps = {
    ...found,
    stat: (spec) => followedStat((p: PathSpec) => found.stat(p), links, spec),
  }
  // GNU lists the search root itself at depth 0 (even for the mount
  // root), so `-maxdepth 0` prints just the root and `-name` can match
  // the root's own basename.
  const rootPath = path.virtual !== '/' ? rstripSlash(path.virtual) : '/'
  const tree = bindTree(argsToTree(options), '', path.virtual, path.rawPath)
  const prunes = treeHasPrune(tree)
  const quits = treeHas(tree, ['quit'])
  const regexes = treeHas(tree, ['regex'])
  const needEmpty = treeHasEmpty(tree)
  const acts = treeHasAction(tree)
  const needSize = options.minSize != null || options.maxSize != null
  const windowed = options.mtimeMin != null || options.mtimeMax != null
  const needMtime = windowed || treeHasTime(tree)
  const needStat = needMtime || treeReadsStat(tree)
  const needLink = treeReadsLink(tree)
  const failing = timeTestsFailing(tree)
  // Set once a -quit is reached; the walk judges nothing after it.
  let quit = false
  const quitted = (): boolean => quit
  const judge = async (
    p: string,
    kind: PrintfKind,
    depth: number,
    known: FileStat | null,
  ): Promise<boolean> => {
    const isDir = kind === 'd'
    const isEmpty = needEmpty ? await isEmptyEntry(deps, p, isDir) : null
    // With a time test in the tree the stat comes first, so the entry answers
    // the test itself; the stat that -size alone needs waits for the entries
    // the tree kept.
    let st: FileStat | null = null
    let mtime: number | null = null
    if (needStat) {
      st = known ?? (await statEntry(deps, p))
      if (st === null && windowed) return false
      // A failed stat leaves the time unknown, which fails every time test,
      // so another -o arm (-name) can still match the entry.
      mtime = st !== null ? modifiedTs(st.modified) : null
    }
    const [xkind, target] = needLink
      ? await otherSide(links ?? null, found.links ?? null, p, kind)
      : [null, null]
    if (regexes) await primeRegexes(tree, [p])
    const entry: FindEntry = {
      key: p,
      name: p.split('/').pop() ?? '',
      kind,
      depth,
      isEmpty,
      mtime,
      stat: st,
      xkind,
      target,
    }
    const judged = needMtime && mtime === null ? failing : tree
    const kept = keep(entry, judged, options.minDepth, acts)
    if (quits && quitFired(judged)) {
      quit = true
      found.stopped?.push(p)
      return kept
    }
    if (!kept) return false
    if (needSize && !isDir && st === null) {
      st = await statEntry(deps, p)
      if (st === null) return false
    }
    if (needSize && !sized(options, isDir ? DIR_SIZE : (st?.size ?? 0))) return false
    return st === null || inMtimeWindow(modifiedTs(st.modified), options.mtimeMin, options.mtimeMax)
  }
  // The names a directory the walk enters holds, in name order.
  const entries = async (p: string, depth: number): Promise<string[]> => {
    if (
      (options.maxDepth != null && depth >= options.maxDepth) ||
      (deps.enters !== undefined && !deps.enters(p)) ||
      (prunes && prunedKeys(tree).includes(p))
    )
      return []
    const spec = new PathSpec({ virtual: p, directory: p, resolved: false, vfsPath: stripSlash(p) })
    let children: string[]
    try {
      children = await (deps.listing ?? deps.readdir)(spec)
    } catch (err) {
      if (isEnoent(err)) return []
      if (isEacces(err) && deps.unreadable !== undefined) {
        if (!deps.unreadable.includes(p)) deps.unreadable.push(p)
        return []
      }
      throw err
    }
    return [...children].sort((a, b) => compareCodePoints(rstripSlash(a), rstripSlash(b)))
  }
  let start: FileStat | null = null
  try {
    start = await deps.stat(path)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  const chain: readonly (readonly [string, string])[] =
    links != null ? [[rootPath, links.resolve(rootPath)]] : []
  // Each open directory: its path, depth, the -L chain above it, the entries
  // left to visit, whether it is judged itself (a start point that could not
  // be statted reports only what it holds), and its stat when known.
  const frames: {
    path: string
    depth: number
    chain: readonly (readonly [string, string])[]
    left: string[]
    judged: boolean
    known: FileStat | null
  }[] = []
  // find's depth convention: the search root is depth 0, its children are depth
  // 1. A start point that is not a directory has no children, so readdir on
  // it is either an error the walk would have to swallow (Box answers
  // ENOTDIR) or a wasted round trip everywhere else.
  if (start === null) {
    const left = (await entries(rootPath, 0)).reverse()
    frames.push({ path: rootPath, depth: 0, chain, left, judged: false, known: null })
  } else {
    const kind = printfKind(start)
    const first = options.depthFirst !== true || kind !== 'd'
    if (first && (await judge(rootPath, kind, 0, start))) yield rootPath
    if (kind === 'd' && !quitted()) {
      const left = (await entries(rootPath, 0)).reverse()
      frames.push({ path: rootPath, depth: 0, chain, left, judged: true, known: start })
    }
  }
  while (frames.length > 0 && !quitted()) {
    const frame = frames[frames.length - 1]
    if (frame === undefined) break
    const child = frame.left.pop()
    if (child === undefined) {
      frames.pop()
      if (
        options.depthFirst === true &&
        frame.judged &&
        (await judge(frame.path, 'd', frame.depth, frame.known))
      )
        yield frame.path
      continue
    }
    // Classification is stat's job (an index lookup right after the readdir
    // that populated it). The one in-band proof is a trailing slash on a cold
    // listing: no backend renders a file with one.
    const trimmed = child.endsWith('/') ? rstripSlash(child) : child
    let kind: PrintfKind = 'd'
    if (!child.endsWith('/')) {
      const s = await statEntry(deps, trimmed)
      kind = s === null ? 'f' : printfKind(s)
    }
    let inner = frame.chain
    if (kind === 'd' && links != null) {
      // Under -L a directory is the one it resolves to, and one already open
      // above is find's file system loop: never a row, never entered.
      const here = links.resolve(trimmed)
      const ancestor = frame.chain.find(([, real]) => real === here)
      if (ancestor !== undefined) {
        deps.loops?.push([trimmed, ancestor[0]])
        continue
      }
      inner = [...frame.chain, [trimmed, here] as const]
    }
    const depth = frame.depth + 1
    const first = options.depthFirst !== true || kind !== 'd'
    if (first && (await judge(trimmed, kind, depth, null))) yield trimmed
    if (kind === 'd' && !quitted()) {
      const left = (await entries(trimmed, depth)).reverse()
      frames.push({ path: trimmed, depth, chain: inner, left, judged: true, known: null })
    }
  }
}

/**
 * The reference's `-depth` order over sorted siblings: a directory's contents, each
 * sorted, then the directory. The final component is flagged so a path
 * sorts after its descendants, whose entry at that depth carries the same
 * name unflagged. A start point spelled with a trailing slash prints as
 * `d/` while its descendants print as `d/a`, so the slash is dropped
 * before splitting: kept, it would leave an empty final component that
 * sorts the directory ahead of everything under it, which is the one
 * order `-delete` cannot remove a tree in.
 */
export function compareDepthFirst(a: string, b: string): number {
  const pa = rstripSlash(a).split('/')
  const pb = rstripSlash(b).split('/')
  const n = Math.min(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const byName = compareCodePoints(pa[i] ?? '', pb[i] ?? '')
    if (byName !== 0) return byName
    const fa = i === pa.length - 1 ? 1 : 0
    const fb = i === pb.length - 1 ? 1 : 0
    if (fa !== fb) return fa - fb
  }
  return pa.length - pb.length
}

// Whether a size falls inside -size's window.
function sized(options: FindOptions, size: number): boolean {
  return !(
    (options.minSize != null && size < options.minSize) ||
    (options.maxSize != null && size > options.maxSize)
  )
}

// -xtype's kind for one entry and the stat of what a live link the walk keeps
// leads to: such a link is what it leads to (`l` when it leads nowhere), a
// link the walk followed is `l`, and anything else is its own kind.
async function otherSide(
  follow: LinkView | null,
  links: LinkView | null,
  path: string,
  kind: string,
): Promise<[string, FileStat | null]> {
  const view = follow ?? links
  if (view === null) return [kind, null]
  if (follow !== null) return [view.statAt(path) !== null ? 'l' : kind, null]
  if (kind !== 'l') return [kind, null]
  let target: FileStat | null
  try {
    target = await view.targetStat(path)
  } catch (err) {
    // A link whose chain fails to resolve leads nowhere.
    if (!isEntryError(err)) throw err
    console.debug(`find: link ${path} leads nowhere: ${String(err)}`)
    return ['l', null]
  }
  return target !== null ? [printfKind(target), target] : ['l', null]
}
