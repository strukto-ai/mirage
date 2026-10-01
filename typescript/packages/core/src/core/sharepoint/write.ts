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
import { settleAfterWrite, writeGeneration } from '../../cache/context.ts'
import { record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { writeItem } from '../msgraph/drive.ts'
import { driveLoc, resolveItem } from './resolve.ts'

export async function write(
  accessor: SharePointAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const resolved = await resolveItem(accessor, path)
  const timer = startOp()
  const started = writeGeneration()
  const receipt = await writeItem(
    accessor.config,
    driveLoc(accessor.config, resolved, path.vfsPath),
    data,
  )
  record('write', path.virtual, 'sharepoint', data.length, timer)
  await settleAfterWrite(path, data, receipt, started)
}
