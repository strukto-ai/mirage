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

import { CachableAsyncIterator, concat } from '../../io/cachable_iterator.ts'
import { materialize, type IOResult } from '../../io/types.ts'
import type { OpRecord } from '../../observe/record.ts'
import { drainBudget, type FileCache } from './mixin.ts'

/**
 * Latest backend fingerprint recorded for a read of `path`.
 *
 * Backends stamp read records with the content identifier they returned
 * (S3 ETag, OneDrive cTag, Postgres sha256). Threading it into the cache
 * entry lets ALWAYS-mode `isFresh` compare like with like; the
 * MD5-of-content default only matches simple-PUT S3 objects.
 */
export function readFingerprint(
  records: readonly OpRecord[] | undefined,
  path: string,
): string | null {
  if (records === undefined) return null
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]
    if (rec?.op === 'read' && rec.path === path && rec.fingerprint) {
      return rec.fingerprint
    }
  }
  return null
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (a?.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

async function setCached(
  cache: FileCache,
  path: string,
  data: Uint8Array,
  records: readonly OpRecord[] | undefined,
): Promise<void> {
  const fingerprint = readFingerprint(records, path)
  if (fingerprint === null && bytesEqual(await cache.get(path), data)) {
    // Warm read: the bytes were served from this cache, so there is no
    // backend read record. Re-setting would replace the backend
    // fingerprint stamped on the cold read with the MD5 default and
    // force ALWAYS mode to evict and refetch on every read.
    return
  }
  await cache.set(path, data, { fingerprint })
}

export async function applyIo(
  cache: FileCache,
  io: IOResult,
  isCacheable?: (path: string) => boolean,
  records?: readonly OpRecord[],
): Promise<void> {
  const cacheSet = new Set(io.cache)
  for (const path of io.cache) {
    if (isCacheable !== undefined && !isCacheable(path)) continue
    const source = io.reads[path] ?? io.writes[path]
    if (source === undefined) continue
    if (source instanceof Uint8Array) {
      await setCached(cache, path, source, records)
    } else if (source instanceof CachableAsyncIterator) {
      if (source.exhausted) {
        await setCached(cache, path, concat(source.bufferedChunks), records)
      } else {
        const tasks = cache.drainTasks
        if (tasks !== undefined && !tasks.has(path) && !(await cache.exists(path))) {
          const task = backgroundDrain(cache, tasks, path, source, drainBudget(cache), records)
          tasks.set(path, task)
          void task.finally(() => {
            if (tasks.get(path) === task) tasks.delete(path)
          })
        }
      }
    } else {
      const data = await materialize(source)
      await setCached(cache, path, data, records)
    }
  }
  for (const path of Object.keys(io.writes)) {
    if (cacheSet.has(path)) continue
    if (isCacheable !== undefined && !isCacheable(path)) continue
    await cache.remove(path)
  }
}

// Drains an unconsumed stream and fills the cache, mirroring the Python
// _background_drain. Promises cannot be cancelled, so remove()/clear()
// delete the map entry and the result is discarded here instead. The
// fingerprint is looked up after the drain: streaming backends stamp
// their read record lazily, once the GET response arrives.
async function backgroundDrain(
  cache: FileCache,
  tasks: Map<string, Promise<void>>,
  path: string,
  it: CachableAsyncIterator,
  maxBytes: number,
  records?: readonly OpRecord[],
): Promise<void> {
  try {
    const [materialized, fullyDrained] = await it.drainBounded(maxBytes)
    if (!fullyDrained) {
      console.info(
        `cache drain budget exceeded for ${path} (>${String(maxBytes)} bytes), skipping fill`,
      )
      return
    }
    if (tasks.has(path)) {
      await cache.add(path, materialized, { fingerprint: readFingerprint(records, path) })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`background drain failed for ${path}: ${msg}`)
  }
}
