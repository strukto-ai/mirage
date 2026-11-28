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

import { liftLost, lostCount, record, startOp } from '../../observe/context.ts'
import type { WriteCondition } from '../../cache/types.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { eisdir, enoent, enotdir } from '../../errors/fs.ts'
import { uploadStat } from '../../utils/upload.ts'
import { updateFile, updateFolder, type BoxFileInfo, type BoxItem } from './api.ts'
import type { BoxTokenManager } from './client.ts'
import { clearFile, heldFile, replaceFile, retaken } from './copy.ts'
import { statFromItem } from './readdir.ts'
import { liveItemOf, parentFolder, pathParts } from './resolve.ts'
import { deleteEmptyFolder } from './rmdir.ts'

/**
 * Refuse a type mismatch with rename(2)'s own errnos. A mismatch outranks
 * emptiness, since real rename answers EISDIR for a file onto a directory
 * whether or not that directory has children. Mirrors Python's
 * `_refuse_mismatch`.
 */
function refuseMismatch(dst: PathSpec, existing: BoxItem, src: BoxItem): void {
  if (existing.type !== 'folder') {
    if (src.type === 'folder') throw enotdir(dst.virtual)
  } else if (src.type !== 'folder') {
    throw eisdir(dst.virtual)
  }
}

// Give `item` a name, and a folder unless `folderId` is undefined.
async function place(
  tm: BoxTokenManager,
  item: BoxItem,
  name: string,
  folderId: string | undefined,
): Promise<BoxItem> {
  const opts = folderId === undefined ? { name } : { name, parentId: folderId }
  return item.type === 'folder' ? updateFolder(tm, item.id, opts) : updateFile(tm, item.id, opts)
}

// The folder an item sits in, from a listing's `parent` or a lookup's
// `path_collection`. Mirrors Python's `_folder_of`.
function folderOf(
  item: BoxItem & Partial<Pick<BoxFileInfo, 'path_collection'>>,
): string | undefined {
  if (item.parent?.id) return item.parent.id
  return item.path_collection?.entries.at(-1)?.id
}

/**
 * Move `item` onto what holds `dst`'s name. A stale destination file is
 * refused before anything is sent. Box refuses a taken name, so the item lands
 * beside it under a staged name first, what it replaces goes next (a file held
 * to the version read, only an empty folder, which recursive=false gets from
 * Box for free, as rmdir does), and the item takes the name last: a refused
 * move leaves both as they were, and a refused delete or rename puts the item
 * back where it was. Mirrors Python's `_replace`.
 */
async function replaceOnto(
  accessor: BoxAccessor,
  item: BoxItem,
  dst: PathSpec,
  folderId: string,
  existing: BoxItem,
): Promise<BoxItem> {
  refuseMismatch(dst, existing, item)
  const tm = accessor.tokenManager
  const dstParts = pathParts(dst)
  const newName = dstParts[dstParts.length - 1] ?? ''
  const folder = existing.type === 'folder'
  let cond: WriteCondition | null = null
  let etag: string | null = null
  let live: BoxItem | null = existing
  if (!folder) [cond, live, etag] = await heldFile(accessor, dst, existing)
  const name =
    live === null ? newName : `${newName}.mirage-${crypto.randomUUID().replaceAll('-', '')}`
  let landed: BoxItem
  try {
    landed = await place(tm, item, name, folderId)
  } catch (err) {
    throw (await retaken(err, cond, dst)) ?? err
  }
  if (live === null) return landed
  try {
    if (folder) await deleteEmptyFolder(tm, live.id, dst)
    else await clearFile(accessor, dst, live, cond, etag)
    return await place(tm, landed, newName, undefined)
  } catch (err) {
    try {
      await place(tm, landed, item.name, folderOf(item))
    } catch (undo) {
      console.debug(`could not move ${item.name} back: ${String(undo)}`)
    }
    throw (await retaken(err, cond, dst)) ?? err
  }
}

/**
 * Move a file or folder whole; only a destination it replaces is held. A rename
 * onto its own name is a no-op, as rename(2) is: nothing is sent or recorded,
 * so the line keeps the version it read. Answers the item's stat where it
 * landed, null when the reply names none. Mirrors Python's `rename`.
 */
export async function rename(
  accessor: BoxAccessor,
  src: PathSpec,
  dst: PathSpec,
  handed: Handed = {},
): Promise<FileStat | null> {
  const tm = accessor.tokenManager
  const item = await liveItemOf(accessor, src, handed.entry)
  if (item === null) throw enoent(src.virtual)
  if (src.virtual === dst.virtual) return null
  const folderId = parentFolder(accessor, dst, handed.dstParent)
  const dstParts = pathParts(dst)
  const newName = dstParts[dstParts.length - 1] ?? ''
  const upto = lostCount()
  const timer = startOp()
  const existing = await liveItemOf(accessor, dst, handed.dstEntry)
  let moved: BoxItem
  if (existing !== null && existing.id !== item.id) {
    moved = await replaceOnto(accessor, item, dst, folderId, existing)
  } else {
    const cond =
      existing === null && item.type === 'file' ? await replaceFile(accessor, dst, null) : null
    try {
      moved = await place(tm, item, newName, folderId)
    } catch (err) {
      throw (await retaken(err, cond, dst)) ?? err
    }
  }
  // Only a folder has a subtree to drop, and only a positive "file" rules
  // one out. replaceOnto refused a file onto a folder, so dst held nothing
  // below it unless the moved item is a folder.
  const folder = item.type !== 'file'
  const op = folder ? 'rename_prefix' : 'rename'
  record(op, src.virtual, 'box', 0, timer)
  record(op, dst.virtual, 'box', 0, timer)
  liftLost(src, upto, folder)
  liftLost(dst, upto, folder)
  return uploadStat(moved, statFromItem, dst.virtual)
}
