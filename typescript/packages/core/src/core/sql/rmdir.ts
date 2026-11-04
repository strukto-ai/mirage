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
import { ebusy, enotdir, enotempty } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { SQL } from './constants.ts'
import { byIno, dropInodes, isDir } from './inode.ts'
import { found, leaf, parentOf, walk } from './path.ts'

/**
 * Remove an empty directory. The entry goes only while the directory holds
 * nothing, checked in the statement that removes it, so a child written since
 * the check keeps it there and the call answers ENOTEMPTY. Mirrors Python's
 * `rmdir`.
 */
export async function rmdir(accessor: SqlAccessor, path: PathSpec): Promise<void> {
  const w = await walk(accessor, path)
  const node = found(w, path)
  if (!isDir(node)) throw enotdir(path)
  const parent = parentOf(w)
  if (parent === null) throw ebusy(path)
  if ((await accessor.query(SQL.hasChild, [node.ino])).length > 0) throw enotempty(path)
  await accessor.batch([
    {
      sql: `${SQL.removeEntry} AND NOT EXISTS (
        SELECT 1 FROM fs_dentry c WHERE c.parent_ino = ${byIno(node.ino).sql})`,
      params: [parent.ino, leaf(w)],
    },
    ...dropInodes([node.ino]),
  ])
  if ((await accessor.query(SQL.hasEntry, [parent.ino, leaf(w)])).length > 0) {
    throw enotempty(path)
  }
}
