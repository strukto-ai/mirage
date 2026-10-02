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
import { materialize, type ByteSource, type IOResult } from '../../io/types.ts'
import { READ_FINGERPRINT_OPS, type OpRecord } from '../../observe/record.ts'
import type { CacheFacts } from '../../types.ts'
import { drainBudget, type FileCache } from './mixin.ts'
import { KeyLock } from '../lock.ts'

const mutationLocks = new WeakMap<FileCache, KeyLock>()

/** Serialize cache fills with mount ownership changes, including remote writes. */
export function withCacheMutation<T>(cache: FileCache, fn: () => Promise<T>): Promise<T> {
  let lock = mutationLocks.get(cache)
  if (lock === undefined) {
    lock = new KeyLock()
    mutationLocks.set(cache, lock)
  }
  return lock.withLock('', fn)
}

/**
 * Backend fingerprint of the newest read of `path`.
 *
 * Backends stamp a read record with the content identifier they returned
 * (S3 ETag, OneDrive cTag, Postgres sha256). Threading it into the cache
 * entry lets a `fresh` mount's `isFresh` compare like with like. null means
 * the bytes carry no token, and the entry then stores none: an unverifiable
 * copy is dropped and re-read, which is what a fabricated one produced
 * anyway on every backend whose token is not an md5 of the content.
 *
 * Only the newest read of the path counts: when it carries no token,
 * neither does the entry, whatever an earlier read stamped. A write's token
 * never labels read bytes; a writer settles its own bytes with the cache
 * (`settleAfterWrite`).
 */
export function latestFingerprint(
  records: readonly OpRecord[] | undefined,
  path: string,
): string | null {
  if (records === undefined) return null
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]
    if (rec !== undefined && READ_FINGERPRINT_OPS.has(rec.op) && rec.path === path) {
      // The newest read is the one whose bytes are stored; an older read's
      // token would label bytes it never described, which a later revert to
      // that token serves as fresh.
      return rec.fingerprint === '' ? null : rec.fingerprint
    }
  }
  return null
}

async function setCached(
  cache: FileCache,
  path: string,
  data: Uint8Array,
  records: readonly OpRecord[] | undefined,
  cacheFacts: ((path: string) => CacheFacts) | undefined,
): Promise<void> {
  await withCacheMutation(cache, async () => {
    const facts = cacheFacts?.(path)
    // `cacheable` is read first and short-circuits, so `ttl` is never
    // consulted for a path that is not being cached. That ordering is
    // what keeps an unresolvable mount from being read as "no bound".
    if (facts === undefined || facts.cacheable) {
      await setCachedLocked(cache, path, data, records, facts?.ttl ?? null)
    }
  })
}

async function setCachedLocked(
  cache: FileCache,
  path: string,
  data: Uint8Array,
  records: readonly OpRecord[] | undefined,
  ttl: number | null,
): Promise<void> {
  const fingerprint = latestFingerprint(records, path)
  if (fingerprint === null && (await cache.exists(path))) {
    // A tokenless read over a live entry is a warm read: these bytes
    // came out of this entry, so re-setting would drop the backend
    // fingerprint and force a `fresh` mount to refetch, while fetching
    // the blob back to compare it with itself is the file over the wire
    // twice. Only `cp`'s guarded walk reads
    // the backend raw with an entry standing, and only under
    // `bounded`, which already calls that entry trusted.
    return
  }
  await cache.set(path, data, { fingerprint, ttl })
}

/**
 * Fill the cache with the bytes a command line read.
 *
 * `IOResult.cache` lists read paths only: a writer settles what it wrote
 * with the cache at the write (`settleAfterWrite`), and every other
 * mutation evicts at its mutation site.
 */
export async function applyIo(
  cache: FileCache,
  io: IOResult,
  cacheFacts?: (path: string) => CacheFacts,
  records?: readonly OpRecord[],
): Promise<void> {
  for (const path of io.cache) {
    if (cacheFacts !== undefined && !cacheFacts(path).cacheable) continue
    // The line also wrote the path, and an IOResult keeps no order between
    // a read and a write: the read may be the pre-write bytes
    // (`cat a; tee a`). The write already settled what the cache holds.
    if (io.writes[path] !== undefined) continue
    const source: ByteSource | undefined = io.reads[path]
    if (source === undefined) continue
    if (source instanceof Uint8Array) {
      await setCached(cache, path, source, records, cacheFacts)
    } else if (source instanceof CachableAsyncIterator) {
      if (source.discarded) continue
      if (source.exhausted) {
        await setCached(cache, path, concat(source.bufferedChunks), records, cacheFacts)
      } else {
        const tasks = cache.drainTasks
        if (tasks !== undefined && !tasks.has(path) && !(await cache.exists(path))) {
          const task: Promise<void> = backgroundDrain(
            cache,
            path,
            source,
            drainBudget(cache),
            () => tasks.get(path) === task,
            cacheFacts,
            records,
          )
          tasks.set(path, task)
          void task.finally(() => {
            if (tasks.get(path) === task) tasks.delete(path)
          })
        }
      }
    } else {
      const data = await materialize(source)
      await setCached(cache, path, data, records, cacheFacts)
    }
  }
}

// Drains an unconsumed stream and fills the cache, mirroring the Python
// _background_drain. Promises cannot be cancelled, so remove()/clear()
// delete the map entry and the result is discarded here instead. The
// fingerprint is looked up after the drain: streaming backends stamp
// their read record lazily, once the GET response arrives.
async function backgroundDrain(
  cache: FileCache,
  path: string,
  it: CachableAsyncIterator,
  maxBytes: number,
  isCurrent: () => boolean,
  cacheFacts?: (path: string) => CacheFacts,
  records?: readonly OpRecord[],
): Promise<void> {
  try {
    const materialized = await it.drainBounded(maxBytes)
    if (materialized === null) return
    await withCacheMutation(cache, async () => {
      const facts = cacheFacts?.(path)
      // The large-object path stamps the bound too, or a streamed read
      // would be the one thing `bounded` never expires. Task identity
      // and cacheability are asked separately so this stays one
      // callback rather than two.
      if (isCurrent() && (facts === undefined || facts.cacheable)) {
        await cache.add(path, materialized, {
          fingerprint: latestFingerprint(records, path),
          ttl: facts?.ttl ?? null,
        })
      }
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`background drain failed for ${path}: ${msg}`)
  }
}
