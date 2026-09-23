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

import { fnmatch } from '../../utils/fnmatch.ts'
import { inMtimeWindow } from '../../utils/dates.ts'
import type { LinkView } from '../../ops/types.ts'
import { respellOne } from '../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import type { RowActionKind } from './types.ts'

export interface FindEntry {
  key: string
  name: string
  // 'l' is a namespace symlink: GNU find without -L reports the link
  // itself and never walks through it, so it is never 'f' or 'd'.
  kind: 'f' | 'd' | 'l' | 'c'
  depth: number
  isEmpty?: boolean | null
  mtime?: number | null
}

export type ActionKind = RowActionKind | 'exec' | 'printf'

// `-mtime`, `-newermt` and a resolved `-newer`: an inclusive epoch-second
// window over the entry's modification time. The same bounds fold into the
// expression's flat window (`FindExpr.mtimeMin`/`mtimeMax`), which is what a
// backend pushes down and the generic post-filters with, so an entry whose
// mtime the walk did not fetch passes here and meets the window afterwards.
// The node's own job is its position: a `-prune` after it fires only for a
// directory the test holds for, and one before it fires regardless, as GNU
// orders them. A prune reached past an undecided test is recorded as
// pending for the caller to settle once it has statted the directory.
export interface MtimeNode {
  op: 'mtime'
  lo: number | null
  hi: number | null
}

// A directory whose `-prune` decision waited on time tests the walk could
// not decide: a prune reached past one, or every prune skipped on the
// strength of one (`-mtime 1 -o -prune`). The entry is kept whole: whether
// the prune stands is settled by evaluating the expression again with the
// directory's mtime, since a failing test may send GNU down another arm
// that prunes anyway (`( -mtime 1 -o -type d ) -prune`).
export interface PendingPrune {
  entry: FindEntry
}

export type PredNode =
  | { op: 'name'; pattern: string; icase: boolean }
  // `-path` matches the row as `find` prints it: the mount prefix plus the
  // entry's key, respelled under the operand as typed (`find . -path
  // ./skip` prints and matches `./skip`), so `bindTree` stamps all three
  // onto the node before evaluation and entry keys stay mount-relative
  // (#396). An empty `root` leaves the row as the display path.
  | { op: 'path'; pattern: string; prefix?: string; root?: string; raw?: string }
  | { op: 'type'; kind: string }
  | { op: 'empty' }
  | { op: 'not'; kid: PredNode }
  | { op: 'and'; kids: PredNode[] }
  | { op: 'or'; kids: PredNode[] }
  | { op: 'true' }
  // An action the expression reached (-print, -print0, -ls, -delete,
  // -exec, -printf): true, like GNU's, and it marks the entry as acted on.
  // A tree that holds one keeps the entries an action reached rather than
  // the ones the whole expression held for, which is how `-o`
  // short-circuits past a `-print` (`-path ./skip -prune -o -type f
  // -print` never reaches the print for `./skip`). The executor still runs
  // the action itself, once per kept row, so the parser admits one
  // distinct action to a tree holding any. GNU's `-exec ... ;` alone is
  // false when its command fails, which the executor learns only after the
  // walk, so the parser lets it stand only where nothing follows it;
  // `batch` marks `-exec ... {} +`, true whatever the command exits.
  | { op: 'action'; kind: ActionKind; batch?: boolean }
  // `-prune`: true, and a directory it reaches loses its contents. Every
  // backend evaluates the tree entry by entry with no say over its own
  // walk, and a flat listing meets a child before its parent, so the node
  // keeps the ledger of pruned directory keys (mount-relative) and
  // `dropPruned` applies it to what the walk returned; `bindTree` hands
  // every start point a fresh ledger. A prune reached past a time test the
  // entry could not answer lands in `pending`; until `settlePrunes`
  // evaluates the directory again with its mtime, it counts as pruned, the
  // most a walk without times can say.
  | { op: 'prune'; pruned: string[]; pending: PendingPrune[] }
  | MtimeNode

// What evaluating an expression on one entry did besides answer: whether an
// action was reached, whether a prune node recorded the entry (firm or
// pending), and the time tests the entry carried no mtime for on the path
// that decided the answer so far; a branch whose outcome they could not
// have changed drops them again.
export interface Effects {
  acted: boolean
  pruned: boolean
  deferred: MtimeNode[]
}

