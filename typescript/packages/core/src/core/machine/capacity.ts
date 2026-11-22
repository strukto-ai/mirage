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
import { CapacityState, type CapacityResult, type PathSpec } from '../../types.ts'
import { singleQuote } from '../../utils/quote.ts'
import { runChecked } from './utils.ts'

/**
 * The space of the filesystem the root sits on, on one machine, from its
 * `df -Pk`; UNKNOWN when it cannot say.
 *
 * @param accessor the mount's machines.
 * @param machine the machine asked.
 * @param path the mount root, for an error.
 */
export async function capacity(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
): Promise<CapacityResult> {
  const out = await runChecked(accessor, machine, `df -Pk -- ${singleQuote(accessor.root)}`, path)
  const lines = new TextDecoder().decode(out).trim().split('\n')
  const fields = lines.length > 1 ? (lines[lines.length - 1] ?? '').split(/\s+/) : []
  const [total, used, available] = fields.slice(1, 4)
  if (
    total === undefined ||
    used === undefined ||
    available === undefined ||
    ![total, used, available].every((f) => /^\d+$/.test(f))
  ) {
    return { state: CapacityState.UNKNOWN }
  }
  return {
    state: CapacityState.QUOTA,
    total: Number(total) * 1024,
    used: Number(used) * 1024,
    available: Number(available) * 1024,
  }
}
