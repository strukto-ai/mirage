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
import { VFSName, type PathSpec, type SetAttrFields } from '../../types.ts'
import { byIno, stampOf, touched } from './inode.ts'
import { found, walk } from './path.ts'

/**
 * Set an entry's mtime in its inode, to the nanosecond the time gives, and
 * hand back every other field, which the store keeps no column for. Mirrors
 * Python's `set_attrs`.
 *
 * @param accessor the mount's database.
 * @param path the entry.
 * @param fields the mode, owners and ISO times asked for.
 * @returns the fields not applied here.
 */
export async function setAttrs(
  accessor: SqlAccessor,
  path: PathSpec,
  fields: SetAttrFields,
): Promise<Record<string, number | string>> {
  const timer = startOp()
  const w = await walk(accessor, path)
  const node = found(w, path)
  if (fields.mtime !== undefined) {
    await accessor.batch([touched(byIno(node.ino), stampOf(fields.mtime))])
  }
  record('setattr', path.virtual, VFSName.SQL, 0, timer)
  const rest: Record<string, number | string> = {}
  if (fields.mode !== undefined) rest.mode = fields.mode
  if (fields.uid !== undefined) rest.uid = fields.uid
  if (fields.gid !== undefined) rest.gid = fields.gid
  if (fields.atime !== undefined) rest.atime = fields.atime
  return rest
}
