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

import type { DiskAccessor } from '../../accessor/disk.ts'
import { writeFile } from 'node:fs/promises'
import { invalidateAfterWrite } from '@struktoai/mirage-core/cache/context'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { ResourceName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { diskError } from './errors.ts'
import { resolveSafe } from './utils.ts'

export async function writeBytes(
  accessor: DiskAccessor,
  p: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const timer = startOp()
  const virtual = p.mountPath
  const full = resolveSafe(accessor.root, virtual)
  // A write is not `mkdir -p`: GNU reports ENOENT on a missing parent
  // rather than building the chain, and the store-backed backends refuse
  // the same way. Only the virtual path may reach a stderr line.
  try {
    await writeFile(full, data)
  } catch (err) {
    throw diskError(err, p)
  }
  record('write', virtual, ResourceName.DISK, data.byteLength, timer)
  await invalidateAfterWrite(p)
}
