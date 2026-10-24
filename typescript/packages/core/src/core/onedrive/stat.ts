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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { GraphError, graphGet } from '../msgraph/client.ts'
import { asNumber, batchTree, deltaTree, folderChildCount, statItem } from '../msgraph/drive.ts'
import { driveBase, driveLoc } from './client.ts'

export async function stat(accessor: OneDriveAccessor, path: PathSpec): Promise<FileStat> {
  if (path.vfsPath === '') {
    // The mount root is a real Graph item (`/drive/root` or the keyPrefix
    // folder); fetch it so modified is populated instead of synthesizing a
    // bare directory stat. Its `size` is Graph's aggregate subtree storage
    // number, not rendered content length: expose it as extra, like every
    // other folder (see entryStat).
    try {
      const item = await graphGet(accessor.config, driveLoc(accessor.config, '').item())
      return new FileStat({
        name: '/',
        type: FileType.DIRECTORY,
        modified: typeof item.lastModifiedDateTime === 'string' ? item.lastModifiedDateTime : null,
        extra: { size_bytes: asNumber(item.size), child_count: folderChildCount(item) },
      })
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) throw enoent(path)
      throw error
    }
  }
  return statItem(accessor.config, driveLoc(accessor.config, path.vfsPath), path)
}

/**
 * Every item under a folder, each as a listing's stat renders it.
 *
 * A personal drive answers from one read of Graph's `/delta` feed
 * (`deltaTree`): it starts the feed at any folder and carries each file's
 * `cTag`, the token its listing row holds. OneDrive for Business starts the
 * feed only at the drive root and leaves the `cTag` out, so its folders'
 * listings go out batched instead (`batchTree`), as they do for a feed that
 * does not answer and for a drive that will not say which kind it is. Which
 * kind the drive is, Graph's `driveType`, is asked once per mount. Mirrors
 * Python's `tree`.
 */
export async function tree(
  accessor: OneDriveAccessor,
  path: PathSpec,
  limit?: number,
): Promise<Map<string, FileStat> | null> {
  const config = accessor.config
  const loc = driveLoc(config, path.vfsPath)
  if (limit === undefined && (await driveType(accessor)) === 'personal') {
    const found = await deltaTree(config, loc)
    if (found !== null) return found
  }
  return batchTree(config, loc, path, limit)
}

/**
 * The drive's Graph `driveType`, asked on first use and kept; '' while Graph
 * refuses to say, which is asked again next time. Mirrors Python's
 * `_drive_type`.
 */
async function driveType(accessor: OneDriveAccessor): Promise<string> {
  if (accessor.driveType === null) {
    let drive: Record<string, unknown>
    try {
      drive = await graphGet(accessor.config, driveBase(accessor.config), {
        $select: 'driveType',
      })
    } catch (err) {
      if (!(err instanceof GraphError)) throw err
      console.debug(`onedrive drive type unanswered: ${err.message}`)
      return ''
    }
    accessor.driveType = typeof drive.driveType === 'string' ? drive.driveType : ''
  }
  return accessor.driveType
}
