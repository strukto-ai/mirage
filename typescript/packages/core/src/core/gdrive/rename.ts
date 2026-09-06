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
import { invalidateSubtree } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent, enotempty } from '../../utils/errors.ts'
import { driveTargetName, eaccesOnDenied, isFolder, resolveKey, resolveParent } from './resolve.ts'

async function renameImpl(accessor: GDriveAccessor, src: PathSpec, dst: PathSpec): Promise<void> {
  const drive = accessor.drive
  const srcNode = await resolveKey(accessor, src.resourcePath)
  if (srcNode === null) throw enoent(src)
  const dstNode = await resolveKey(accessor, dst.resourcePath)
  if (dstNode !== null) {
    // GNU mv overwrites the destination: drop a conflicting file (or empty
    // folder) before the move. A non-empty folder conflict is mv's
    // "Directory not empty", mirroring the msgraph rename_replace.
    if (isFolder(dstNode)) {
      const children = await drive.listFiles({
        folderId: dstNode.id,
        driveId: dstNode.driveId,
        limit: 1,
      })
      if (children.length > 0) throw enotempty(dst)
    }
    await drive.deleteFile(dstNode.id)
  }
  const [srcParentId] = await resolveParent(accessor, src)
  const [dstParentId] = await resolveParent(accessor, dst)
  const dstKey = dst.resourcePath
  const basename = dstKey.includes('/') ? dstKey.slice(dstKey.lastIndexOf('/') + 1) : dstKey
  const name = driveTargetName(basename, srcNode)
  const move = dstParentId !== srcParentId
  await drive.patchFile(srcNode.id, {
    body: { name },
    ...(move ? { addParents: dstParentId, removeParents: srcParentId } : {}),
  })
  await invalidateSubtree(dst)
  await invalidateSubtree(src)
}

export const rename = eaccesOnDenied(renameImpl)
