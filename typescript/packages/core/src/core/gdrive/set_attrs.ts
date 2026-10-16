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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { enoent } from '../../errors/fs.ts'
import type { FileStat, PathSpec, SetAttrFields } from '../../types.ts'
import { toIsoZ } from '../../utils/dates.ts'
import { stripSlash } from '../../utils/slash.ts'
import { patchFile } from '../google/drive.ts'
import { liveRow } from './readdir.ts'
import { eaccesOnDenied } from './resolve.ts'

/**
 * Store a modified time as the item's Drive `modifiedTime`, and return the
 * fields Drive does not keep: permission bits, ownership and the access time
 * land in the namespace's overlay, and so does a time for the mount root,
 * which is no item of the mount's own. Mirrors Python's `set_attrs`.
 */
export const setAttrs = eaccesOnDenied(async function setAttrs(
  accessor: GDriveAccessor,
  path: PathSpec,
  fields: SetAttrFields,
  entry: FileStat | null = null,
): Promise<Record<string, number | string>> {
  const residual: Record<string, number | string> = {}
  if (fields.mode !== undefined) residual.mode = fields.mode
  if (fields.uid !== undefined) residual.uid = fields.uid
  if (fields.gid !== undefined) residual.gid = fields.gid
  if (fields.atime !== undefined) residual.atime = fields.atime
  if (fields.mtime === undefined) return residual
  if (stripSlash(path.vfsPath) === '') {
    residual.mtime = fields.mtime
    return residual
  }
  const live = await liveRow(accessor, path, entry)
  if (live === null) throw enoent(path)
  await patchFile(accessor.tokenManager, live.extra.file_id as string, {
    body: { modifiedTime: toIsoZ(new Date(fields.mtime)) },
  })
  return residual
})
