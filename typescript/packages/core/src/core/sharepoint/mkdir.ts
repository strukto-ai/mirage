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
import { invalidateAfterWrite, invalidateAncestors } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { isEnoent } from '../../utils/errors.ts'
import { baseName, createChildFolder, parentPath } from '../msgraph/drive.ts'
import { itemUrl } from './client.ts'
import { resolveItem } from './resolve.ts'

async function createDir(
  accessor: SharePointAccessor,
  driveId: string,
  path: string,
  virtual: string,
): Promise<void> {
  const config = accessor.config
  const parent = parentPath(path)
  await createChildFolder(config, itemUrl(config, driveId, parent, '/children'), baseName(path), {
    item: itemUrl(config, driveId, path),
    parent: itemUrl(config, driveId, parent),
    virtual,
  })
}

/**
 * Create every level of a drive path, from the drive root down.
 *
 * Args:
 *   accessor: the mount's accessor.
 *   driveId: the drive the path lives in.
 *   itemPath: the drive-relative path, keyPrefix included.
 *   virtual: the path a refusal names.
 */
async function createChain(
  accessor: SharePointAccessor,
  driveId: string,
  itemPath: string,
  virtual: string,
): Promise<void> {
  const parts = itemPath.split('/')
  for (let index = 1; index <= parts.length; index++) {
    await createDir(accessor, driveId, parts.slice(0, index).join('/'), virtual)
  }
}

/**
 * The keyPrefix a scoped mount's root folder chain lives at.
 *
 * Only a mount scoped to one site and drive places its paths under the
 * prefix, so only there is the mount root a folder chain that a folder
 * create can find missing. With parents the chain is already walked;
 * without, a create right under the root has to make it first.
 *
 * Args:
 *   accessor: the mount's accessor.
 */
function scopedPrefix(accessor: SharePointAccessor): string {
  const { site, drive, keyPrefix } = accessor.config
  return site !== null && drive !== null ? keyPrefix : ''
}

export async function mkdir(
  accessor: SharePointAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  if (path.vfsPath === '') return
  const resolved = await resolveItem(accessor, path)
  const driveId = resolved.driveId ?? ''
  const itemPath = resolved.itemPath ?? ''
  if (parents) {
    await createChain(accessor, driveId, itemPath, path.virtual)
  } else {
    try {
      await createDir(accessor, driveId, itemPath, path.virtual)
    } catch (error) {
      const prefix = scopedPrefix(accessor)
      const missingRoot = isEnoent(error) && prefix !== '' && parentPath(itemPath) === prefix
      if (!missingRoot) throw error
      await createChain(accessor, driveId, itemPath, path.virtual)
    }
  }
  await invalidateAfterWrite(path)
  if (parents) await invalidateAncestors(path)
}
