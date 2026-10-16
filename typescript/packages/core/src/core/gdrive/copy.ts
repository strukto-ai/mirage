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
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { eisdir, enoent, enotdir } from '../../errors/fs.ts'
import type { TokenManager } from '../google/client.ts'
import { copyFile, createFolder, deleteFile, listFiles } from '../google/drive.ts'
import { liveRow, statFromItem } from './readdir.ts'
import type { DriveNode } from './resolve.ts'
import {
  driveTargetName,
  eaccesOnDenied,
  isFolder,
  nodeFromItem,
  nodeOf,
  parentFolder,
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

/**
 * Copy a file or folder server-side, handed what is at `src` and at `dst`
 * and its parent. `cp -r` merges into an existing folder and creates a
 * missing one, mirroring the msgraph copy_tree. Answers the stat of what the
 * copy made, null when it merged into a folder already there. Mirrors
 * Python's `copy`.
 */
async function copyImpl(
  accessor: GDriveAccessor,
  src: PathSpec,
  dst: PathSpec,
  _signal?: AbortSignal,
  handed: Handed = {},
): Promise<FileStat | null> {
  const entry = handed.entry ?? null
  if (entry === null) throw enoent(src)
  const tm = accessor.tokenManager
  const srcNode = nodeOf(entry)
  const dstEntry = await liveRow(accessor, dst, handed.dstEntry)
  const dstKey = dst.vfsPath
  const basename = dstKey.includes('/') ? dstKey.slice(dstKey.lastIndexOf('/') + 1) : dstKey
  if (isFolder(srcNode)) {
    if (dstEntry !== null && dstEntry.type !== FileType.DIRECTORY) throw enotdir(dst)
    let made: FileStat | null = null
    let dstId: string
    if (dstEntry === null) {
      const [dstParentId] = await parentFolder(accessor, dst, handed.dstParent)
      const created = await createFolder(tm, basename, dstParentId)
      dstId = created.id
      made = statFromItem(created)
    } else {
      dstId = dstEntry.extra.file_id as string
    }
    await copyChildren(tm, srcNode, dstId)
    return made
  }
  if (dstEntry !== null && dstEntry.type === FileType.DIRECTORY) throw eisdir(dst)
  if (dstEntry !== null) await deleteFile(tm, dstEntry.extra.file_id as string)
  const [dstParentId] = await parentFolder(accessor, dst, handed.dstParent)
  const item = await copyFile(
    tm,
    srcNode.id,
    driveTargetName(basename, srcNode.mimeType),
    dstParentId,
  )
  const copied: unknown = item
  return typeof copied === 'object' && copied !== null ? statFromItem(item) : null
}

export const copy = eaccesOnDenied(copyImpl)
