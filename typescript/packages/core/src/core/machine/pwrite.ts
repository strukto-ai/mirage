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

import type { MachineAccessor } from '../../accessor/machine.ts'
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { singleQuote } from '../../utils/quote.ts'
import { checked, remote } from './utils.ts'
import { staged } from './write.ts'

/**
 * Write bytes at an offset, as pwrite(2): the rest of the file stays, a gap
 * reads back as zeros, a missing file is made.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the file.
 * @param data the bytes.
 * @param offset where they start.
 */
export async function pwrite(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  data: Uint8Array,
  offset: number,
): Promise<void> {
  const timer = startOp()
  const seek = `seek=${String(offset)} oflag=seek_bytes conv=notrunc status=none`
  if (accessor.handle(machine).takesInput) {
    const target = singleQuote(remote(accessor, path))
    await checked(accessor, machine, `dd of=${target} ${seek}`, path, data)
  } else {
    await staged(accessor, machine, path, data, (st, t) => `dd if=${st} of=${t} ${seek}`)
  }
  record('pwrite', path.virtual, VFSName.MACHINE, data.byteLength, timer)
}
