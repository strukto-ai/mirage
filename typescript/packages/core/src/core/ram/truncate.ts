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

import { record, startOp } from '../../observe/context.ts'
import type { RAMAccessor } from '../../accessor/ram.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { nowIso } from '../../utils/dates.ts'
import { norm } from '../../utils/path.ts'

import { einval } from '../../errors/fs.ts'
import { activePipe } from '../dev/device.ts'
import { checkCapacity, checkDestParents, checkWriteTarget } from './dest.ts'

/**
 * Set one key's length, padding with NULs or cutting it short. A live pipe
 * has no length to set: EINVAL, as ftruncate(2) answers for one (GNU:
 * `truncate -s 0 >(cat)` is "Invalid argument"), and for a length that is not
 * a whole, non-negative number of bytes. Mirrors Python's truncate.
 */
export async function truncate(
  accessor: RAMAccessor,
  path: PathSpec,
  length: number,
  noCreate = false,
): Promise<void> {
  const timer = startOp()
  const p = norm(path.mountPath)
  if (activePipe(accessor, p) !== null || !Number.isSafeInteger(length) || length < 0) {
    throw einval(path)
  }
  checkDestParents(accessor, path, p)
  checkWriteTarget(accessor, path, p)
  if (noCreate && !accessor.store.files.has(p)) return
  checkCapacity(accessor, path, p, length)
  const existing = accessor.store.files.get(p) ?? new Uint8Array()
  const out = new Uint8Array(length)
  out.set(existing.subarray(0, Math.min(existing.byteLength, length)))
  accessor.store.files.set(p, out)
  accessor.store.modified.set(p, nowIso())
  record('truncate', path.virtual, VFSName.RAM, 0, timer)
  return Promise.resolve()
}
