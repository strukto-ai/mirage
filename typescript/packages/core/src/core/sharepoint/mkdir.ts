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
import { enotdir, isEexist, isEnoent } from '../../utils/errors.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { baseName, createChildFolder, parentPath } from '../msgraph/drive.ts'
import { itemUrl } from './client.ts'
import { resolveItem } from './resolve.ts'

async function createDir(
  accessor: SharePointAccessor,
  driveId: string,
  path: string,
  virtual: string,
  existOk: boolean,
): Promise<void> {
  const config = accessor.config
  const parent = parentPath(path)
  await createChildFolder(
    config,
    itemUrl(config, driveId, parent, '/children'),
    baseName(path),
    {
      item: itemUrl(config, driveId, path),
      parent: itemUrl(config, driveId, parent),
      virtual,
    },
    existOk,
  )
}

/**
 * Create every level of a drive path, from the drive root down.
 *
 * Args:
 *   accessor: the mount's accessor.
 *   driveId: the drive the path lives in.
 *   itemPath: the drive-relative path, keyPrefix included.
 *   path: the operand.
 *   parents: `-p`: a folder at the operand passes, and a file in the way is
 *     named rather than the operand.
 */
async function createChain(
  accessor: SharePointAccessor,
  driveId: string,
  itemPath: string,
  path: PathSpec,
  parents: boolean,
): Promise<void> {
  const parts = itemPath.split('/')
  const shown = rstripSlash(path.virtual).split('/')
  const depth = path.vfsPath.split('/').filter((part) => part !== '').length
  for (let index = 1; index <= parts.length; index++) {
    try {
      await createDir(
        accessor,
        driveId,
        parts.slice(0, index).join('/'),
        path.virtual,
        parents || index < parts.length,
      )
    } catch (error) {
      const above = parts.length - index
      if (!isEexist(error) || above === 0) throw error
      // `mkdir -p` names the file it stops at, as GNU does, and a file in the
      // hidden keyPrefix as the mount root it blocks; mkdir(2) blames the
      // operand.
      const level = shown.slice(0, -Math.min(above, depth)).join('/') || '/'
      throw enotdir(parents ? level : path)
    }
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
    await createChain(accessor, driveId, itemPath, path, true)
  } else {
    try {
      await createDir(accessor, driveId, itemPath, path.virtual, false)
    } catch (error) {
      const prefix = scopedPrefix(accessor)
      const missingRoot = isEnoent(error) && prefix !== '' && parentPath(itemPath) === prefix
      if (!missingRoot) throw error
      await createChain(accessor, driveId, itemPath, path, false)
    }
  }
  await invalidateAfterWrite(path)
  if (parents) await invalidateAncestors(path)
}
