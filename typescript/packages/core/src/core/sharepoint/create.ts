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
import { invalidateAfterWrite } from '../../cache/context.ts'
import { activeRecorder, record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { writeItem } from '../msgraph/drive.ts'
import { driveLoc, resolveItem } from './resolve.ts'

/**
 * Create an empty file.
 *
 * Not a delegation to `write`: that records the op as 'write', so a guest
 * creating a file and one writing one would be the same row in the ledger.
 *
 * Args:
 *   accessor: SharePoint accessor.
 *   path: the file to create.
 */
export async function create(accessor: SharePointAccessor, path: PathSpec): Promise<void> {
  const recorder = activeRecorder()
  const resolved = await resolveItem(accessor, path)
  const timer = startOp(recorder)
  await writeItem(
    accessor.config,
    driveLoc(accessor.config, resolved, path.vfsPath),
    new Uint8Array(),
  )
  record('create', path.virtual, 'sharepoint', 0, timer)
  await invalidateAfterWrite(path)
}
