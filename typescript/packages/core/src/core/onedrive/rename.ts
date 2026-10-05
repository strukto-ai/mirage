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
import { invalidateAfterMove } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { renameReplace } from '../msgraph/drive.ts'
import { driveLoc } from './client.ts'

export async function rename(
  accessor: OneDriveAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const config = accessor.config
  const { moved, replacedNonFile } = await renameReplace(
    config,
    driveLoc(config, src.vfsPath),
    driveLoc(config, dst.vfsPath),
  )
  // A folder carries a subtree under both names. dst also loses one when
  // the move replaced anything there but a file (an empty folder, or an
  // item of no known kind), whose name may still have cached children.
  // Only a file facet narrows; a reply that names no type keeps the
  // subtree.
  const folder = !('file' in moved)
  await invalidateAfterMove(dst, folder || replacedNonFile)
  await invalidateAfterMove(src, folder)
}
