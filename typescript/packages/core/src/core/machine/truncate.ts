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
import { runChecked, machinePath } from './utils.ts'

/**
 * Cut or extend a file to `length` bytes.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the file.
 * @param length its new size.
 * @param noCreate leave a missing file missing.
 */
export async function truncate(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  length: number,
  noCreate = false,
): Promise<void> {
  const target = singleQuote(machinePath(accessor, path))
  const keep = noCreate ? ' -c' : ''
  await runChecked(accessor, machine, `truncate${keep} -s ${String(length)} -- ${target}`, path)
}
