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
import type { FileStat, PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { eexist } from '../../errors/fs.ts'
import { uploadStat } from '../../utils/upload.ts'
import { createFolder, type BoxItem } from './api.ts'
import { BoxApiError } from './client.ts'
import { statFromItem } from './readdir.ts'
import { parentFolder, pathParts } from './resolve.ts'

/**
 * Make one folder inside the folder its parent path names. `mkdir -p` reaches
 * here one level at a time, each handed the level above as its parent.
 * Mirrors Python's `mkdir`.
 */
export async function mkdir(
  accessor: BoxAccessor,
  path: PathSpec,
  parents = false,
  handed: Handed = {},
): Promise<FileStat | null> {
  const parts = pathParts(path)
  if (parts.length === 0) {
    if (parents) return null
    throw eexist(path.virtual)
  }
  const folderId = parentFolder(accessor, path, handed.parent)
  // Box 409s a name already taken, by a file or a folder: EEXIST, named here
  // because BoxApiError carries no errno.
  let created: BoxItem
  try {
    created = await createFolder(accessor.tokenManager, folderId, parts[parts.length - 1] ?? '')
  } catch (error) {
    if (error instanceof BoxApiError && error.status === 409) throw eexist(path)
    throw error
  }
  return uploadStat(created, statFromItem, path.virtual)
}
