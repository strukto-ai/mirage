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
import { enotempty } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import type { SqlStatement } from '../../vfs/sql/types.ts'
import { SQL } from './constants.ts'
import { byIno, inodeOf, isDir, reap } from './inode.ts'
import { leaf, parentOf, target, walk } from './path.ts'

/**
 * Remove a path and everything under it, in one transaction. The tree is
 * listed first, so an entry written under it meanwhile is not on the list: a
 * directory goes only once it holds nothing, deepest first, and one such an
 * entry keeps is left standing with the directories above it, and the call
 * answers ENOTEMPTY. Mirrors Python's `rm_r`.
 */
export async function rmR(accessor: SqlAccessor, path: PathSpec): Promise<void> {
  const w = await walk(accessor, path)
  const node = target(w)
  if (node === null) return
  const parent = parentOf(w)
  const statements: SqlStatement[] = []
  const inos: number[] = []
  if (isDir(node)) {
    const files: number[] = []
    const dirs = new Map<number, number[]>()
    for (const row of await accessor.query(SQL.subtree, [node.ino])) {
      const child = inodeOf(row)
      if (child === null) continue
      inos.push(child.ino)
      if (!isDir(child)) files.push(Number(row.id))
      else dirs.set(Number(row.depth), [...(dirs.get(Number(row.depth)) ?? []), Number(row.id)])
    }
    for (let i = 0; i < files.length; i += 500) {
      const ids = files.slice(i, i + 500)
      statements.push({ sql: `DELETE FROM fs_dentry WHERE id IN (${ids.join(', ')})` })
    }
    for (const depth of [...dirs.keys()].sort((a, b) => b - a)) {
      const ids = dirs.get(depth) ?? []
      statements.push({
        sql: `DELETE FROM fs_dentry WHERE id IN (${ids.join(', ')})
          AND NOT EXISTS (SELECT 1 FROM fs_dentry c WHERE c.parent_ino = fs_dentry.ino)`,
      })
    }
  }
  if (parent !== null) {
    statements.push({
      sql: `${SQL.removeEntry} AND NOT EXISTS (
        SELECT 1 FROM fs_dentry c WHERE c.parent_ino = ${byIno(node.ino).sql})`,
      params: [parent.ino, leaf(w)],
    })
    inos.push(node.ino)
  }
  await accessor.batch([...statements, ...reap(inos)])
  if (parent !== null && (await accessor.query(SQL.hasEntry, [parent.ino, leaf(w)])).length > 0) {
    throw enotempty(path)
  }
}
