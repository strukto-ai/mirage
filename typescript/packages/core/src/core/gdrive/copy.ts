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
import { evictAfter, invalidateAfterWrite, invalidateSubtree } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent, enotdir } from '../../errors/fs.ts'
import type { TokenManager } from '../google/client.ts'
import { FOLDER_MIME, copyFile, createFolder, deleteFile, listFiles } from '../google/drive.ts'
import type { DriveNode } from './resolve.ts'
import {
  driveTargetName,
  eaccesOnDenied,
  isFolder,
  nodeFromItem,
  resolveKey,
  resolveParent,
} from './resolve.ts'

async function copyChildren(tm: TokenManager, src: DriveNode, dstFolderId: string): Promise<void> {
  const children = await listFiles(tm, { folderId: src.id, driveId: src.driveId })
  for (const item of children) {
    const child = nodeFromItem(item, src.driveId)
    if (isFolder(child)) {
      const created = await createFolder(tm, child.name, dstFolderId)
      await copyChildren(tm, child, created.id)
    } else {
      await copyFile(tm, child.id, child.name, dstFolderId)
    }
  }
}

async function copyNode(
  accessor: GDriveAccessor,
  srcNode: DriveNode,
  dst: PathSpec,
): Promise<void> {
  const tm = accessor.tokenManager
  let dstNode = await resolveKey(accessor, dst.vfsPath)
  const dstKey = dst.vfsPath
  const basename = dstKey.includes('/') ? dstKey.slice(dstKey.lastIndexOf('/') + 1) : dstKey
  if (isFolder(srcNode)) {
    if (dstNode !== null && !isFolder(dstNode)) throw enotdir(dst)
    if (dstNode === null) {
      // cp -r merges into an existing directory and creates a missing one,
      // mirroring the msgraph copy_tree.
      const [dstParentId] = await resolveParent(accessor, dst)
      const created = await createFolder(tm, basename, dstParentId)
      dstNode = {
        id: created.id,
        name: basename,
        mimeType: FOLDER_MIME,
        driveId: srcNode.driveId,
      }
    }
    await copyChildren(tm, srcNode, dstNode.id)
  } else {
    if (dstNode !== null && isFolder(dstNode)) throw eisdir(dst)
    if (dstNode !== null) await deleteFile(tm, dstNode.id)
    const [dstParentId] = await resolveParent(accessor, dst)
    await copyFile(tm, srcNode.id, driveTargetName(basename, srcNode), dstParentId)
  }
}

/**
 * Copy a file or folder server-side.
 *
 * A folder copy evicts the whole destination subtree: Drive keeps both files
 * when a merge lands a name that already exists, so a cached child key below
 * `dst` can now name another file. A file copy evicts just its target: a file
 * has nothing below it, so it skips the subtree walk, which asks every store
 * (a keyspace scan on Redis). The eviction runs also when the copy fails,
 * since a merge may have landed some children before one failed.
 */
async function copyImpl(accessor: GDriveAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const srcNode = await resolveKey(accessor, src.vfsPath)
  if (srcNode === null) throw enoent(src)
  const folder = isFolder(srcNode)
  await evictAfter(
    () => copyNode(accessor, srcNode, dst),
    () => (folder ? invalidateSubtree(dst) : invalidateAfterWrite(dst)),
  )
}

export const copy = eaccesOnDenied(copyImpl)
