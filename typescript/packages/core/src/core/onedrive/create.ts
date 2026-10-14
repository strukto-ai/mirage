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

import { record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { writeItem } from '../msgraph/drive.ts'
import { driveLoc } from './client.ts'

/**
 * Create an empty file.
 *
 * Not a delegation to `write`: that records the op as 'write', so a guest
 * creating a file and one writing one would be the same row in the ledger.
 *
 * Args:
 *   accessor: OneDrive accessor.
 *   path: the file to create.
 */
export async function create(accessor: OneDriveAccessor, path: PathSpec): Promise<void> {
  const timer = startOp()
  await writeItem(accessor.config, driveLoc(accessor.config, path.vfsPath), new Uint8Array())
  record('create', path.virtual, 'onedrive', 0, timer)
}
