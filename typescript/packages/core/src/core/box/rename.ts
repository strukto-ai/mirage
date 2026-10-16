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
import { updateFile, updateFolder, type BoxItem } from './api.ts'
import { replaceFile, retaken } from './copy.ts'
import { statFromItem } from './readdir.ts'
import { liveItemOf, parentFolder, pathParts } from './resolve.ts'
import { deleteEmptyFolder } from './rmdir.ts'

async function clearDest(
  accessor: BoxAccessor,
  dst: PathSpec,
  existing: BoxItem | null,
  src: BoxItem,
): Promise<WriteCondition | null> {
  // mv and cp overwrite; Box 409s on a name clash, so clear an existing dst.
  // A type mismatch is refused with rename(2)'s own errnos and outranks
  // emptiness, since real rename answers EISDIR for a file onto a directory
  // whether or not that directory has children. Only a folder gives way to a
  // folder, and then only an empty one: a non-empty one is mv's "Directory not
  // empty", which recursive=false gets from Box for free, as rmdir does.
  if (existing === null) return src.type === 'file' ? replaceFile(accessor, dst, null) : null
  if (existing.id === src.id) return null
  const tm = accessor.tokenManager
  if (existing.type !== 'folder') {
    if (src.type === 'folder') throw enotdir(dst.virtual)
    return replaceFile(accessor, dst, existing)
  }
  if (src.type !== 'folder') throw eisdir(dst.virtual)
  await deleteEmptyFolder(tm, existing.id, dst)
  return null
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
  const upto = lostCount()
  const timer = startOp()
  const cond = await clearDest(
    accessor,
    dst,
    await liveItemOf(accessor, dst, handed.dstEntry),
    item,
  )
  const newName = dstParts[dstParts.length - 1] ?? ''
  let moved: BoxItem
  try {
    if (item.type === 'folder')
      moved = await updateFolder(tm, item.id, { name: newName, parentId: folderId })
    else moved = await updateFile(tm, item.id, { name: newName, parentId: folderId })
  } catch (err) {
    throw (await retaken(err, cond, dst)) ?? err
  }
  // Only a folder has a subtree to drop, and only a positive "file" rules
  // one out. clearDest refused a file onto a folder, so dst held nothing
  // below it unless the moved item is a folder.
  const folder = item.type !== 'file'
  const op = folder ? 'rename_prefix' : 'rename'
  record(op, src.virtual, 'box', 0, timer)
  record(op, dst.virtual, 'box', 0, timer)
  liftLost(src, upto, folder)
  liftLost(dst, upto, folder)
  return uploadStat(moved, statFromItem, dst.virtual)
}
