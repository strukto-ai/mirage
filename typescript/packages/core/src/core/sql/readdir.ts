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
import type { FileStat, PathSpec } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { SQL } from './constants.ts'
import { inodeOf, inodeStat, isDir, type Inode } from './inode.ts'
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
  return entries.map(([name, child]) => inodeStat(under(w.p) + name, child))
}

/**
 * Every entry under a directory from one query, each as `stat` answers it,
 * keyed by its path below the directory; null when `path` is no directory.
 * Mirrors Python's `tree`.
 */
export async function tree(
  accessor: SqlAccessor,
  path: PathSpec,
): Promise<Map<string, FileStat> | null> {
  const w = await walk(accessor, path)
  const node = target(w)
  if (node === null || !isDir(node)) return null
  const rows = await accessor.query(SQL.subtree, [node.ino])
  const entries: [string, Inode][] = []
  for (const row of rows) {
    const child = inodeOf(row)
    if (child !== null) entries.push([String(row.rel), child])
  }
  entries.sort(([a], [b]) => compareCodePoints(a, b))
  return new Map(entries.map(([rel, child]) => [rel, inodeStat(under(w.p) + rel, child)]))
}
