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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { directoryPath, readdirItems } from '../msgraph/drive.ts'
import { driveLoc, listDrives, listSites, resolve } from './resolve.ts'

// A namespace level (the sites, or one site's libraries) as rows. Mirrors
// Python's `_folders`.
function folders(names: readonly string[]): FileStat[] {
  return [...names]
    .sort(compareCodePoints)
    .map((name) => new FileStat({ name, type: FileType.DIRECTORY }))
}

export async function readdir(accessor: SharePointAccessor, path: PathSpec): Promise<FileStat[]> {
  const target = directoryPath(path)
  const resolved = await resolve(accessor, target)
  if (resolved.level === 'root') return folders(await listSites(accessor))
  if (resolved.level === 'site' && resolved.siteId !== null) {
    return folders(await listDrives(accessor, resolved.siteId))
  }
  if (resolved.driveId === null) return []
  return readdirItems(accessor.config, driveLoc(accessor.config, resolved, target.vfsPath), target)
}
