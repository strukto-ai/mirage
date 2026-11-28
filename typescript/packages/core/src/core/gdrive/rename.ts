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
import { enoent, enotempty } from '../../errors/fs.ts'
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import type { DriveApi } from './api.ts'
import { liveRow, statFromItem } from './readdir.ts'
import { driveTargetName, eaccesOnDenied, parentFolder } from './resolve.ts'

// Refuse a folder that holds anything, as mv's "Directory not empty".
async function refuseChildren(drive: DriveApi, folder: FileStat, dst: PathSpec): Promise<void> {
  const driveId = folder.extra.drive_id
  const children = await drive.listFiles({
    folderId: folder.extra.file_id as string,
    driveId: typeof driveId === 'string' ? driveId : null,
    limit: 1,
  })
  if (children.length > 0) throw enotempty(dst)
}

/**
 * Move an item, replacing a file or an empty folder at the destination,
 * handed what is at `src` and its parent and at `dst` and its parent.
 *
 * Drive holds two items of one name in a folder, so the item moves first and
 * what it replaces is deleted after: a refused move leaves both as they were,
 * and a refused delete moves the item back. A folder is asked for children
 * again just before its delete, so one added while the item moved is not
 * deleted with it. Both paths naming one item (Drive lists a legacy item under
 * each of its parents) is rename(2) onto itself, which does nothing; GNU mv
 * refuses it by inode, which a Drive row lacks. Mirrors Python's `rename`.
 */
export const rename = eaccesOnDenied(async function (
  accessor: GDriveAccessor,
  src: PathSpec,
  dst: PathSpec,
  handed: Handed = {},
): Promise<FileStat | null> {
  const drive = accessor.drive
  const entry = await liveRow(accessor, src, handed.entry)
  if (entry === null) throw enoent(src)
  const fileId = entry.extra.file_id as string
  const dstEntry = await liveRow(accessor, dst, handed.dstEntry)
  if (dstEntry !== null && dstEntry.extra.file_id === fileId) return null
  if (dstEntry !== null && dstEntry.type === FileType.DIRECTORY) {
    await refuseChildren(drive, dstEntry, dst)
  }
  const [srcParentId] = await parentFolder(accessor, src, handed.parent)
  const [dstParentId] = await parentFolder(accessor, dst, handed.dstParent)
  const mimeType = entry.extra.mime_type
  const mime = typeof mimeType === 'string' ? mimeType : ''
  const name = driveTargetName(dst.vfsPath.slice(dst.vfsPath.lastIndexOf('/') + 1), mime)
  const move = dstParentId !== srcParentId
  // Drive stamps a rename as an edit, so the time goes back as rename(2)
  // keeps it, as the live row just read it. Drive has no conditional update;
  // reading it just before leaves one request for another writer's edit to
  // land in.
  const modified = entry.modified
  const stamp = modified ? { modifiedTime: modified } : {}
  const item = await drive.patchFile(fileId, {
    body: { name, ...stamp },
    ...(move ? { addParents: dstParentId, removeParents: srcParentId } : {}),
  })
  if (dstEntry !== null) {
    try {
      if (dstEntry.type === FileType.DIRECTORY) await refuseChildren(drive, dstEntry, dst)
      await drive.deleteFile(dstEntry.extra.file_id as string)
    } catch (err) {
      try {
        await drive.patchFile(fileId, {
          body: {
            name: driveTargetName(src.vfsPath.slice(src.vfsPath.lastIndexOf('/') + 1), mime),
            ...stamp,
          },
          ...(move ? { addParents: srcParentId, removeParents: dstParentId } : {}),
        })
      } catch (undo) {
        console.debug(`could not move ${src.virtual} back: ${String(undo)}`)
      }
      throw err
    }
  }
  const moved: unknown = item
  return typeof moved === 'object' && moved !== null ? statFromItem(item) : null
})
