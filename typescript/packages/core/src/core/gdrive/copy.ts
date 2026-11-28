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
import { eacces, eisdir, enoent, enotdir } from '../../errors/fs.ts'
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { landThenRetire } from '../api/replace.ts'
import { GoogleApiError } from '../google/client.ts'
import { FOLDER_MIME } from '../google/drive.ts'
import type { DriveApi } from './api.ts'
import { liveRow, statFromItem } from './readdir.ts'
import type { DriveNode } from './resolve.ts'
import { driveTargetName, eaccesOnDenied, nodeFromItem, nodeOf, parentFolder } from './resolve.ts'

async function copyChildren(drive: DriveApi, src: DriveNode, dstFolderId: string): Promise<void> {
  const children = await drive.listFiles({ folderId: src.id, driveId: src.driveId })
  for (const item of children) {
    const child = nodeFromItem(item, src.driveId)
    if (child.mimeType === FOLDER_MIME) {
      const created = await drive.createFolder(child.name, dstFolderId)
      await copyChildren(drive, child, created.id)
    } else {
      await drive.copyFile(child.id, child.name, dstFolderId)
    }
  }
}

/**
 * Delete the item a move or copy replaced, while it is still there. Drive
 * deletes by id wherever the item went, so it is read again first: one another
 * writer trashed, renamed or moved while the replacement landed no longer holds
 * the destination and is left as it is. Drive has no conditional delete;
 * reading it just before leaves one request for another writer's move to land
 * in. Mirrors Python's `delete_replaced`.
 */
export async function deleteReplaced(drive: DriveApi, row: FileStat): Promise<void> {
  const fileId = row.extra.file_id as string
  const live = await drive.getFile(fileId)
  if (live.trashed === true) return
  const there = statFromItem(live)
  const parents = row.extra.parents as string[] | undefined
  const now = new Set((there.extra.parents as string[] | undefined) ?? [])
  const then = new Set(parents ?? [])
  const moved =
    parents !== undefined && (now.size !== then.size || [...then].some((id) => !now.has(id)))
  if (there.name !== row.name || moved) return
  await drive.deleteFile(fileId)
}

/** Whether an item is gone from Drive, or sits in its trash. Mirrors Python's `gone`. */
export async function gone(drive: DriveApi, fileId: string): Promise<boolean> {
  try {
    return (await drive.getFile(fileId, 'id,trashed')).trashed === true
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) return true
    throw err
  }
}

/**
 * Copy a file or folder server-side, handed what is at `src` and at `dst`
 * and its parent. `cp -r` merges into an existing folder and creates a
 * missing one, mirroring the msgraph copy_tree. A file it replaces is deleted
 * only once the copy has landed beside it, which Drive's two items of one name
 * in a folder allow (`deleteReplaced`): a refused copy leaves it as it was, and
 * a refused delete drops the copy again and names the destination, as cp's
 * refused create does. Both paths naming one item (Drive lists a
 * legacy item under each of its parents) leaves nothing to copy; GNU cp
 * refuses it by inode, which a Drive row lacks. Answers the stat of what the
 * copy made, null when it merged into a folder already there or found the
 * item itself. Mirrors Python's `copy`.
 */
export const copy = eaccesOnDenied(async function (
  accessor: GDriveAccessor,
  src: PathSpec,
  dst: PathSpec,
  _signal?: AbortSignal,
  handed: Handed = {},
): Promise<FileStat | null> {
  const entry = handed.entry ?? null
  if (entry === null) throw enoent(src)
  const drive = accessor.drive
  const srcNode = nodeOf(entry)
  const dstEntry = await liveRow(accessor, dst, handed.dstEntry)
  const dstKey = dst.vfsPath
  const basename = dstKey.includes('/') ? dstKey.slice(dstKey.lastIndexOf('/') + 1) : dstKey
  if (srcNode.mimeType === FOLDER_MIME) {
    if (dstEntry !== null && dstEntry.type !== FileType.DIRECTORY) throw enotdir(dst)
    let made: FileStat | null = null
    let dstId: string
    if (dstEntry === null) {
      const [dstParentId] = await parentFolder(accessor, dst, handed.dstParent)
      const created = await drive.createFolder(basename, dstParentId)
      dstId = created.id
      made = statFromItem(created)
    } else {
      dstId = dstEntry.extra.file_id as string
    }
    await copyChildren(drive, srcNode, dstId)
    return made
  }
  if (dstEntry !== null && dstEntry.type === FileType.DIRECTORY) throw eisdir(dst)
  if (dstEntry !== null && dstEntry.extra.file_id === srcNode.id) return null
  const [dstParentId] = await parentFolder(accessor, dst, handed.dstParent)
  const target = driveTargetName(basename, srcNode.mimeType)
  if (dstEntry === null) {
    const made = await drive.copyFile(srcNode.id, target, dstParentId)
    const copied: unknown = made
    return typeof copied === 'object' && copied !== null ? statFromItem(made) : null
  }
  const item = await landThenRetire(
    () => drive.copyFile(srcNode.id, target, dstParentId),
    (made) => drive.deleteFile(made.id),
    async () => {
      try {
        await deleteReplaced(drive, dstEntry)
      } catch (err) {
        if (err instanceof GoogleApiError && err.status === 403) throw eacces(dst)
        throw err
      }
    },
    () => gone(drive, dstEntry.extra.file_id as string),
  )
  const copied: unknown = item
  return typeof copied === 'object' && copied !== null ? statFromItem(item) : null
})
