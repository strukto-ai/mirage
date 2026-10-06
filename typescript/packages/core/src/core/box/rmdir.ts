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
import { invalidateAfterUnlink, invalidateSubtree } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent, enotdir, enotempty } from '../../errors/fs.ts'
import { BoxApiError } from './client.ts'
import { deleteFile, deleteFolder } from './api.ts'
import { pathParts, resolveItem } from './resolve.ts'

export async function rmdir(accessor: BoxAccessor, path: PathSpec): Promise<void> {
  const item = await resolveItem(accessor, pathParts(path))
  if (item === null) throw enoent(path.virtual)
  if (item.type !== 'folder') throw enotdir(path.virtual)
  // recursive=false: Box 409s on a non-empty folder, matching POSIX rmdir.
  // The refusal is the service's, but naming it is ours: BoxApiError is a
  // bare Error with no code, so an unmapped 409 reached the caller as a
  // condition `classify` could not name -- EIO over FUSE, no code at all for
  // `ws.vfs` and the sandbox runtimes.
  try {
    await deleteFolder(accessor.tokenManager, item.id, false)
  } catch (error) {
    if (error instanceof BoxApiError && error.status === 409) throw enotempty(path)
    throw error
  }
  await invalidateAfterUnlink(path)
}

export async function rmR(accessor: BoxAccessor, path: PathSpec): Promise<void> {
  const parts = pathParts(path)
  if (parts.length === 0) return
  const item = await resolveItem(accessor, parts)
  if (item === null) throw enoent(path.virtual)
  if (item.type === 'folder') {
    await deleteFolder(accessor.tokenManager, item.id, true)
  } else {
    await deleteFile(accessor.tokenManager, item.id)
  }
  await invalidateSubtree(path)
}
