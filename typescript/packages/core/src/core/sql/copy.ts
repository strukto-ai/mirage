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
import { eisdir } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import type { SqlStatement } from '../../vfs/sql/types.ts'
import { FILE } from './constants.ts'
import { byEntry, byIno, isDir, makeNode, nowStamp, resized } from './inode.ts'
import { checkDestParents, found, leaf, parentRef, target, walk } from './path.ts'

/**
 * Copy a file's bytes to `dst` inside the database, row for row: nothing
 * passes through the mount. Mirrors Python's `copy`.
 */
export async function copy(accessor: SqlAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const from = await walk(accessor, src)
  const to = await walk(accessor, dst)
  checkDestParents(to, dst)
  const node = found(from, src)
  if (isDir(node)) throw eisdir(src)
  const there = target(to)
  if (there !== null && isDir(there)) throw eisdir(dst)
  if (there?.ino === node.ino) return
  const now = nowStamp()
  const ino = there !== null ? byIno(there.ino) : byEntry(parentRef(to), leaf(to))
  const statements: SqlStatement[] =
    there !== null
      ? [{ sql: `DELETE FROM fs_data WHERE ino = ${ino.sql}` }, resized(ino, node.size, now)]
      : makeNode(accessor, parentRef(to), leaf(to), FILE, node.size, now)
  statements.push({
    sql: `INSERT INTO fs_data (ino, chunk_index, data)
      SELECT ${ino.sql}, chunk_index, data FROM fs_data WHERE ino = ${byIno(node.ino).sql}`,
    params: ino.params,
  })
  await accessor.batch(statements)
}
