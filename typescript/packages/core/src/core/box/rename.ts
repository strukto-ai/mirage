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
import { invalidateAfterMove } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent, enotdir, enotempty } from '../../errors/fs.ts'
import { BoxApiError } from './client.ts'
import { deleteFile, deleteFolder, updateFile, updateFolder, type BoxItem } from './api.ts'
import { pathParts, resolveItem, resolveParentId } from './resolve.ts'

async function clearDest(
  accessor: BoxAccessor,
  dst: PathSpec,
  dstParts: string[],
  src: BoxItem,
): Promise<void> {
  // GNU mv/cp overwrite; Box 409s on a name clash, so clear an existing dst.
  // A type mismatch is refused with rename(2)'s own errnos and outranks
  // emptiness, since real rename answers EISDIR for a file onto a directory
  // whether or not that directory has children. Only a folder gives way to a
  // folder, and then only an empty one: a non-empty one is mv's "Directory not
  // empty", which recursive=false gets from Box for free, as rmdir does.
  const existing = await resolveItem(accessor, dstParts)
  if (existing === null || existing.id === src.id) return
  const tm = accessor.tokenManager
  if (existing.type !== 'folder') {
    if (src.type === 'folder') throw enotdir(dst.virtual)
    await deleteFile(tm, existing.id)
    return
  }
  if (src.type !== 'folder') throw eisdir(dst.virtual)
  try {
    await deleteFolder(tm, existing.id, false)
  } catch (error) {
    if (error instanceof BoxApiError && error.status === 409) throw enotempty(dst)
    throw error
  }
}

export async function rename(accessor: BoxAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const tm = accessor.tokenManager
  const item = await resolveItem(accessor, pathParts(src))
  if (item === null) throw enoent(src.virtual)
  const dstParts = pathParts(dst)
  const dstParent = await resolveParentId(accessor, dstParts)
  if (dstParent === null) throw enoent(dst.virtual)
  await clearDest(accessor, dst, dstParts, item)
  const newName = dstParts[dstParts.length - 1] ?? ''
  if (item.type === 'folder')
    await updateFolder(tm, item.id, { name: newName, parentId: dstParent })
  else await updateFile(tm, item.id, { name: newName, parentId: dstParent })
  // Only a folder has a subtree to drop, and only a positive "file" rules
  // one out. clearDest refused a file onto a folder, so dst held nothing
  // below it unless the moved item is a folder.
  const folder = item.type !== 'file'
  await invalidateAfterMove(dst, folder)
  await invalidateAfterMove(src, folder)
}
