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
import type { LiveFileIdentity } from '../../ops/types.ts'
import type { PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { identityItem } from '../msgraph/drive.ts'

// Bounded identity lookup: resolve to a drive item, then one plain GET.
export async function liveIdentity(
  accessor: SharePointAccessor,
  path: PathSpec,
): Promise<LiveFileIdentity> {
  if (path.resourcePath === '') throw eisdir(path)
  const resolved = await accessor.resolve(path.resourcePath)

  if (resolved.level === 'site') {
    if (resolved.siteId === null) throw enoent(path)
    throw eisdir(path)
  }
  if (resolved.level === 'drive') {
    if (resolved.driveId === null) throw enoent(path)
    throw eisdir(path)
  }
  if (resolved.driveId === null || resolved.itemPath === null) throw enoent(path)

  return identityItem(accessor.config, accessor.loc(resolved, path.resourcePath), path)
}