function freshEffects(): Effects {
  return { acted: false, pruned: false, deferred: [] }
}

export function evalPredicate(node: PredNode, entry: FindEntry): boolean {
  return evaluate(node, entry, freshEffects())
}

// Whether the expression holds for one entry, recording what it did.
// Evaluation short-circuits the way GNU's does (`-a` stops at the first
// false, `-o` at the first true), so an action or a prune is reached
// exactly when GNU would reach it.
export function evaluate(node: PredNode, entry: FindEntry, effects: Effects): boolean {
  switch (node.op) {
    case 'true':
      return true
    case 'action':
      effects.acted = true
      return true
    case 'prune':
      // Only a directory has contents to skip; a file key that is also a
      // directory prefix (an object store allows both) must not drop what
      // sits under the directory.
      if (entry.kind === 'd' && effects.deferred.length > 0) {
        node.pending.push({ entry })
      } else if (entry.kind === 'd') {
        node.pruned.push(entry.key)
      }
      effects.pruned = effects.pruned || entry.kind === 'd'
      return true
    case 'mtime':
      // An entry the walk fetched no time for passes here and meets the
      // expression's flat window afterwards; the test is recorded so a
      // `-prune` reached past it is only pending.
      if (entry.mtime === null || entry.mtime === undefined) {
        effects.deferred.push(node)
        return true
      }
      return inMtimeWindow(entry.mtime, node.lo, node.hi)
    case 'empty':
      return entry.isEmpty === true
    case 'name':
      return node.icase
        ? fnmatch(entry.name.toLowerCase(), node.pattern.toLowerCase())
        : fnmatch(entry.name, node.pattern)
    case 'path': {
      const shown = displayPath(node.prefix ?? '', entry.key)
      return fnmatch(node.root ? respellOne(shown, node.root, node.raw ?? '') : shown, node.pattern)
    }
    case 'type':
      return entry.kind === node.kind
    case 'not':
      return !evaluate(node.kid, entry, effects)
    case 'and': {
      const mark = effects.deferred.length
      for (const kid of node.kids) {
        const before = effects.deferred.length
        if (!evaluate(kid, entry, effects)) {
          // Had an earlier factor's undecided test failed, the chain would
          // have ended there with this same answer, so those tests decide
          // nothing; the failing factor's own may (`! -mtime 1` flips with
          // its mtime).
          effects.deferred.splice(mark, before - mark)
          return false
        }
      }
      return true
    }
    case 'or': {
      const mark = effects.deferred.length
      for (const kid of node.kids) {
        const before = effects.deferred.length
        if (evaluate(kid, entry, effects)) {
          effects.deferred.splice(mark, before - mark)
          return true
        }
      }
      return false
    }
  }
}

// Display path for a mount-relative key, as `find` prints it. Mirrors
// applyMountPrefix for a single key: the mount root maps to the bare
// prefix, everything else joins with one slash.
export function displayPath(prefix: string, key: string): string {
  if (!prefix) return key
  const rel = stripSlash(key)
  return rel === '' ? prefix : `${prefix}/${rel}`
}

// Copy of a predicate tree bound to one start point. `-path` matches the
// row as printed, but backend find ops evaluate entries by mount-relative
// key; stamping the prefix and the operand's spelling onto the tree keeps
// the evaluation site prefix-free (#396). Every prune node comes back with
// an empty ledger, so what one start point pruned never drops rows from the
// next (`find a/skip/inner a -path a/skip -prune -o -print` lists the first
// operand in full, as GNU does).
export function bindTree(node: PredNode, prefix: string, root = '', raw = ''): PredNode {
  switch (node.op) {
    case 'path':
      return { op: 'path', pattern: node.pattern, prefix, root, raw }
    case 'prune':
      return { op: 'prune', pruned: [], pending: [] }
    case 'not':
      return { op: 'not', kid: bindTree(node.kid, prefix, root, raw) }
    case 'and':
      return { op: 'and', kids: node.kids.map((kid) => bindTree(kid, prefix, root, raw)) }
    case 'or':
      return { op: 'or', kids: node.kids.map((kid) => bindTree(kid, prefix, root, raw)) }
    default:
      return node
  }
}

