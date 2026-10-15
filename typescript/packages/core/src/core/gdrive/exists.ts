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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { FileStat, PathSpec } from '../../types.ts'

/**
 * Whether anything is at `path`: the mount root, or a row its parent's
 * listing named. Mirrors Python's `exists`.
 */
export function exists(
  _accessor: GDriveAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): Promise<boolean> {
  return Promise.resolve(
    (entry !== null && entry !== undefined) || path.vfsPath.replace(/^\/+|\/+$/g, '') === '',
  )
}
