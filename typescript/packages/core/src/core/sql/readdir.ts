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

import type { SqlAccessor } from '../../accessor/sql.ts'
import { memoryRoom } from '../../io/memory.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { SQL, TREE_ENTRY_BYTES, childrenOf } from './constants.ts'
import { inodeOf, inodeStat, isDir, subdirCounts, type Inode } from './inode.ts'
import { notListable, target, walk } from './path.ts'

function under(p: string): string {
  return p === '/' ? '/' : `${p}/`
}

export async function readdir(accessor: SqlAccessor, path: PathSpec): Promise<FileStat[]> {
  // A pattern spec addresses the directory whose entries the glob filters.
  const w = await walk(accessor, path.pattern !== null ? path.dir : path)
  const node = target(w)
  if (node === null || !isDir(node)) throw await notListable(w, path)
  const rows = await accessor.query(SQL.children, [node.ino])
  const entries: [string, Inode][] = []
  for (const row of rows) {
    const child = inodeOf(row)
    if (child !== null) entries.push([String(row.name), child])
  }
  entries.sort(([a], [b]) => compareCodePoints(a, b))
  const counts = await subdirCounts(
    accessor,
    entries.map(([, child]) => child),
  )
  return entries.map(([name, child]) =>
    inodeStat(under(w.p) + name, child, counts.get(child.ino) ?? 0),
  )
}

/** A whole subtree's rows by relative path, each folder's link count read
 * off the folders the rows hold under it. `prefix` is the subtree's mount
 * path, ending in a slash. */
function treeStats(prefix: string, entries: [string, Inode][]): Map<string, FileStat> {
  const subdirs = new Map<string, number>()
  for (const [rel, child] of entries) {
    if (!isDir(child)) continue
    const up = rel.slice(0, Math.max(rel.lastIndexOf('/'), 0))
    subdirs.set(up, (subdirs.get(up) ?? 0) + 1)
  }
  entries.sort(([a], [b]) => compareCodePoints(a, b))
  return new Map(
    entries.map(([rel, child]) => [rel, inodeStat(prefix + rel, child, subdirs.get(rel) ?? 0)]),
  )
}

/**
 * Every entry under a directory, each as `stat` answers it,
 * keyed by its relative path. Decline an oversized snapshot so the walk can list directories.
 * Mirrors Python's `tree`.
 */
export async function tree(
  accessor: SqlAccessor,
  path: PathSpec,
  limit?: number,
): Promise<Map<string, FileStat> | null> {
  const w = await walk(accessor, path)
  const node = target(w)
  if (node === null || !isDir(node)) return null
  const room = memoryRoom()
  const ceiling = Math.min(
    limit !== undefined && limit >= 0 ? limit : Infinity,
    room === null ? Infinity : Math.floor(room / TREE_ENTRY_BYTES),
  )
  if (Number.isFinite(ceiling)) return boundedTree(accessor, node, under(w.p), ceiling)
  const rows = await accessor.query(SQL.subtree, [node.ino])
  const entries: [string, Inode][] = []
  for (const row of rows) {
    const child = inodeOf(row)
    if (child !== null) entries.push([String(row.rel), child])
  }
  return treeStats(under(w.p), entries)
}

async function boundedTree(
  accessor: SqlAccessor,
  root: Inode,
  prefix: string,
  limit: number,
): Promise<Map<string, FileStat> | null> {
  const pending: [number, string][] = [[root.ino, '']]
  const entries: [string, Inode][] = []
  const encoder = new TextEncoder()
  let used = 0
  for (let start = 0; start < pending.length;) {
    const batch = pending.slice(start, start + 64)
    start += batch.length
    const parents = new Map(batch)
    const remaining = limit - entries.length
    const rows = await accessor.query(childrenOf(parents.size), [...parents.keys(), remaining + 1])
    if (rows.length > remaining) return null
    const room = memoryRoom()
    if (room !== null && used > room) return null
    for (const row of rows) {
      const child = inodeOf(row)
      if (child === null) continue
      const parent = parents.get(Number(row.parent_ino)) ?? ''
      const name = String(row.name)
      const rel = parent ? parent + '/' + name : name
      used += TREE_ENTRY_BYTES + encoder.encode(rel).byteLength
      if (room !== null && used > room) return null
      entries.push([rel, child])
      if (isDir(child)) pending.push([child.ino, rel])
    }
  }
  return treeStats(prefix, entries)
}
