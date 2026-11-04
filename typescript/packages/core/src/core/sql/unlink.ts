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
import { SQL } from './constants.ts'
import { isDir, reap } from './inode.ts'
import { found, leaf, parentOf, walk } from './path.ts'

/** Remove a file's entry, and the file with it unless another entry names it. */
export async function unlink(accessor: SqlAccessor, path: PathSpec): Promise<void> {
  const w = await walk(accessor, path)
  const node = found(w, path)
  if (isDir(node)) throw eisdir(path)
  await accessor.batch([
    { sql: SQL.removeEntry, params: [parentOf(w)?.ino ?? null, leaf(w)] },
    ...reap([node.ino]),
  ])
}
