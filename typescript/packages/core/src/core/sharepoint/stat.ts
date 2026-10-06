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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { baseName, statItem, virtualKey } from '../msgraph/drive.ts'
import { driveLoc, requireItem, resolve } from './resolve.ts'

export async function stat(
  accessor: SharePointAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  if (path.vfsPath === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })
  const resolved = await resolve(accessor, path)
  if (resolved.level === 'site') {
    if (resolved.siteId === null) throw enoent(path)
    return new FileStat({ name: path.vfsPath, type: FileType.DIRECTORY })
  }
  if (resolved.level === 'drive') {
    if (resolved.driveId === null) throw enoent(path)
    return new FileStat({ name: baseName(path.vfsPath), type: FileType.DIRECTORY })
  }
  requireItem(path, resolved)
  return statItem(
    accessor.config,
    driveLoc(accessor.config, resolved, path.vfsPath),
    path,
    virtualKey(path),
    index,
  )
}
