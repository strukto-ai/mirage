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
import { invalidateAfterWrite } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent, enotdir } from '../../utils/errors.ts'
import type { TokenManager } from '../google/_client.ts'
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

async function copyImpl(accessor: GDriveAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const tm = accessor.tokenManager
  const srcNode = await resolveKey(accessor, src.resourcePath)
  if (srcNode === null) throw enoent(src)
  let dstNode = await resolveKey(accessor, dst.resourcePath)
  const dstKey = dst.resourcePath
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
  await invalidateAfterWrite(dst)
}

export const copy = eaccesOnDenied(copyImpl)
