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
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { FILE } from './constants.ts'
import { cutBytes } from './data.ts'
import { byIno, makeNode, nowStamp, resized } from './inode.ts'
import { checkDestParents, checkWriteTarget, leaf, parentRef, target, walk } from './path.ts'

/**
 * Resize a file to `length` bytes: cut its rows, or grow it by its size alone,
 * which reads as zeros. A missing file is made at that size unless
 * `noCreate`. Mirrors Python's `truncate`.
 */
export async function truncate(
  accessor: SqlAccessor,
  path: PathSpec,
  length: number,
  noCreate = false,
): Promise<void> {
  const timer = startOp()
  const w = await walk(accessor, path)
  checkDestParents(w, path)
  checkWriteTarget(w, path)
  const node = target(w)
  const now = nowStamp()
  if (node === null) {
    if (noCreate) return
    await accessor.batch(makeNode(accessor, parentRef(w), leaf(w), FILE, length, now))
  } else {
    await accessor.batch([
      ...(await cutBytes(accessor, node, length)),
      resized(byIno(node.ino), length, now),
    ])
  }
  record('truncate', path.virtual, VFSName.SQL, 0, timer)
}
