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

import type { SharePointAccessor } from '../../accessor/sharepoint.ts'
import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { enotempty } from '../../errors/fs.ts'
import { graphDelete } from '../msgraph/client.ts'
import { driveRootEmpty } from '../msgraph/drive.ts'
import { driveLoc, resolve } from './resolve.ts'

/**
 * Remove an empty folder.
 *
 * A Graph `DELETE /drives/{id}/items/{item}` removes a folder and
 * everything under it, so this is the same request `rmR` sends and the
 * emptiness check is the only thing separating them. Without it `rmdir`
 * destroyed the whole subtree for every caller that does not pre-check
 * emptiness itself, and the command builders are the only callers that do:
 * FUSE, `ws.vfs` and the sandbox runtimes all reach the op directly.
 *
 * Args:
 *   accessor: SharePoint accessor.
 *   path: folder to remove.
 */
export async function rmdir(accessor: SharePointAccessor, path: PathSpec): Promise<void> {
  if (path.vfsPath === '') return
  const resolved = await resolve(accessor, path)
  if (resolved.driveId === null || resolved.itemPath === null) return
  const loc = driveLoc(accessor.config, resolved, path.vfsPath)
  if (!(await driveRootEmpty(accessor.config, loc))) throw enotempty(path)
  await graphDelete(accessor.config, loc.item())
  await invalidateAfterUnlink(path)
}
