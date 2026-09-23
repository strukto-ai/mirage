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
import { READ_FINGERPRINT_OPS, WRITE_FINGERPRINT_OPS, type OpRecord } from '../../observe/record.ts'
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
 * Latest backend fingerprint recorded for `path` by one of `ops`.
 *
 * Backends stamp a read record with the content identifier they returned
 * (S3 ETag, OneDrive cTag, Postgres sha256), and an object-store write
 * record with the token its PUT answered. Threading it into the cache
 * entry lets a `fresh` mount's `isFresh` compare like with like. null means
 * the bytes carry no token, and the entry then stores none: an unverifiable
 * copy is dropped and re-read, which is what a fabricated one produced
 * anyway on every backend whose token is not an md5 of the content.
 *
 * `ops` is the direction the caller took, never both. One line's records
 * span every statement and pipeline segment (`IOResult.merge` unions
 * them), so a path read and written on the same line carries a record of
 * each; asking for the wrong direction stamps the write's token onto the
 * bytes the read produced, and the entry then reads as fresh forever.
 */
function latestFingerprint(
  records: readonly OpRecord[] | undefined,
  path: string,
  ops: ReadonlySet<string>,
  nbytes: number,
): string | null {
  if (records === undefined) return null
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]
    if (rec !== undefined && ops.has(rec.op) && rec.path === path && rec.fingerprint) {
      if (WRITE_FINGERPRINT_OPS.has(rec.op) && rec.bytes !== nbytes) {
        // Direction is not identity: a line can hold several ops for one
        // path while applyIo stores the bytes of just one of them, and
        // `IOResult.merge` is right-wins on `writes`, so the empty
        // eviction marker a server-side `cp` leaves there displaces the
        // content `tee` wrote while `tee`'s record stays the last one (a
        // copy that streams writes its own record, and the guard catches
        // that one on the source's length instead). A token for a different
        // length describes different bytes, and a wrong token reads as
        // fresh for the life of the entry, so answer none and let the
        // content default stand.
        return null
      }
      return rec.fingerprint
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
  ops: ReadonlySet<string>,
): Promise<void> {
  await withCacheMutation(cache, async () => {
    const facts = cacheFacts?.(path)
    // `cacheable` is read first and short-circuits, so `ttl` is never
    // consulted for a path that is not being cached. That ordering is
    // what keeps an unresolvable mount from being read as "no bound".
    if (facts === undefined || facts.cacheable) {
      await setCachedLocked(cache, path, data, records, ops, facts?.ttl ?? null)
    }
  })
}

async function setCachedLocked(
  cache: FileCache,
  path: string,
  data: Uint8Array,
  records: readonly OpRecord[] | undefined,
  ops: ReadonlySet<string>,
  ttl: number | null,
): Promise<void> {
  const fingerprint = latestFingerprint(records, path, ops, data.byteLength)
  if (ops.has('read') && fingerprint === null && (await cache.exists(path))) {
    // A tokenless read over a live entry is a warm read: these bytes
    // came out of this entry, so re-setting would drop the backend
    // fingerprint and force a `fresh` mount to refetch, while fetching
    // the blob back to compare it with itself is the file over the wire
    // twice. Only `cp`'s guarded walk reads
    // the backend raw with an entry standing, and only under
    // `bounded`, which already calls that entry trusted.
    //
    // The direction gate keeps a write writing: a backend that stamps
    // no write token would otherwise skip the set and leave pre-write
    // bytes standing.
    return
  }
  await cache.set(path, data, { fingerprint, ttl })
}

export async function applyIo(
  cache: FileCache,
  io: IOResult,
  cacheFacts?: (path: string) => CacheFacts,
  records?: readonly OpRecord[],
): Promise<void> {
  const cacheSet = new Set(io.cache)
  for (const path of io.cache) {
    if (cacheFacts !== undefined && !cacheFacts(path).cacheable) continue
    // The token has to describe the bytes actually stored, so the lookup
    // asks about the side this branch took. Set in the branch rather
    // than recovered from the result, so the two cannot disagree.
    let source: ByteSource | undefined = io.reads[path]
    let ops = READ_FINGERPRINT_OPS
    if (source === undefined) {
      source = io.writes[path]
      ops = WRITE_FINGERPRINT_OPS
    }
    if (source === undefined) continue
    if (source instanceof Uint8Array) {
      await setCached(cache, path, source, records, cacheFacts, ops)
    } else if (source instanceof CachableAsyncIterator) {
      if (source.discarded) continue
      if (source.exhausted) {
        await setCached(cache, path, concat(source.bufferedChunks), records, cacheFacts, ops)
      } else {
        const tasks = cache.drainTasks
        if (tasks !== undefined && !tasks.has(path) && !(await cache.exists(path))) {
          const task: Promise<void> = backgroundDrain(
            cache,
            path,
            source,
            drainBudget(cache),
            () => tasks.get(path) === task,
            ops,
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
      await setCached(cache, path, data, records, cacheFacts, ops)
    }
  }
  for (const path of Object.keys(io.writes)) {
    if (cacheSet.has(path)) continue
    if (cacheFacts !== undefined && !cacheFacts(path).cacheable) continue
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
  path: string,
  it: CachableAsyncIterator,
  maxBytes: number,
  isCurrent: () => boolean,
  ops: ReadonlySet<string>,
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
          fingerprint: latestFingerprint(records, path, ops, materialized.byteLength),
          ttl: facts?.ttl ?? null,
        })
      }
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`background drain failed for ${path}: ${msg}`)
  }
}
