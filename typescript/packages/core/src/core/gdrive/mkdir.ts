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

import type { PathSpec } from '../../types.ts'
import { eexist, enotdir } from '../../errors/fs.ts'
import { createFolder } from '../google/drive.ts'
import {
  eaccesOnDenied,
  isFolder,
  nodeFromItem,
  resolveParent,
  resolveSegment,
  rootContext,
} from './resolve.ts'

async function mkdirImpl(accessor: GDriveAccessor, path: PathSpec, parents = false): Promise<void> {
  const key = path.vfsPath
  const tm = accessor.tokenManager
  if (key === '') {
    if (parents) return
    throw eexist(path)
  }
  if (!parents) {
    const [parentId] = await resolveParent(accessor, path)
    const basename = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
    await createFolder(tm, basename, parentId)
    return
  }
  let [parentId, driveId] = await rootContext(accessor)
  const segments = key.split('/').filter((s) => s !== '')
  for (const [i, segment] of segments.entries()) {
    let node = await resolveSegment(tm, parentId, segment, driveId, i === 0 && parentId === 'root')
    if (node === null) {
      node = nodeFromItem(await createFolder(tm, segment, parentId), driveId)
    } else if (!isFolder(node)) {
      // -p only silences EEXIST for directories: a file at the leaf is
      // File exists, a file in the middle is Not a directory.
      if (i === segments.length - 1) throw eexist(path)
      throw enotdir(path)
    }
    parentId = node.id
    driveId = node.driveId
  }
}

export const mkdir = eaccesOnDenied(mkdirImpl)
