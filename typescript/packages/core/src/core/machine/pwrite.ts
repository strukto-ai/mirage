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
import { enotsup } from '../../errors/fs.ts'
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { singleQuote } from '../../utils/quote.ts'
import { checked, remote } from './utils.ts'

/**
 * Write bytes at an offset, as pwrite(2): the rest of the file stays, a gap
 * reads back as zeros, a missing file is made. A machine whose exec takes
 * no input (Daytona) refuses it.
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
  if (!accessor.handle(machine).takesInput) throw enotsup('machine', 'pwrite', path)
  const timer = startOp()
  const seek = `seek=${String(offset)} oflag=seek_bytes conv=notrunc status=none`
  const target = singleQuote(remote(accessor, path))
  await checked(accessor, machine, `dd of=${target} ${seek}`, path, data)
  record('pwrite', path.virtual, VFSName.MACHINE, data.byteLength, timer)
}
