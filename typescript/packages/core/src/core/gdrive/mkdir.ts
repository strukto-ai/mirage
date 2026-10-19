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
import type { FileStat, PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { eexist } from '../../errors/fs.ts'
import { statFromItem } from './readdir.ts'
import { eaccesOnDenied, parentFolder } from './resolve.ts'

/**
 * Make one folder inside the folder its parent path names. `mkdir -p`
 * reaches here one level at a time, each handed the level above as its
 * parent. Mirrors Python's `mkdir`.
 */
async function mkdirImpl(
  accessor: GDriveAccessor,
  path: PathSpec,
  parents = false,
  handed: Handed = {},
): Promise<FileStat | null> {
  const key = path.vfsPath
  if (key === '') {
    if (parents) return null
    throw eexist(path)
  }
  const [parentId] = await parentFolder(accessor, path, handed.parent)
  const basename = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
  return statFromItem(await accessor.drive.createFolder(basename, parentId))
}

export const mkdir = eaccesOnDenied(mkdirImpl)
