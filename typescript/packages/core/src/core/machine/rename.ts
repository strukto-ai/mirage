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
import type { PathSpec } from '../../types.ts'
import { singleQuote } from '../../utils/quote.ts'
import { inFolder, runChecked, machinePath } from './utils.ts'

/**
 * Rename on the source's machine, the destination taken as the new name
 * itself, never a directory to move into.
 *
 * @param accessor the mount's machines.
 * @param machine the source's machine.
 * @param src the source.
 * @param dst the new name.
 * @param makeParent make the new name's parent there first, when only
 *   another machine holds it.
 */
export async function rename(
  accessor: MachineAccessor,
  machine: string,
  src: PathSpec,
  dst: PathSpec,
  makeParent: boolean,
): Promise<void> {
  const old = singleQuote(machinePath(accessor, src))
  const fresh = machinePath(accessor, dst)
  const line = inFolder(`mv -T -- ${old} ${singleQuote(fresh)}`, fresh, makeParent)
  await runChecked(accessor, machine, line, dst)
}
