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
import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent, enotdir, enotempty } from '../../utils/errors.ts'
import { deleteFile, listFiles } from '../google/drive.ts'
import { eaccesOnDenied, isFolder, resolveKey } from './resolve.ts'

/**
 * Remove an empty folder.
 *
 * A Drive `files.delete` on a folder removes every descendant with it, so
 * this is the same request `rmR` sends and the emptiness check is the only
 * thing separating them. Without it `rmdir` destroyed the whole subtree for
 * every caller that does not pre-check emptiness itself, and the command
 * builders are the only callers that do: FUSE, `ws.fs` and the sandbox
 * runtimes all reach the op directly. The probe is the one `rename` already
 * makes before it overwrites a directory, bounded to a single entry.
 */
async function rmdirImpl(accessor: GDriveAccessor, path: PathSpec): Promise<void> {
  const key = path.resourcePath
  if (key === '') return
  const node = await resolveKey(accessor, key)
  if (node === null) throw enoent(path)
  if (!isFolder(node)) throw enotdir(path)
  const children = await listFiles(accessor.tokenManager, {
    folderId: node.id,
    driveId: node.driveId,
    limit: 1,
  })
  if (children.length > 0) throw enotempty(path)
  await deleteFile(accessor.tokenManager, node.id)
  await invalidateAfterUnlink(path)
}

export const rmdir = eaccesOnDenied(rmdirImpl)
