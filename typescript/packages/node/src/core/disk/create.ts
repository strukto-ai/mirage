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

import { writeFile } from 'node:fs/promises'
import { invalidateAfterWrite } from '@struktoai/mirage-core/cache/context'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { diskError } from './errors.ts'
import { resolveInside } from './utils.ts'

export async function create(accessor: DiskAccessor, path: PathSpec): Promise<void> {
  const timer = startOp()
  const full = await resolveInside(accessor.root, path)
  try {
    await writeFile(full, new Uint8Array())
  } catch (err) {
    throw diskError(err, path)
  }
  record('create', path.virtual, VFSName.DISK, 0, timer)
  await invalidateAfterWrite(path)
}
