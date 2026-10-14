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
import { renameReplace } from '../msgraph/drive.ts'
import { driveLoc, resolveItem } from './resolve.ts'

export async function rename(
  accessor: SharePointAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const config = accessor.config
  const srcResolved = await resolveItem(accessor, src)
  const dstResolved = await resolveItem(accessor, dst)
  await renameReplace(
    config,
    driveLoc(config, srcResolved, src.vfsPath),
    driveLoc(config, dstResolved, dst.vfsPath),
  )
}
