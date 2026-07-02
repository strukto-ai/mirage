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

import {
  type Accessor,
  type CommandOpts,
  type IndexCacheStore,
  type PathSpec,
  Precision,
  ProvisionResult,
  type Resource,
} from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../../accessor/redis.ts'
import { stat as redisStat } from '../../../core/redis/stat.ts'

export interface RedisResourceLike extends Resource {
  readonly accessor: RedisAccessor
}

interface ResolvedSizes {
  resolved: [string, number][]
  missing: number
}

async function resolveSizes(
  accessor: RedisAccessor,
  paths: readonly PathSpec[],
  index: IndexCacheStore | undefined,
): Promise<ResolvedSizes> {
  const resolved: [string, number][] = []
  let missing = 0
  for (const p of paths) {
    const pathStr = p.virtual
    let size: number | null = null
    if (index !== undefined) {
      const lookup = await index.get(pathStr)
      if (lookup.entry !== undefined && lookup.entry !== null) {
        size = lookup.entry.size
      }
    }
    if (size === null) {
      try {
        const fileStat = await redisStat(accessor, p)
        size = fileStat.size
      } catch {
        // fall through — size stays null
      }
    }
    if (size !== null) {
      resolved.push([pathStr, size])
    } else {
      missing += 1
    }
  }
  return { resolved, missing }
}

export async function fileReadProvision(
  accessor: Accessor,
  paths: PathSpec[],
  _texts: string[],
  _opts: CommandOpts,
): Promise<ProvisionResult> {
  if (paths.length === 0) {
    return new ProvisionResult({ precision: Precision.UNKNOWN })
  }
  const { resolved, missing } = await resolveSizes(accessor as RedisAccessor, paths, undefined)
  if (missing > 0 || resolved.length === 0) {
    return new ProvisionResult({ precision: Precision.UNKNOWN })
  }
  const total = resolved.reduce((sum, [, size]) => sum + size, 0)
  return new ProvisionResult({
    networkReadLow: total,
    networkReadHigh: total,
    readOps: resolved.length,
    precision: Precision.EXACT,
  })
}

export async function headTailProvision(
  accessor: Accessor,
  paths: PathSpec[],
  _texts: string[],
  _opts: CommandOpts,
): Promise<ProvisionResult> {
  if (paths.length === 0) {
    return new ProvisionResult({ precision: Precision.UNKNOWN })
  }
  const { resolved, missing } = await resolveSizes(accessor as RedisAccessor, paths, undefined)
  if (missing > 0 || resolved.length === 0) {
    return new ProvisionResult({ precision: Precision.UNKNOWN })
  }
  const total = resolved.reduce((sum, [, size]) => sum + size, 0)
  return new ProvisionResult({
    networkReadLow: total,
    networkReadHigh: total,
    readOps: resolved.length,
    precision: Precision.EXACT,
  })
}

export function metadataProvision(
  _accessor: Accessor,
  paths: PathSpec[],
  _texts: string[],
  _opts: CommandOpts,
): ProvisionResult {
  const n = Math.max(1, paths.length > 0 ? paths.length : 1)
  return new ProvisionResult({
    networkReadLow: 0,
    networkReadHigh: 0,
    readOps: n,
    precision: Precision.EXACT,
  })
}
