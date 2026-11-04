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
import { ebusy, einval, eisdir, enotdir, enotempty } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import type { SqlStatement } from '../../vfs/sql/types.ts'
import { SQL } from './constants.ts'
import { byIno, isDir, nowStamp, reap } from './inode.ts'
import { checkDestParents, found, leaf, parentOf, target, walk } from './path.ts'

/**
 * Move an entry, as rename(2) does: one entry changes its parent and name, so
 * a directory carries everything under it, and the move lands in one
 * transaction. A file onto a directory is EISDIR, a directory onto a file
 * ENOTDIR, onto a directory that holds entries ENOTEMPTY, and into its own
 * subtree EINVAL; a file or empty directory at the destination is replaced.
 * Mirrors Python's `rename`.
 */
export async function rename(accessor: SqlAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const from = await walk(accessor, src)
  const to = await walk(accessor, dst)
  checkDestParents(to, dst)
  const node = found(from, src)
  if (from.p === to.p) return
  const fromParent = parentOf(from)
  const toParent = parentOf(to)
  if (fromParent === null) throw ebusy(src)
  if (toParent === null) throw ebusy(dst)
  const there = target(to)
  if (isDir(node)) {
    if (to.chain.some((n) => n?.ino === node.ino)) throw einval(src)
    if (there !== null && !isDir(there)) throw enotdir(dst)
    if (there !== null && (await accessor.query(SQL.hasChild, [there.ino])).length > 0) {
      throw enotempty(dst)
    }
  } else if (there !== null && isDir(there)) {
    throw eisdir(dst)
  }
  const [seconds, nanoseconds] = nowStamp()
  const statements: SqlStatement[] = []
  if (there !== null) statements.push({ sql: SQL.removeEntry, params: [toParent.ino, leaf(to)] })
  statements.push(
    { sql: SQL.moveEntry, params: [toParent.ino, leaf(to), fromParent.ino, leaf(from)] },
    {
      sql: `UPDATE fs_inode SET ctime = ?, ctime_nsec = ? WHERE ino = ${byIno(node.ino).sql}`,
      params: [seconds, nanoseconds],
    },
  )
  if (there !== null) statements.push(...reap([there.ino]))
  await accessor.batch(statements)
}
