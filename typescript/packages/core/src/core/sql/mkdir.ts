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
import { eexist, enotdir } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { DIR_MODE } from '../../utils/stat_view.ts'
import type { SqlStatement } from '../../vfs/sql/types.ts'
import { ROOT_INO } from './constants.ts'
import { byEntry, byIno, isDir, makeNode, nowStamp } from './inode.ts'
import { checkDestParents, leaf, parentRef, target, walk } from './path.ts'

/**
 * Make a directory. Plain mkdir is one mkdir(2) on the whole path, so an
 * existing target is EEXIST whichever kind it is. `mkdir -p` walks the chain
 * itself, so it reports the component it trips on (`mkdir -p a.txt/sub` is
 * ENOTDIR on `a.txt`), reaching the target as a plain file is EEXIST, and an
 * existing directory anywhere is success. Every directory it makes lands in
 * one transaction. Mirrors Python's `mkdir`.
 */
export async function mkdir(accessor: SqlAccessor, path: PathSpec, parents = false): Promise<void> {
  const w = await walk(accessor, path)
  const now = nowStamp()
  if (!parents) {
    if (target(w) !== null) throw eexist(path)
    checkDestParents(w, path)
    await accessor.batch(makeNode(accessor, parentRef(w), leaf(w), DIR_MODE, 0, now))
    return
  }
  const statements: SqlStatement[] = []
  let parent = byIno(ROOT_INO)
  w.names.forEach((name, i) => {
    const node = w.chain[i + 1] ?? null
    if (node === null) {
      statements.push(...makeNode(accessor, parent, name, DIR_MODE, 0, now))
      parent = byEntry(parent, name)
      return
    }
    if (!isDir(node)) {
      const named = mountedPath(path, `/${w.names.slice(0, i + 1).join('/')}`)
      throw i === w.names.length - 1 ? eexist(named) : enotdir(named)
    }
    parent = byIno(node.ino)
  })
  await accessor.batch(statements)
}
