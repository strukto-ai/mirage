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
import { spliceWindow } from '../../utils/ranges.ts'

import { activeDevice, activePipe } from '../dev/device.ts'
import { checkDestParents, checkWriteTarget } from './dest.ts'

/**
 * Write bytes at an offset of one key. A live pipe has no offset: its bytes
 * go into the pipe, in the order they are written, which is how an open
 * descriptor delivers to a FIFO (`exec >"$1"` and a link to a substitution
 * write through here). A device that discards writes (`/dev/null`) keeps
 * nothing, so windows written into it pad nothing up to their offset. Mirrors
 * Python's pwrite.
 */
export async function pwrite(
  accessor: RAMAccessor,
  path: PathSpec,
  data: Uint8Array,
  offset: number,
  signal?: AbortSignal,
): Promise<void> {
  const timer = startOp()
  const p = norm(path.mountPath)
  const pipe = activePipe(accessor, p)
  if (pipe !== null) {
    await pipe.write(data, path, signal)
    record('pwrite', path.virtual, VFSName.RAM, data.byteLength, timer)
    return
  }
  checkDestParents(accessor, path, p)
  checkWriteTarget(accessor, path, p)
  if (activeDevice(accessor, p) === null) {
    const existing = accessor.store.files.get(p) ?? new Uint8Array()
    accessor.store.files.set(p, spliceWindow(existing, offset, data))
  }
  accessor.store.modified.set(p, nowIso())
  record('pwrite', path.virtual, VFSName.RAM, data.byteLength, timer)
}
