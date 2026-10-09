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
import { deleteCondition, invalidateAfterUnlink, nativeCondition } from '../../cache/context.ts'
import { liftLost, lostCount, record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { type BoxItem, deleteFile, refused } from './api.ts'
import { liveOf } from './fingerprint.ts'
import { pathParts, resolveItem } from './resolve.ts'

/**
 * Delete a resolved file, held to the version read, else the one found.
 * Mirrors Python's `delete_resolved`.
 */
export async function deleteResolved(
  accessor: BoxAccessor,
  path: PathSpec,
  item: BoxItem,
): Promise<void> {
  const live = liveOf(item)
  const cond = await deleteCondition(path, live?.content ?? null)
  const etag = await nativeCondition(path, cond, live, 'delete')
  try {
    await deleteFile(accessor.tokenManager, item.id, etag)
  } catch (err) {
    throw (await refused(path, err, cond, etag)) ?? err
  }
}

export async function unlink(accessor: BoxAccessor, path: PathSpec): Promise<void> {
  const item = await resolveItem(accessor, pathParts(path))
  if (item === null) throw enoent(path.virtual)
  if (item.type === 'folder') throw eisdir(path.virtual)
  const upto = lostCount()
  const timer = startOp()
  await deleteResolved(accessor, path, item)
  record('unlink', path.virtual, 'box', 0, timer)
  await invalidateAfterUnlink(path)
  liftLost(path, upto)
}
