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
import type { PathSpec, SetAttrFields } from '../../types.ts'
import { ALL_MODE_BITS, S_IFMT } from '../../utils/stat_view.ts'
import type { SqlValue } from '../../vfs/sql/types.ts'
import { byIno, nowStamp, stampOf } from './inode.ts'
import { found, walk } from './path.ts'

/**
 * Write metadata fields onto an entry's inode (the write side of stat), and
 * its ctime with them. The inode keeps a numeric owner; an owner given by
 * name is no column's, so it comes back as the residual, which the
 * namespace's overlay keeps. Stored, not enforced: mount mode does real
 * access control. Mirrors Python's `set_attrs`.
 */
export async function setAttrs(
  accessor: SqlAccessor,
  path: PathSpec,
  fields: SetAttrFields,
): Promise<Record<string, number | string>> {
  const node = found(await walk(accessor, path), path)
  const sets: string[] = []
  const params: SqlValue[] = []
  const residual: Record<string, number | string> = {}
  if (fields.mode !== undefined) {
    sets.push('mode = ?')
    params.push((node.mode & S_IFMT) | (fields.mode & ALL_MODE_BITS))
  }
  for (const key of ['uid', 'gid'] as const) {
    const value = fields[key]
    if (value === undefined) continue
    if (typeof value === 'number' || /^\d+$/.test(value)) {
      sets.push(`${key} = ?`)
      params.push(Number(value))
    } else {
      residual[key] = value
    }
  }
  for (const key of ['atime', 'mtime'] as const) {
    const value = fields[key]
    if (value === undefined) continue
    const [seconds, nanoseconds] = stampOf(value)
    sets.push(`${key} = ?`, `${key}_nsec = ?`)
    params.push(seconds, nanoseconds)
  }
  if (sets.length === 0) return residual
  const [seconds, nanoseconds] = nowStamp()
  await accessor.batch([
    {
      sql: `UPDATE fs_inode SET ${sets.join(', ')}, ctime = ?, ctime_nsec = ?
        WHERE ino = ${byIno(node.ino).sql}`,
      params: [...params, seconds, nanoseconds],
    },
  ])
  return residual
}
