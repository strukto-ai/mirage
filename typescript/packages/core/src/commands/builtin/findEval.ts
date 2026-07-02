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
import { rstripSlash } from '../../utils/slash.ts'

export interface FindEntry {
  key: string
  name: string
  kind: 'f' | 'd'
  depth: number
  isEmpty?: boolean | null
}

export type PredNode =
  | { op: 'name'; pattern: string; icase: boolean }
  | { op: 'path'; pattern: string }
  | { op: 'type'; kind: string }
  | { op: 'empty' }
  | { op: 'not'; kid: PredNode }
  | { op: 'and'; kids: PredNode[] }
  | { op: 'or'; kids: PredNode[] }
  | { op: 'true' }

export function evalPredicate(node: PredNode, entry: FindEntry): boolean {
  switch (node.op) {
    case 'true':
      return true
    case 'empty':
      return entry.isEmpty === true
    case 'name':
      return node.icase
        ? fnmatch(entry.name.toLowerCase(), node.pattern.toLowerCase())
        : fnmatch(entry.name, node.pattern)
    case 'path':
      return fnmatch(entry.key, node.pattern)
    case 'type':
      return entry.kind === node.kind
    case 'not':
      return !evalPredicate(node.kid, entry)
    case 'and':
      return node.kids.every((kid) => evalPredicate(kid, entry))
    case 'or':
      return node.kids.some((kid) => evalPredicate(kid, entry))
  }
}

export function treeHasType(node: PredNode): boolean {
  if (node.op === 'type') return true
  if (node.op === 'not') return treeHasType(node.kid)
  if (node.op === 'and' || node.op === 'or') return node.kids.some(treeHasType)
  return false
}

export function keep(
  entry: FindEntry,
  tree: PredNode,
  minDepth: number | null | undefined,
): boolean {
  if (minDepth !== null && minDepth !== undefined && entry.depth < minDepth) return false
  return evalPredicate(tree, entry)
}

// Basename of a find start path, as GNU prints and matches it. Single source
// of truth for the start path's own name across every backend find op; reads
// `path.virtual` so the name is correct whether the start is the mount root
// or a nested directory. Returns '' for the bare root '/'.
export function startBasename(virtual: string): string {
  return rstripSlash(virtual).split('/').pop() ?? ''
}

export interface EmitStartPathOptions {
  kind: 'f' | 'd'
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
// start's own basename all behave the same everywhere. Size filtering applies
// only to a file start path; directory roots pass size undefined and skip it.
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
  if (opts.kind === 'f' && opts.size !== null && opts.size !== undefined) {
    if (opts.minSize !== null && opts.minSize !== undefined && opts.size < opts.minSize) return
    if (opts.maxSize !== null && opts.maxSize !== undefined && opts.size > opts.maxSize) return
  }
  results.push(startKey)
}

export interface BuildTreeOptions {
  name?: string | null | undefined
  iname?: string | null | undefined
  pathPattern?: string | null | undefined
  type?: 'f' | 'd' | null | undefined
  nameExclude?: string | null | undefined
  orNames?: string[] | null | undefined
  empty?: boolean | null | undefined
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

export function computeNonemptyDirs(keys: string[]): Set<string> {
  const nonempty = new Set<string>()
  for (const k of keys) {
    const cut = k.lastIndexOf('/')
    nonempty.add(cut > 0 ? k.slice(0, cut) : '/')
  }
  return nonempty
}
