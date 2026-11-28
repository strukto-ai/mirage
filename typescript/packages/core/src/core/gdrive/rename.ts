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
import { landThenRetire } from '../api/replace.ts'
import type { DriveFile } from '../google/drive.ts'
import type { DriveApi } from './api.ts'
import { deleteReplaced, gone } from './copy.ts'
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

// Patch an item, moving it between folders when they differ. Mirrors
// Python's `_move`.
async function move(
  drive: DriveApi,
  fileId: string,
  body: Record<string, unknown>,
  toParent: string,
  fromParent: string,
): Promise<DriveFile> {
  const moved = toParent !== fromParent
  return drive.patchFile(fileId, {
    body,
    ...(moved ? { addParents: toParent, removeParents: fromParent } : {}),
  })
}

// The item a move onto `name` in `folderId` landed, read by its id, null while
// it is not there. Mirrors Python's `_moved_as`.
async function movedAs(
  drive: DriveApi,
  fileId: string,
  name: string,
  folderId: string,
): Promise<DriveFile | null> {
  const item = await drive.getFile(fileId)
  if (item.trashed === true || item.name !== name || !(item.parents ?? []).includes(folderId)) {
    return null
  }
  return item
}

/**
 * Move an item, replacing a file or an empty folder at the destination,
 * handed what is at `src` and its parent and at `dst` and its parent.
 *
 * Drive holds two items of one name in a folder, so the item moves first and
 * what it replaces is deleted after (`deleteReplaced`): a refused move leaves
 * both as they were, and a refused delete moves the item back. A folder is asked for children
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
  // Drive stamps a rename as an edit, so the time goes back as rename(2)
  // keeps it, as the live row just read it. Drive has no conditional update;
  // reading it just before leaves one request for another writer's edit to
  // land in.
  const modified = entry.modified
  const stamp = modified ? { modifiedTime: modified } : {}
  const body = { name, ...stamp }
  const back = {
    name: driveTargetName(src.vfsPath.slice(src.vfsPath.lastIndexOf('/') + 1), mime),
    ...stamp,
  }
  if (dstEntry === null) {
    const made = await move(drive, fileId, body, dstParentId, srcParentId)
    const landed: unknown = made
    return typeof landed === 'object' && landed !== null ? statFromItem(made) : null
  }
  const item = await landThenRetire(
    () => move(drive, fileId, body, dstParentId, srcParentId),
    () => move(drive, fileId, back, srcParentId, dstParentId),
    async () => {
      if (dstEntry.type === FileType.DIRECTORY) await refuseChildren(drive, dstEntry, dst)
      await deleteReplaced(drive, dstEntry)
    },
    () => gone(drive, dstEntry.extra.file_id as string),
    undefined,
    () => movedAs(drive, fileId, name, dstParentId),
  )
  const moved: unknown = item
  return typeof moved === 'object' && moved !== null ? statFromItem(item) : null
})
