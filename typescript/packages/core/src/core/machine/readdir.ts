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
import { enotdir } from '../../errors/fs.ts'
import type { FsError } from '../../errors/types.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { TreeRow } from '../posix/types.ts'
import { rowStat, rows } from './stat.ts'

/**
 * A directory's children on every machine that holds it, each name once,
 * from one find on each machine. A machine that lacks it, or holds a file
 * there, is passed over; any other failure fails the listing, so no
 * machine's files go missing unseen.
 *
 * @param accessor the mount's machines.
 * @param machines the machines to list.
 * @param pathSpec the directory, or a glob in it.
 */
export async function readdir(
  accessor: MachineAccessor,
  machines: string[],
  pathSpec: PathSpec,
): Promise<FileStat[]> {
  const scope = pathSpec.pattern !== null ? pathSpec.dir : pathSpec
  const found = await Promise.allSettled(machines.map((m) => rows(accessor, m, scope, 1)))
  const merged = new Map<string, TreeRow>()
  let failure: FsError | null = null
  let listed = false
  for (const result of found) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason
      if (!(reason instanceof Error) || !('code' in reason) || reason.code !== 'ENOENT')
        throw reason
      failure ??= reason as FsError
      continue
    }
    const [top, ...below] = result.value
    if (top?.kind !== 'd') {
      failure = enotdir(scope)
      continue
    }
    listed = true
    for (const row of below) if (!merged.has(row.rel)) merged.set(row.rel, row)
  }
  if (!listed) throw failure ?? enotdir(scope)
  return [...merged]
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([name, row]) => rowStat(name, row))
}
