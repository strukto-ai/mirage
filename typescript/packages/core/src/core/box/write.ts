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
import { invalidateAfterUnlink, invalidateAfterWrite } from '../../cache/context.ts'
import { PathSpec } from '../../types.ts'
import { eisdir, enoent, enotdir } from '../../utils/errors.ts'
import {
  copyFile,
  copyFolder,
  createFolder,
  deleteFile,
  deleteFolder,
  downloadFile,
  listFolderItems,
  updateFile,
  updateFolder,
  uploadFileVersion,
  uploadNewFile,
  type BoxItem,
} from './api.ts'
import { pathParts, resolveItem, resolveParentId } from './resolve.ts'

export async function write(
  accessor: BoxAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const parts = pathParts(path)
  if (parts.length === 0) throw eisdir(path.virtual)
  const tm = accessor.tokenManager
  const existing = await resolveItem(accessor, parts)
  if (existing !== null && existing.type === 'file') {
    // Overwrite uploads a new version under the same id, keeping Box's own
    // name so a box-native file isn't renamed with the vfs suffix.
    await uploadFileVersion(tm, existing.id, existing.name, data)
  } else {
    const parentId = await resolveParentId(accessor, parts)
    if (parentId === null) throw enoent(path.virtual)
    await uploadNewFile(tm, parentId, parts[parts.length - 1] ?? '', data)
  }
  await invalidateAfterWrite(path)
}

async function invalidateLevels(path: PathSpec, count: number): Promise<void> {
  // `mkdir -p a/b/c` creates several levels; invalidate each one's parent
  // listing (not just the final target's) so a cached ancestor listing from
  // an earlier command re-fetches and sees the new folders. Box resolves ids
  // through those listings, so a stale ancestor hides new children.
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const segments = rstripVirtual(path.virtual).split('/')
  for (let i = 0; i < count; i++) {
    const depth = segments.length - count + i + 1
    const levelVirtual = segments.slice(0, depth).join('/') || '/'
    await invalidateAfterWrite(PathSpec.fromStrPath(levelVirtual, mountKey(levelVirtual, prefix)))
  }
}

function rstripVirtual(virtual: string): string {
  let end = virtual.length
  while (end > 1 && virtual.charCodeAt(end - 1) === 47) end--
  return virtual.slice(0, end)
}

export async function mkdir(accessor: BoxAccessor, path: PathSpec, parents = false): Promise<void> {
  const parts = pathParts(path)
  if (parts.length === 0) return
  const tm = accessor.tokenManager
  if (parents) {
    let curId = accessor.rootFolderId
    for (const name of parts) {
      const children = await listFolderItems(tm, curId)
      const match = children.find((c) => c.name === name)
      if (match !== undefined) {
        if (match.type !== 'folder') throw enotdir(path.virtual)
        curId = match.id
      } else {
        const created = await createFolder(tm, curId, name)
        curId = created.id
      }
    }
    await invalidateLevels(path, parts.length)
  } else {
    const parentId = await resolveParentId(accessor, parts)
    if (parentId === null) throw enoent(path.virtual)
    await createFolder(tm, parentId, parts[parts.length - 1] ?? '')
    await invalidateAfterWrite(path)
  }
}

export async function unlink(accessor: BoxAccessor, path: PathSpec): Promise<void> {
  const item = await resolveItem(accessor, pathParts(path))
  if (item === null) throw enoent(path.virtual)
  if (item.type === 'folder') throw eisdir(path.virtual)
  await deleteFile(accessor.tokenManager, item.id)
  await invalidateAfterUnlink(path)
}

export async function rmdir(accessor: BoxAccessor, path: PathSpec): Promise<void> {
  const item = await resolveItem(accessor, pathParts(path))
  if (item === null) throw enoent(path.virtual)
  if (item.type !== 'folder') throw enotdir(path.virtual)
  // recursive=false: Box 409s on a non-empty folder, matching POSIX rmdir.
  await deleteFolder(accessor.tokenManager, item.id, false)
  await invalidateAfterUnlink(path)
}

export async function rmR(accessor: BoxAccessor, path: PathSpec): Promise<void> {
  const parts = pathParts(path)
  if (parts.length === 0) return
  const item = await resolveItem(accessor, parts)
  if (item === null) throw enoent(path.virtual)
  if (item.type === 'folder') {
    await deleteFolder(accessor.tokenManager, item.id, true)
  } else {
    await deleteFile(accessor.tokenManager, item.id)
  }
  await invalidateAfterUnlink(path)
}

async function clearDest(accessor: BoxAccessor, dstParts: string[], srcId: string): Promise<void> {
  // GNU mv/cp overwrite; Box 409s on a name clash, so clear an existing dst.
  const existing = await resolveItem(accessor, dstParts)
  if (existing === null || existing.id === srcId) return
  const tm = accessor.tokenManager
  if (existing.type === 'folder') await deleteFolder(tm, existing.id, true)
  else await deleteFile(tm, existing.id)
}

export async function rename(accessor: BoxAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const tm = accessor.tokenManager
  const item = await resolveItem(accessor, pathParts(src))
  if (item === null) throw enoent(src.virtual)
  const dstParts = pathParts(dst)
  const dstParent = await resolveParentId(accessor, dstParts)
  if (dstParent === null) throw enoent(dst.virtual)
  await clearDest(accessor, dstParts, item.id)
  const newName = dstParts[dstParts.length - 1] ?? ''
  if (item.type === 'folder')
    await updateFolder(tm, item.id, { name: newName, parentId: dstParent })
  else await updateFile(tm, item.id, { name: newName, parentId: dstParent })
  await invalidateAfterWrite(dst)
  await invalidateAfterUnlink(src)
}

function childSpec(parent: PathSpec, name: string): PathSpec {
  const prefix = mountPrefixOf(parent.virtual, parent.resourcePath)
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
    if (existing.type === 'folder') await deleteFolder(tm, existing.id, true)
    else await deleteFile(tm, existing.id)
  }
  if (item.type === 'folder') await copyFolder(tm, item.id, dstParent, newName)
  else await copyFile(tm, item.id, dstParent, newName)
}

export async function copy(accessor: BoxAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const item = await resolveItem(accessor, pathParts(src))
  if (item === null) throw enoent(src.virtual)
  await copyInto(accessor, item, dst)
  await invalidateAfterWrite(dst)
}

export async function create(accessor: BoxAccessor, path: PathSpec): Promise<void> {
  // touch: create an empty file when absent. Box has no mtime-only API, so
  // touching an existing file is a no-op rather than a truncation.
  const existing = await resolveItem(accessor, pathParts(path))
  if (existing !== null) return
  await write(accessor, path, new Uint8Array(0))
}

export async function truncate(
  accessor: BoxAccessor,
  path: PathSpec,
  length: number,
): Promise<void> {
  const item = await resolveItem(accessor, pathParts(path))
  const data =
    item !== null && item.type === 'file'
      ? await downloadFile(accessor.tokenManager, item.id)
      : new Uint8Array(0)
  let next: Uint8Array
  if (length <= data.length) {
    next = data.slice(0, length)
  } else {
    next = new Uint8Array(length)
    next.set(data)
  }
  await write(accessor, path, next)
}

export async function exists(accessor: BoxAccessor, path: PathSpec): Promise<boolean> {
  if (pathParts(path).length === 0) return true
  return (await resolveItem(accessor, pathParts(path))) !== null
}
