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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { GraphError, graphGet } from '../msgraph/client.ts'
import { asNumber, folderChildCount, statItem, virtualKey } from '../msgraph/drive.ts'
import { driveLoc } from './client.ts'

export async function stat(
  accessor: OneDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
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
  return statItem(
    accessor.config,
    driveLoc(accessor.config, path.vfsPath),
    path,
    virtualKey(path),
    index,
  )
}
