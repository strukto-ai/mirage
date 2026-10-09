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

import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import {
  deleteCondition,
  invalidateAfterUnlink,
  invalidateAncestors,
  nativeCondition,
} from '../../cache/context.ts'
import { liftLost, lostCount, record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { DropboxApiError } from './client.ts'
import { deletePath, getMetadata, refused, type DropboxEntry } from './api.ts'
import { liveOf } from './fingerprint.ts'
import { dropboxPathOf } from './paths.ts'

/**
 * Delete a looked-up file, held to the version read, else the one found.
 * Mirrors Python's `delete_resolved`.
 */
export async function deleteResolved(
  accessor: DropboxAccessor,
  path: PathSpec,
  entry: DropboxEntry,
): Promise<void> {
  const live = liveOf(entry)
  const cond = await deleteCondition(path, live?.content ?? null)
  const rev = await nativeCondition(path, cond, live, 'delete')
  try {
    await deletePath(accessor.tokenManager, dropboxPathOf(accessor, path), rev)
  } catch (err) {
    throw (await refused(path, err, cond, rev)) ?? err
  }
}

export async function unlink(accessor: DropboxAccessor, path: PathSpec): Promise<void> {
  const apiPath = dropboxPathOf(accessor, path)
  let entry: DropboxEntry
  try {
    entry = await getMetadata(accessor.tokenManager, apiPath)
  } catch (err) {
    if (err instanceof DropboxApiError && err.status === 409) throw enoent(path.virtual)
    throw err
  }
  if (entry['.tag'] === 'folder') throw eisdir(path.virtual)
  const timer = startOp()
  const upto = lostCount()
  await deleteResolved(accessor, path, entry)
  record('unlink', path.virtual, 'dropbox', 0, timer)
  await invalidateAfterUnlink(path)
  await invalidateAncestors(path)
  liftLost(path, upto)
}
