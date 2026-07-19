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
import type { DriveFile } from '../google/drive.ts'
import { FOLDER_MIME, MIME_TO_EXT, listFiles } from '../google/drive.ts'
import { resolveDir } from './resolve.ts'

// The rendered vfs filename for a Drive item.
function vfsName(item: DriveFile): string {
  const ext = MIME_TO_EXT[item.mimeType ?? '']
  return ext !== undefined ? `${item.name}${ext}` : item.name
}

// Walk a folder subtree, yielding [mount-relative path, item, isDir].
// Children are visited in vfs-name order so every traversal-based command
// (find, du) is deterministic, mirroring the python iter_tree contract.
export async function* iterTree(
  accessor: GDriveAccessor,
  path: PathSpec,
): AsyncIterable<[string, DriveFile, boolean]> {
  const base = path.resourcePath
  const [folderId, driveId] = await resolveDir(accessor, base, path.virtual)
  const stack: [string, string, string | null][] = [[base, folderId, driveId]]
  for (let head = stack.shift(); head !== undefined; head = stack.shift()) {
    const [rel, fid, did] = head
    const children = await listFiles(accessor.tokenManager, { folderId: fid, driveId: did })
    children.sort((a, b) => {
      const an = vfsName(a)
      const bn = vfsName(b)
      return an < bn ? -1 : an > bn ? 1 : 0
    })
    for (const item of children) {
      const name = vfsName(item)
      const childRel = rel !== '' ? `${rel}/${name}` : name
      const isDir = item.mimeType === FOLDER_MIME
      yield [childRel, item, isDir]
      if (isDir) stack.push([childRel, item.id, item.driveId ?? did])
    }
  }
}
