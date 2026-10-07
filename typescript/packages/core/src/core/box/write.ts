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

import type { BoxAccessor } from '../../accessor/box.ts'
import { evictAfter, invalidateAfterWrite } from '../../cache/context.ts'
import { record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { uploadToken } from '../../utils/upload.ts'
import { type BoxItem, uploadFileVersion, uploadNewFile } from './api.ts'
import { pathParts, resolveItem, resolveParentId } from './resolve.ts'
import { statFromItem } from './stat.ts'

/**
 * Upload a new file, or a new version of an existing one. A failed upload
 * still evicts the path: Box may have stored the bytes before its reply
 * broke off.
 */
export async function write(
  accessor: BoxAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const parts = pathParts(path)
  if (parts.length === 0) throw eisdir(path.virtual)
  const tm = accessor.tokenManager
  const timer = startOp()
  const existing = await resolveItem(accessor, parts)
  let upload: () => Promise<unknown>
  if (existing !== null && existing.type === 'file') {
    // Overwrite uploads a new version under the same id, keeping Box's own
    // name so a box-native file isn't renamed with the vfs suffix.
    upload = () => uploadFileVersion(tm, existing.id, existing.name, data)
  } else {
    const parentId = await resolveParentId(accessor, parts)
    if (parentId === null) throw enoent(path.virtual)
    upload = () => uploadNewFile(tm, parentId, parts[parts.length - 1] ?? '', data)
  }
  await evictAfter(upload, async (reply) => {
    if (reply !== undefined) {
      const entries: unknown =
        typeof reply === 'object' && reply !== null && !Array.isArray(reply)
          ? (reply as { entries?: unknown }).entries
          : undefined
      const first = Array.isArray(entries) ? (entries[0] as BoxItem | undefined) : undefined
      const token = uploadToken(first, statFromItem, path.virtual)
      record('write', path.virtual, 'box', data.length, timer, { fingerprint: token })
    }
    await invalidateAfterWrite(path)
  })
}
