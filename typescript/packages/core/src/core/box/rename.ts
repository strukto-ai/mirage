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
import { eisdir, enoent, enotdir, enotempty } from '../../errors/fs.ts'
import { uploadStat } from '../../utils/upload.ts'
import {
  getFileInfo,
  getFolderInfo,
  listFolderItems,
  type BoxFileInfo,
  type BoxItem,
} from './api.ts'
import type { BoxTokenManager } from './client.ts'
import { heldFile, place, replaceFile, replaceItem, retaken } from './copy.ts'
import { statFromItem } from './readdir.ts'
import { liveItemOf, parentFolder, pathParts } from './resolve.ts'

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

// The folder an item sits in, from a listing's `parent` or a lookup's
// `path_collection`. Mirrors Python's `_folder_of`.
function folderOf(
  item: BoxItem & Partial<Pick<BoxFileInfo, 'path_collection'>>,
): string | undefined {
  if (item.parent?.id) return item.parent.id
  return item.path_collection?.entries.at(-1)?.id
}

/**
 * The item a move onto `name` in `folderId` landed, read by its id, null while
 * it is not there. Mirrors Python's `_moved_as`.
 */
async function movedAs(
  tm: BoxTokenManager,
  item: BoxItem,
  name: string,
  folderId: string,
): Promise<BoxItem | null> {
  const info: BoxItem & Partial<Pick<BoxFileInfo, 'path_collection'>> =
    item.type === 'folder' ? await getFolderInfo(tm, item.id) : await getFileInfo(tm, item.id)
  return info.name === name && folderOf(info) === folderId ? info : null
}

/**
 * Move `item` onto what holds `dst`'s name. A stale destination file is
 * refused before anything is sent, and so is a folder that holds anything, the
 * item itself included (`mv -T d/c d`). The rest is `replaceItem`, whose undo
 * for a landed item moves it back to its folder and name, held to the version
 * it landed as, and which finds a move whose answer was lost by the item's id
 * (`movedAs`). Mirrors Python's `_replace_onto`.
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
  let cond: WriteCondition | null = null
  let etag: string | null = null
  let live: BoxItem | null = existing
  if (existing.type === 'folder') {
    if ((await listFolderItems(tm, existing.id, { limit: 1 })).length > 0) {
      throw enotempty(dst.virtual)
    }
  } else {
    ;[cond, live, etag] = await heldFile(accessor, dst, existing)
  }
  if (live === null) {
    try {
      return await place(tm, item, newName, folderId)
    } catch (err) {
      throw (await retaken(err, cond, dst)) ?? err
    }
  }
  return replaceItem(
    accessor,
    dst,
    live,
    cond,
    etag,
    () => place(tm, item, newName, folderId),
    (landed) => place(tm, landed, item.name, folderOf(item), landed.etag ?? null),
    () => movedAs(tm, item, newName, folderId),
  )
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
