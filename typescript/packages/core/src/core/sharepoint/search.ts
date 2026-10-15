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
import type { PathSpec } from '../../types.ts'
import type { DriveLoc } from '../msgraph/drive.ts'
import { filesContaining as graphFiles } from '../msgraph/search.ts'
import { driveLoc, resolve } from './resolve.ts'

/**
 * The files under `under` Graph search names, within one library. Search runs
 * inside one document library, so a scope above one (the sites, or a site's
 * libraries) answers null. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: SharePointAccessor,
  text: string,
  under: readonly PathSpec[],
): Promise<PathSpec[] | null> {
  const scopes: [PathSpec, DriveLoc][] = []
  for (const directory of under) {
    const resolved = await resolve(accessor, directory)
    if ((resolved.level !== 'drive' && resolved.level !== 'item') || !resolved.driveId) return null
    scopes.push([directory, driveLoc(accessor.config, resolved, directory.vfsPath)])
  }
  return graphFiles(accessor.config, scopes, text)
}
