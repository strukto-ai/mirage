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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { BoxAccessor } from '../../accessor/box.ts'
import { invalidateAfterWrite } from '../../cache/context.ts'
import { PathSpec } from '../../types.ts'
import { eisdir, enoent, enotdir } from '../../utils/errors.ts'
import { copyFile, copyFolder, deleteFile, listFolderItems, type BoxItem } from './api.ts'
import { pathParts, resolveItem, resolveParentId } from './resolve.ts'
import { rstripVirtual } from './mkdir.ts'

function childSpec(parent: PathSpec, name: string): PathSpec {
  const prefix = mountPrefixOf(parent.virtual, parent.vfsPath)
  const virtual = `${rstripVirtual(parent.virtual)}/${name}`
  return PathSpec.fromStrPath(virtual, mountKey(virtual, prefix))
}

async function copyInto(accessor: BoxAccessor, item: BoxItem, dst: PathSpec): Promise<void> {
  const tm = accessor.tokenManager
  const dstParts = pathParts(dst)
  const existing = await resolveItem(accessor, dstParts)
  if (item.type === 'folder' && existing !== null && existing.type === 'folder') {
    // Merge into an existing folder (GNU cp -r semantics): copy each child
    // rather than replacing the folder, so pre-existing entries survive.
    for (const child of await listFolderItems(tm, item.id)) {
      await copyInto(accessor, child, childSpec(dst, child.name))
    }
    return
  }
  const dstParent = await resolveParentId(accessor, dstParts)
  if (dstParent === null) throw enoent(dst.virtual)
  const newName = dstParts[dstParts.length - 1] ?? ''
  if (existing !== null && existing.id !== item.id) {
    // Folder onto folder already merged above, so what is left is a type
    // mismatch or a file replacing a file. cp refuses either mismatch
    // (rename(2)'s own errnos), mirroring gdrive and the msgraph copyTree;
    // only a file gives way to a file.
    if (existing.type === 'folder') throw eisdir(dst.virtual)
    if (item.type === 'folder') throw enotdir(dst.virtual)
    await deleteFile(tm, existing.id)
  }
  if (item.type === 'folder') await copyFolder(tm, item.id, dstParent, newName)
  else await copyFile(tm, item.id, dstParent, newName)
  // Each landing, not only the operand: a merge adds children to a folder
  // whose listing an earlier stat may already hold.
  await invalidateAfterWrite(dst)
}

export async function copy(accessor: BoxAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const item = await resolveItem(accessor, pathParts(src))
  if (item === null) throw enoent(src.virtual)
  await copyInto(accessor, item, dst)
  await invalidateAfterWrite(dst)
}