export function treeHasAction(node: PredNode): boolean {
  if (node.op === 'action') return true
  if (node.op === 'not') return treeHasAction(node.kid)
  if (node.op === 'and' || node.op === 'or') return node.kids.some(treeHasAction)
  return false
}

export function treeHasPrune(node: PredNode): boolean {
  if (node.op === 'prune') return true
  if (node.op === 'not') return treeHasPrune(node.kid)
  if (node.op === 'and' || node.op === 'or') return node.kids.some(treeHasPrune)
  return false
}

// The tree with every `-prune` made inert. GNU: `-prune` does nothing when
// `-depth` is in effect, since a directory's contents are visited before
// the directory itself.
export function withoutPrune(node: PredNode): PredNode {
  switch (node.op) {
    case 'prune':
      return { op: 'true' }
    case 'not':
      return { op: 'not', kid: withoutPrune(node.kid) }
    case 'and':
      return { op: 'and', kids: node.kids.map(withoutPrune) }
    case 'or':
      return { op: 'or', kids: node.kids.map(withoutPrune) }
    default:
      return node
  }
}

// Every directory key the tree's `-prune` nodes reached. A pending prune
// counts until `settlePrunes` decides it.
export function prunedKeys(node: PredNode): string[] {
  if (node.op === 'prune') return [...node.pruned, ...node.pending.map((p) => p.entry.key)]
  if (node.op === 'not') return prunedKeys(node.kid)
  if (node.op === 'and' || node.op === 'or') return node.kids.flatMap(prunedKeys)
  return []
}

/** Every `-prune` still waiting on a time test. */
export function pendingPrunes(node: PredNode): PendingPrune[] {
  if (node.op === 'prune') return [...node.pending]
  if (node.op === 'not') return pendingPrunes(node.kid)
  if (node.op === 'and' || node.op === 'or') return node.kids.flatMap(pendingPrunes)
  return []
}

function pruneNodes(node: PredNode): Extract<PredNode, { op: 'prune' }>[] {
  if (node.op === 'prune') return [node]
  if (node.op === 'not') return pruneNodes(node.kid)
  if (node.op === 'and' || node.op === 'or') return node.kids.flatMap(pruneNodes)
  return []
}

// The tree with every time test false, sharing the prune ledgers. A
// directory that reports no mtime passes no time test, the way the flat
// window admits no such row, so the prunes it reaches are the ones reachable
// with every test false. The prune nodes are the original objects, so what
// this copy records lands on the tree.
function timeTestsFailing(node: PredNode): PredNode {
  switch (node.op) {
    case 'mtime':
      return { op: 'not', kid: { op: 'true' } }
    case 'not':
      return { op: 'not', kid: timeTestsFailing(node.kid) }
    case 'and':
      return { op: 'and', kids: node.kids.map(timeTestsFailing) }
    case 'or':
      return { op: 'or', kids: node.kids.map(timeTestsFailing) }
    default:
      return node
  }
}

// Decide the pending prunes whose directory mtime is now known. Each decided
// directory leaves the pending ledgers and is evaluated again with its
// mtime, so the prunes it reaches are exactly GNU's, whichever arm the tests
// send it down: `find d -newermt X -prune` skips only the contents of
// directories newer than X, and `( -mtime 1 -o -type d ) -prune` skips every
// directory's. A key `mtimes` does not name stays pending.
export function settlePrunes(node: PredNode, mtimes: ReadonlyMap<string, number | null>): void {
  const decided = new Map<string, FindEntry>()
  for (const prune of pruneNodes(node)) {
    const still: PendingPrune[] = []
    for (const pend of prune.pending) {
      if (mtimes.has(pend.entry.key)) decided.set(pend.entry.key, pend.entry)
      else still.push(pend)
    }
    prune.pending = still
  }
  for (const [key, entry] of decided) {
    const mtime = mtimes.get(key) ?? null
    const tree = mtime === null ? timeTestsFailing(node) : node
    evaluate(tree, { ...entry, mtime }, freshEffects())
  }
}

