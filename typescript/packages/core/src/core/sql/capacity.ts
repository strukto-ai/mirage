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
import type { PathSpec } from '../../types.ts'
import { SQL } from './constants.ts'
import { inodeOf, isDir, isFile } from './inode.ts'
import { target, walk } from './path.ts'

/** The bytes at `path`, a directory's files included; 0 for none. Mirrors Python's `size_of`. */
export async function sizeOf(accessor: SqlAccessor, path: PathSpec): Promise<number> {
  const node = target(await walk(accessor, path))
  if (node === null) return 0
  if (!isDir(node)) return node.size
  let total = 0
  for (const row of await accessor.query(SQL.subtree, [node.ino])) {
    const child = inodeOf(row)
    if (child !== null && isFile(child)) total += child.size
  }
  return total
}

/** The bytes every file of the database holds. Mirrors Python's `count`. */
export async function count(accessor: SqlAccessor): Promise<number> {
  return Number((await accessor.query(SQL.usedBytes))[0]?.n ?? 0)
}
