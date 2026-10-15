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
import type { PathSpec } from '../../types.ts'
import { readItem } from '../msgraph/drive.ts'
import { driveLoc } from './client.ts'

/**
 * Read a file, optionally only a byte range of it.
 *
 * Args:
 *   accessor: OneDrive accessor.
 *   path: the path to read.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: OneDriveAccessor,
  path: PathSpec,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  return readItem(
    accessor.config,
    driveLoc(accessor.config, path.vfsPath),
    path.virtual,
    'onedrive',
    options?.offset ?? 0,
    options?.size ?? null,
  )
}
