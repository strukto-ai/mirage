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

import type { RAMAccessor } from '../../accessor/ram.ts'
import type { PathSpec } from '../../types.ts'
import { nowIso } from '../../utils/dates.ts'
import { norm } from '../../utils/path.ts'
import { activePipe } from '../dev/device.ts'
import { checkDestParents, checkWriteTarget, lookupError } from './dest.ts'
import { invalidateAfterWrite } from '../../cache/context.ts'
import { makeAbortError } from '../../utils/abort.ts'

/**
 * Copy one key onto another. A live pipe at either end is used as one: a
 * pipe source is read through its reader and a pipe destination written
 * into, so no bytes land in a row no reader sees (GNU: `cp <(printf x) f`
 * and `cp f >(cat)` both deliver). Mirrors Python's copy.
 */
export async function copy(
  accessor: RAMAccessor,
  src: PathSpec,
  dst: PathSpec,
  signal?: AbortSignal,
): Promise<void> {
  const s = norm(src.mountPath)
  const d = norm(dst.mountPath)
  checkDestParents(accessor, dst, d)
  const source = activePipe(accessor, s)
  const target = activePipe(accessor, d)
  if (source !== null && target !== null) {
    for await (const chunk of source.stream(src, signal)) await target.write(chunk, dst, signal)
    return
  }
  let data: Uint8Array | undefined
  if (source !== null) {
    data = await source.read(src, null, signal)
    // A caller that gave up (`timeout`) stores nothing.
    if (signal?.aborted === true) throw makeAbortError(signal)
    // The copy held no names while it waited on the pipe, so another job may
    // have moved or replaced the destination meanwhile: check it again, as a
    // write would, before storing.
    checkDestParents(accessor, dst, d)
  } else data = accessor.store.files.get(s)
  if (data === undefined) throw lookupError(accessor, src, s)
  if (target !== null) {
    await target.write(data, dst, signal)
    return
  }
  checkWriteTarget(accessor, dst, d)
  accessor.store.files.set(d, data)
  accessor.store.modified.set(d, nowIso())
  await invalidateAfterWrite(dst)
}
