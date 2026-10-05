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

import type { OneDriveAccessor } from '../../accessor/onedrive.ts'
import { invalidateAfterWrite, invalidateAncestors } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { enotdir, isEexist, isEnoent } from '../../utils/errors.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { baseName, createChildFolder, parentPath } from '../msgraph/drive.ts'
import { fullItemUrl, itemUrl } from './client.ts'

/**
 * Create the mount's `keyPrefix` folders, one level at a time.
 *
 * The mount root exists from the agent's side because it is mounted, but on
 * the drive it is a folder chain nothing has created until the first write.
 * A file upload creates its parents; a folder create does not, so mkdir has
 * to. The prefix is hidden, so a file in it is named as `root`: the mount
 * root is then not a directory.
 *
 * Args:
 *   accessor: the mount's accessor.
 *   root: the path a refusal in the prefix names.
 */
async function createRoot(accessor: OneDriveAccessor, root: string): Promise<void> {
  let parent = ''
  for (const name of accessor.config.keyPrefix.split('/')) {
    const level = parent === '' ? name : `${parent}/${name}`
    try {
      await createChildFolder(
        accessor.config,
        fullItemUrl(accessor.config, parent, '/children'),
        name,
        {
          item: fullItemUrl(accessor.config, level),
          parent: fullItemUrl(accessor.config, parent),
          virtual: root,
        },
      )
    } catch (error) {
      if (isEexist(error)) throw enotdir(root)
      throw error
    }
    parent = level
  }
}

async function createDir(
  accessor: OneDriveAccessor,
  path: string,
  virtual: string,
  root: string,
): Promise<void> {
  const config = accessor.config
  const parent = parentPath(path)
  const create = (): Promise<void> =>
    createChildFolder(config, itemUrl(config, parent, '/children'), baseName(path), {
      item: itemUrl(config, path),
      parent: itemUrl(config, parent),
      virtual,
    })
  try {
    await create()
  } catch (error) {
    const missingRoot = isEnoent(error) && parent === '' && config.keyPrefix !== ''
    if (!missingRoot) throw error
    await createRoot(accessor, root)
    await create()
  }
}

export async function mkdir(
  accessor: OneDriveAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const key = path.vfsPath
  if (key === '') return
  if (parents) {
    const prefix = rstripSlash(mountPrefixOf(path.virtual, path.vfsPath))
    const parts = key.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const level = parts.slice(0, index).join('/')
      const virtual = `${prefix}/${level}`
      try {
        await createDir(accessor, level, virtual, prefix === '' ? '/' : prefix)
      } catch (error) {
        // `mkdir -p` passes only a directory at the operand and names the
        // file it stops at above it, as GNU does.
        if (!isEexist(error) || index === parts.length) throw error
        throw enotdir(virtual)
      }
    }
  } else {
    await createDir(accessor, key, path.virtual, path.virtual)
  }
  await invalidateAfterWrite(path)
  if (parents) await invalidateAncestors(path)
}
