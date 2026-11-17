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
import { compareCodePoints } from '../../utils/sort.ts'
import { filesContaining as posixFilesContaining } from '../posix/search.ts'

/**
 * The files under a directory holding `text`, by grep on each machine that
 * holds it; any machine that cannot answer leaves every file to be read.
 *
 * @param accessor the mount's machines.
 * @param machines the machines holding the directory.
 * @param path the directory.
 * @param text the plain text.
 * @param ignoreCase fold ASCII case.
 */
export async function filesContaining(
  accessor: MachineAccessor,
  machines: string[],
  path: PathSpec,
  text: string,
  ignoreCase: boolean,
): Promise<PathSpec[] | null> {
  const hits = new Map<string, PathSpec>()
  for (const machine of machines) {
    const found = await posixFilesContaining(
      accessor.runner(machine),
      accessor.root,
      text,
      [path],
      ignoreCase,
    )
    if (found === null) return null
    for (const p of found) hits.set(p.virtual, p)
  }
  return [...hits].sort(([a], [b]) => compareCodePoints(a, b)).map(([, p]) => p)
}
