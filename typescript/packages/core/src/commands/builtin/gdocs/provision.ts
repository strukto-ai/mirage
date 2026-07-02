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

import type { Accessor } from '../../../accessor/base.ts'
import type { GDocsAccessor } from '../../../accessor/gdocs.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { stat as gdocsStat } from '../../../core/gdocs/stat.ts'
import { Precision, ProvisionResult } from '../../../provision/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'

async function resolveSizes(
  accessor: GDocsAccessor,
  paths: readonly PathSpec[],
  index: IndexCacheStore | undefined,
): Promise<{ resolved: [string, number][]; missing: number }> {
  const resolved: [string, number][] = []
  let missing = 0
  for (const p of paths) {
    let size: number | null = null
    if (index !== undefined) {
      const lookup = await index.get(p.virtual)
      if (lookup.entry !== undefined && lookup.entry !== null) size = lookup.entry.size
    }
    if (size === null) {
      try {
        const fileStat = await gdocsStat(accessor, p, index)
        size = fileStat.size
      } catch {
        // ignore — counted as missing below
      }
    }
    if (size !== null) resolved.push([p.virtual, size])
    else missing += 1
  }
  return { resolved, missing }
}

export async function fileReadProvision(
  accessor: Accessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<ProvisionResult> {
  if (paths.length === 0) {
    return new ProvisionResult({ precision: Precision.UNKNOWN })
  }
  const index: IndexCacheStore | undefined = opts.index ?? undefined
  const { resolved, missing } = await resolveSizes(accessor as GDocsAccessor, paths, index)
  if (missing > 0 || resolved.length === 0) {
    return new ProvisionResult({ precision: Precision.UNKNOWN })
  }
  let total = 0
  for (const [, size] of resolved) total += size
  return new ProvisionResult({
    networkReadLow: total,
    networkReadHigh: total,
    readOps: resolved.length,
    precision: Precision.EXACT,
  })
}

export function metadataProvision(
  _accessor: Accessor,
  _paths: PathSpec[],
  _texts: string[],
  _opts: CommandOpts,
): ProvisionResult {
  return new ProvisionResult({
    networkReadLow: 0,
    networkReadHigh: 0,
    readOps: 0,
    precision: Precision.EXACT,
  })
}