// The rows minus everything under a directory `-prune` reached. The pruned
// directory itself stays, the root spelled `/` included: GNU reports it when
// the rest of the expression does, and only its contents go unvisited. Rows are spelled as the
// ledger's keys are, or as display paths when `prefix` is given.
export function dropPruned(rows: string[], tree: PredNode, prefix = ''): string[] {
  const stems = prunedKeys(tree).map((key) => rstripSlash(displayPath(prefix, key)) + '/')
  if (stems.length === 0) return rows
  return rows.filter((row) => !stems.some((stem) => row.startsWith(stem) && row !== stem))
}

// Decide every pending prune by asking for its directory's mtime. The
// backend judged its entries without their mtimes, so a prune reached past
// `-newermt` or `-mtime` is only pending; the caller's overlay-aware stat
// answers for the directory here, and a directory the test rejects keeps
// its contents (`find d -newermt X -prune` skips only the directories newer
// than X, as GNU does). `mtimeOf` takes a mount-relative key and answers
// null when the directory reports no mtime or is gone.
export async function settlePendingPrunes(
  node: PredNode,
  mtimeOf: (key: string) => Promise<number | null>,
): Promise<void> {
  const mtimes = new Map<string, number | null>()
  for (const pend of pendingPrunes(node)) {
    mtimes.set(pend.entry.key, await mtimeOf(pend.entry.key))
  }
  settlePrunes(node, mtimes)
}

export function treeHasType(node: PredNode): boolean {
  if (node.op === 'type') return true
  if (node.op === 'not') return treeHasType(node.kid)
  if (node.op === 'and' || node.op === 'or') return node.kids.some(treeHasType)
  return false
}

export function treeHasEmpty(node: PredNode): boolean {
  if (node.op === 'empty') return true
  if (node.op === 'not') return treeHasEmpty(node.kid)
  if (node.op === 'and' || node.op === 'or') return node.kids.some(treeHasEmpty)
  return false
}

// Whether `find` reports the entry. With no action in the tree the rows are
// the entries the whole expression holds for, GNU's implicit `-print`. With
// one, they are the entries an action reached: `-path ./skip -prune -o -type
// f -print` holds for `./skip` but never prints it. `-mindepth` applies
// neither tests nor actions above its level, so a shallow directory is not
// pruned either.
export function keep(
  entry: FindEntry,
  tree: PredNode,
  minDepth: number | null | undefined,
): boolean {
  if (minDepth !== null && minDepth !== undefined && entry.depth < minDepth) return false
  const effects = freshEffects()
  const matched = evaluate(tree, entry, effects)
  if (entry.kind === 'd' && effects.deferred.length > 0 && !effects.pruned) {
    // The answer passed every -prune on the strength of an undecided test,
    // and the directory's mtime may send it into one (`-mtime 1 -o
    // -prune`), so it waits with the prunes it might reach, on the first
    // of them.
    const [first] = pruneNodes(tree)
    if (first !== undefined) first.pending.push({ entry })
  }
  return treeHasAction(tree) ? effects.acted : matched
}

// Basename of a find start path, as GNU prints and matches it. Single source
// of truth for the start path's own name across every backend find op; reads
// `path.virtual` so the name is correct whether the start is the mount root
// or a nested directory. Returns '' for the bare root '/'.
export function startBasename(virtual: string): string {
  return rstripSlash(virtual).split('/').pop() ?? ''
}

export interface EmitStartPathOptions {
  kind: FindEntry['kind']
  isEmpty?: boolean | null
  exists: boolean
  tree: PredNode
  maxDepth: number | null | undefined
  minDepth: number | null | undefined
  size?: number | null | undefined
  minSize?: number | null | undefined
  maxSize?: number | null | undefined
}

