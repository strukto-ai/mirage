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
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { enoent, enotempty } from '../../errors/fs.ts'
import { liveRow, statFromItem } from './readdir.ts'
import { driveTargetName, eaccesOnDenied, parentFolder } from './resolve.ts'

/**
 * Move an item, replacing what is at the destination, handed what is at
 * `src` and its parent and at `dst` and its parent. Mirrors Python's
 * `rename`.
 */
async function renameImpl(
  accessor: GDriveAccessor,
  src: PathSpec,
  dst: PathSpec,
  handed: Handed = {},
): Promise<FileStat | null> {
  const drive = accessor.drive
  const entry = await liveRow(accessor, src, handed.entry)
  if (entry === null) throw enoent(src)
  const dstEntry = await liveRow(accessor, dst, handed.dstEntry)
  if (dstEntry !== null) {
    // GNU mv overwrites the destination: drop a conflicting file (or empty
    // folder) before the move. A non-empty folder conflict is mv's
    // "Directory not empty", mirroring the msgraph rename_replace.
    if (dstEntry.type === FileType.DIRECTORY) {
      const driveId = dstEntry.extra.drive_id
      const children = await drive.listFiles({
        folderId: dstEntry.extra.file_id as string,
        driveId: typeof driveId === 'string' ? driveId : null,
        limit: 1,
      })
      if (children.length > 0) throw enotempty(dst)
    }
    await drive.deleteFile(dstEntry.extra.file_id as string)
  }
  const [srcParentId] = await parentFolder(accessor, src, handed.parent)
  const [dstParentId] = await parentFolder(accessor, dst, handed.dstParent)
  const dstKey = dst.vfsPath
  const basename = dstKey.includes('/') ? dstKey.slice(dstKey.lastIndexOf('/') + 1) : dstKey
  const mime = entry.extra.mime_type
  const name = driveTargetName(basename, typeof mime === 'string' ? mime : '')
  const move = dstParentId !== srcParentId
  // Drive stamps a rename as an edit, so the time goes back as rename(2)
  // keeps it, as the live row just read it. Drive has no conditional update;
  // reading it just before leaves one request for another writer's edit to
  // land in.
  const fileId = entry.extra.file_id as string
  const modified = entry.modified
  const item = await drive.patchFile(fileId, {
    body: modified ? { name, modifiedTime: modified } : { name },
    ...(move ? { addParents: dstParentId, removeParents: srcParentId } : {}),
  })
  const moved: unknown = item
  return typeof moved === 'object' && moved !== null ? statFromItem(item) : null
}

export const rename = eaccesOnDenied(renameImpl)
