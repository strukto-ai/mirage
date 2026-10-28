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

import type { RedisAccessor } from '../../accessor/redis.ts'
import { CapacityState, type CapacityResult, type PathSpec } from '../../types.ts'
import { norm } from '../../utils/path.ts'

/**
 * The server's memory, for df, from `INFO memory`: its `maxmemory` limit as
 * the total and `used_memory` as used, the rest available.
 *
 * The numbers are the server's, whatever share of its keys the mount holds. A
 * server with no limit set (`maxmemory` 0) grows until its host stops it,
 * ELASTIC; one that does not answer INFO (the command renamed away or refused)
 * is UNKNOWN. Mirrors Python's `capacity`.
 */
export async function capacity(accessor: RedisAccessor): Promise<CapacityResult> {
  let text: string
  try {
    text = await accessor.store.infoMemory()
  } catch (err) {
    console.debug(`redis INFO memory unanswered: ${String(err)}`)
    return { state: CapacityState.UNKNOWN }
  }
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const cut = line.indexOf(':')
    if (cut > 0) fields.set(line.slice(0, cut), line.slice(cut + 1))
  }
  const used = fields.get('used_memory') ?? ''
  const limit = fields.get('maxmemory') ?? ''
  if (!/^\d+$/.test(used) || !/^\d+$/.test(limit)) return { state: CapacityState.UNKNOWN }
  if (Number(limit) === 0) return { state: CapacityState.ELASTIC }
  return {
    state: CapacityState.QUOTA,
    total: Number(limit),
    used: Number(used),
    available: Math.max(Number(limit) - Number(used), 0),
  }
}

/** The bytes at `path`, a directory's files included; 0 for none. Mirrors
 * Python's `size_of`. */
export async function sizeOf(accessor: RedisAccessor, path: PathSpec): Promise<number> {
  const store = accessor.store
  const key = norm(path.mountPath)
  if (await store.hasFile(key)) return store.fileLen(key)
  const files = await store.listFiles(key.endsWith('/') ? key : `${key}/`)
  const sizes = await Promise.all(files.map((f) => store.fileLen(f)))
  return sizes.reduce((a, b) => a + b, 0)
}

/** The bytes every file of the mount holds. Mirrors Python's `count`. */
export async function count(accessor: RedisAccessor): Promise<number> {
  const store = accessor.store
  const sizes = await Promise.all((await store.listFiles()).map((f) => store.fileLen(f)))
  return sizes.reduce((a, b) => a + b, 0)
}