// Append the search start path to results when it matches. Shared by every
// backend find op so the start path is emitted uniformly: bare `find <dir>`,
// `-type d` on the root, `-maxdepth 0`, `-mindepth 0`, and `-name` against the
// start's own basename all behave the same everywhere. A directory start path
// contributes size 0 to `-size` filtering (mirage directories have no
// meaningful content size; a documented divergence from GNU, which compares
// the inode size), so `-size +N` excludes directory roots and `-size -N`
// keeps them (#318). A file start with an unknown size skips the filter.
export function emitStartPath(
  results: string[],
  startKey: string,
  startName: string,
  opts: EmitStartPathOptions,
): void {
  if (!opts.exists) return
  if (opts.maxDepth !== null && opts.maxDepth !== undefined && opts.maxDepth < 0) return
  const entry: FindEntry = {
    key: startKey,
    name: startName,
    kind: opts.kind,
    depth: 0,
    isEmpty: opts.isEmpty ?? null,
  }
  if (!keep(entry, opts.tree, opts.minDepth)) return
  if (
    (opts.minSize !== null && opts.minSize !== undefined) ||
    (opts.maxSize !== null && opts.maxSize !== undefined)
  ) {
    // Directories count as size 0 for -size: GNU compares the inode size (e.g. 4096 on ext4); see CLAUDE.md Rules.
    const effective = opts.kind !== 'f' ? 0 : (opts.size ?? null)
    if (effective !== null) {
      if (opts.minSize !== null && opts.minSize !== undefined && effective < opts.minSize) return
      if (opts.maxSize !== null && opts.maxSize !== undefined && effective > opts.maxSize) return
    }
  }
  results.push(startKey)
}

export interface BuildTreeOptions {
  name?: string | null | undefined
  iname?: string | null | undefined
  pathPattern?: string | null | undefined
  type?: string | null | undefined
  nameExclude?: string | null | undefined
  orNames?: string[] | null | undefined
  empty?: boolean | null | undefined
}

// Whether a directory holds namespace symlinks directly under it.
//
// `-empty` asks whether a directory has entries, and a symlink is one of
// them. No backend readdir can see a namespace link, so every emptiness
// probe has to add this or a directory holding only a link reads as empty.
// Shared because find asks it in two places: the start point's row and
// each directory the walk reaches.
export function hasLinkChildren(links: LinkView | null | undefined, virtual: string): boolean {
  if (links === null || links === undefined) return false
  return links.children(rstripSlash(virtual) || '/').length > 0
}

export function buildTree(opts: BuildTreeOptions): PredNode {
  const kids: PredNode[] = []
  if (opts.orNames !== null && opts.orNames !== undefined && opts.orNames.length > 0) {
    kids.push({
      op: 'or',
      kids: opts.orNames.map((pat) => ({ op: 'name', pattern: pat, icase: false })),
    })
  } else if (opts.name !== null && opts.name !== undefined) {
    kids.push({ op: 'name', pattern: opts.name, icase: false })
  }
  if (opts.iname !== null && opts.iname !== undefined) {
    kids.push({ op: 'name', pattern: opts.iname, icase: true })
  }
  if (opts.pathPattern !== null && opts.pathPattern !== undefined) {
    kids.push({ op: 'path', pattern: opts.pathPattern })
  }
  if (opts.type !== null && opts.type !== undefined) {
    kids.push({ op: 'type', kind: opts.type })
  }
  if (opts.nameExclude !== null && opts.nameExclude !== undefined) {
    kids.push({ op: 'not', kid: { op: 'name', pattern: opts.nameExclude, icase: false } })
  }
  if (opts.empty === true) {
    kids.push({ op: 'empty' })
  }
  const [first, ...rest] = kids
  if (first === undefined) return { op: 'true' }
  if (rest.length === 0) return first
  return { op: 'and', kids }
}

// The predicate tree for a FindOptions bag: the pre-built expression tree
// when present, otherwise the flag-form fields. Single source of truth for
// the fallback every backend find op used to hand-roll.
export function optionsTree(options: {
  name?: string | null
  iname?: string | null
  pathPattern?: string | null
  type?: string | null
  nameExclude?: string | null
  orNames?: string[] | null
  empty?: boolean | null
  tree?: PredNode | null
}): PredNode {
  return (
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
  )
}

export function computeNonemptyDirs(keys: string[]): Set<string> {
  const nonempty = new Set<string>()
  for (const k of keys) {
    const cut = k.lastIndexOf('/')
    nonempty.add(cut > 0 ? k.slice(0, cut) : '/')
  }
  return nonempty
}

// Map one respelled display row back to its virtual path: the inverse of
// respellRaw, for the stat probe.
export function unrespellRaw(row: string, virtual: string, raw: string): string {
  if (raw === '' || raw === virtual) return row
  if (row === raw) return virtual
  const stem = raw.endsWith('/') ? raw : raw + '/'
  if (row.startsWith(stem)) {
    const base = virtual.replace(/\/+$/, '')
    return base + '/' + row.slice(stem.length)
  }
  return row
}
