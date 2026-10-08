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
import { type LostPaths, lineVersion } from '../../observe/context.ts'
import {
  RecordIndex,
  type OpRecord,
  READ_FINGERPRINT_OPS,
  STAMP_FINGERPRINT_OPS,
  WRITE_FINGERPRINT_OPS,
} from '../../observe/record.ts'
import type { CacheFacts } from '../../types.ts'
import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import { compareCodePoints } from '../../utils/sort.ts'
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
 * Latest backend fingerprint a read recorded for `path`.
 *
 * Reads only: written bytes are decided by {@link writtenVerdict}, so there
 * is one rule per direction. Backends stamp a read record with the content
 * identifier they returned (S3 ETag, OneDrive cTag, Postgres sha256).
 * Threading it into the cache entry lets a `fresh` mount's `isFresh`
 * compare like with like. null means the bytes carry no token, and the
 * entry then stores none: an unverifiable copy is dropped and re-read,
 * which is what a fabricated one produced anyway on every backend whose
 * token is not an md5 of the content.
 *
 * Only the newest read of the path counts: when it carries no token, neither
 * does the entry, whatever an earlier read stamped. The backend did not vouch
 * for the bytes stored, and an older read's token would label bytes it never
 * described, which a later revert to that token serves as fresh.
 */
export function latestFingerprint(
  records: readonly OpRecord[] | undefined,
  path: string,
): string | null {
  if (records === undefined) return null
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]
    if (rec !== undefined && READ_FINGERPRINT_OPS.has(rec.op) && rec.path === path) {
      return rec.fingerprint === null || rec.fingerprint === '' ? null : rec.fingerprint
    }
  }
  return null
}

/**
 * Whether a line keeps the bytes it wrote to `path`, and their token.
 *
 * Only the newest `write` or `truncate` record of the path counts. Its
 * `claimed` value is what the command that made it put in `IOResult.writes`,
 * so it vouches for `written` only when it is that very value, or equal
 * bytes. Any other value means another writer landed last (a concurrent
 * pipeline stage, an `xargs -P` run, a background job, a door write that
 * claims nothing, a `truncate`), and neither the cached bytes nor the
 * pre-write entry are the file. A size other than `nbytes` means the write
 * moved other bytes than the command claims. A line with no write record
 * for the path keeps its bytes untokened.
 *
 * `written` is the original `IOResult.writes` value, never bytes joined
 * from it. On storage that does not isolate tasks (the browser host) a
 * command's record list can hold a sibling stage's write, so the claim is
 * not consulted; the size check and the newest write's token still hold.
 */
export function writtenVerdict(
  records: readonly OpRecord[] | undefined,
  path: string,
  written: ByteSource,
  nbytes: number,
): [keep: boolean, token: string | null] {
  if (records === undefined) return [true, null]
  let newest: OpRecord | undefined
  for (let i = records.length - 1; i >= 0 && newest === undefined; i--) {
    const rec = records[i]
    if (
      rec !== undefined &&
      (WRITE_FINGERPRINT_OPS.has(rec.op) || rec.op === 'truncate') &&
      rec.path === path
    )
      newest = rec
  }
  if (newest === undefined) return [true, null]
  if (newest.op === 'truncate') return [false, null]
  if (asyncContextIsolatesTasks) {
    const claimed = newest.claimed
    let same = claimed === written
    if (!same && claimed instanceof Uint8Array && written instanceof Uint8Array) {
      same = claimed.byteLength === written.byteLength
      for (let i = 0; same && i < claimed.byteLength; i++) same = claimed[i] === written[i]
    }
    if (!same) return [false, null]
  }
  if (newest.bytes !== nbytes) return [false, null]
  return [true, newest.fingerprint === '' ? null : newest.fingerprint]
}

/**
 * Store `data` for `path` under the mutation lock. `written` is the original
 * `IOResult.writes` value when `data` was written, null when a read produced
 * it.
 */
async function setCached(
  cache: FileCache,
  path: string,
  data: Uint8Array,
  written: ByteSource | null,
  records: readonly OpRecord[] | undefined,
  cacheFacts: ((path: string) => CacheFacts) | undefined,
): Promise<void> {
  await withCacheMutation(cache, async () => {
    const facts = cacheFacts?.(path)
    // `cacheable` is read first and short-circuits, so `ttl` is never
    // consulted for a path that is not being cached. That ordering is
    // what keeps an unresolvable mount from being read as "no bound".
    if (facts === undefined || facts.cacheable) {
      await setCachedLocked(cache, path, data, written, records, facts?.ttl ?? null)
    }
  })
}

async function setCachedLocked(
  cache: FileCache,
  path: string,
  data: Uint8Array,
  written: ByteSource | null,
  records: readonly OpRecord[] | undefined,
  ttl: number | null,
): Promise<void> {
  if (data.byteLength > cache.cacheLimit) {
    // Bytes over the whole cache limit would evict every warm entry.
    await cache.remove(path)
    return
  }
  if (written !== null) {
    const [keep, token] = writtenVerdict(records, path, written, data.byteLength)
    // The claimed path is skipped by applyIo's eviction loop, so the
    // pre-write entry has to go here.
    if (!keep) await cache.remove(path)
    else await store(cache, path, data, token, ttl)
    return
  }
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
  await store(cache, path, data, fingerprint, ttl)
}

/**
 * Store bytes the line settled on, never failing the line for it: the read
 * or write behind them already happened, and a store that refuses the fill
 * (out of memory, a value over its size limit) costs the next read a fetch,
 * so it is logged and the stale entry dropped. Mirrors Python's `_store`.
 */
async function store(
  cache: FileCache,
  path: string,
  data: Uint8Array,
  fingerprint: string | null,
  ttl: number | null,
): Promise<void> {
  try {
    await cache.set(path, data, { fingerprint, ttl })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`cache fill refused for ${path}: ${msg}`)
    try {
      await cache.remove(path)
    } catch (dropErr) {
      const why = dropErr instanceof Error ? dropErr.message : String(dropErr)
      console.warn(`stale copy not dropped for ${path}: ${why}`)
    }
  }
}

// The drain each read went to; a nested line hands its outer line them too.
const draining = new WeakMap<CachableAsyncIterator, Promise<void>>()

/**
 * Whether the line no longer knows the bytes it holds for `path`: its
 * conditional write lost, or its newest version record removed or moved it
 * (its own or an ancestor's). Mirrors Python's `_gone`.
 */
function gone(index: RecordIndex | undefined, lost: LostPaths | null, path: string): boolean {
  if (lost?.holds(path) === true) return true
  if (index === undefined) return false
  return retracted(index.newestVersion(path))
}

/** Whether a path's newest version record removed or moved it. */
function retracted(rec: OpRecord | null): boolean {
  return rec !== null && !STAMP_FINGERPRINT_OPS.has(rec.op)
}

/**
 * Keep the version each path last had on the line, on conditional mounts. A
 * read that fills no cache (`grep`, `head`) or a write that claims no bytes
 * (`>>`, a resize, a cross-mount `cp`) still names the version it saw, and
 * the next line's write on a conditional mount needs it; so does a refusal,
 * whose read may have been served from the cache and left no record. Runs
 * after the bytes are settled, so it never undoes a removal. Mirrors
 * Python's `_keep_versions`.
 */
async function keepVersions(
  cache: FileCache,
  records: readonly OpRecord[],
  index: RecordIndex,
  cacheFacts: (path: string) => CacheFacts,
  lost: LostPaths | null,
): Promise<void> {
  const paths = new Set(
    records
      .filter((rec) => STAMP_FINGERPRINT_OPS.has(rec.op) && (rec.fingerprint ?? '') !== '')
      .map((rec) => rec.path),
  )
  if (lost !== null) for (const key of lost.marks.keys()) if (lost.holds(key)) paths.add(key)
  const versions: Record<string, string> = {}
  for (const path of paths) {
    const facts = cacheFacts(path)
    if (!facts.cacheable || facts.keepsVersions !== true) continue
    const [, version] = lineVersion(index, lost, path)
    if (version !== null && version !== '') versions[path] = version
  }
  if (Object.keys(versions).length === 0) return
  try {
    await withCacheMutation(cache, () => cache.keepFingerprints(versions))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const paths = Object.keys(versions).sort(compareCodePoints)
    console.warn(
      `versions not kept for ${String(paths.length)} paths, first ${paths[0] ?? ''}: ${msg}`,
    )
  }
}

/**
 * Settle what a command read and wrote into the file cache. Mirrors
 * Python's `apply_io`.
 *
 * @param nested a nested line's (`eval`, `$(...)`): it keeps only the
 *   versions of paths still lost; its line keeps the rest.
 */
export async function applyIo(
  cache: FileCache,
  io: IOResult,
  cacheFacts?: (path: string) => CacheFacts,
  records?: readonly OpRecord[],
  lost: LostPaths | null = null,
  nested = false,
): Promise<void> {
  // A path both read and written is dropped: neither side is the file.
  const kept = io.cache.filter((p) => !(p in io.reads) || !(p in io.writes))
  const cacheSet = new Set(kept)
  const index = records !== undefined ? new RecordIndex(records) : undefined
  for (const path of kept) {
    const facts = cacheFacts?.(path)
    if (facts !== undefined && !facts.cacheable) continue
    // Only a conditional mount names what the line removed or lost.
    if ((facts === undefined || facts.keepsVersions === true) && gone(index, lost, path)) {
      await cache.remove(path)
      continue
    }
    // The token has to describe the bytes actually stored, so the side this
    // branch took decides which records label them. Set in the branch rather
    // than recovered from the result, so the two cannot disagree.
    let source: ByteSource | undefined = io.reads[path]
    let written: ByteSource | null = null
    if (source === undefined) {
      source = io.writes[path]
      written = source ?? null
    }
    if (source === undefined) continue
    if (source instanceof Uint8Array) {
      await setCached(cache, path, source, written, records, cacheFacts)
    } else if (source instanceof CachableAsyncIterator) {
      if (written !== null && (source.discarded || !source.exhausted)) {
        // No claimer returns a written stream it did not finish (a discard
        // marks a stream exhausted and empty), and its bytes are not the
        // file's; the eviction loop below skips claimed paths, so the
        // pre-write entry goes.
        await cache.remove(path)
        continue
      }
      if (source.discarded) continue
      if (source.exhausted) {
        await setCached(cache, path, concat(source.bufferedChunks), written, records, cacheFacts)
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
          draining.set(source, task)
          void task.finally(() => {
            if (tasks.get(path) === task) tasks.delete(path)
          })
        }
      }
    } else {
      const data = await materialize(source)
      await setCached(cache, path, data, written, records, cacheFacts)
    }
  }
  for (const path of Object.keys(io.writes)) {
    if (cacheSet.has(path)) continue
    if (cacheFacts !== undefined && !cacheFacts(path).cacheable) continue
    await cache.remove(path)
  }
  if (records !== undefined && index !== undefined && cacheFacts !== undefined) {
    await keepVersions(cache, nested ? [] : records, index, cacheFacts, lost)
  }
  // An unfinished read no drain owns is closed; unmount waits on it.
  for (const [path, source] of Object.entries(io.reads)) {
    if (!(source instanceof CachableAsyncIterator) || source.exhausted) continue
    const owner = draining.get(source)
    if (owner === undefined || cache.drainTasks?.get(path) !== owner) await source.discard()
  }
}

// Drains an unconsumed read stream and fills the cache, mirroring the
// Python _background_drain. Promises cannot be cancelled, so remove()/clear()
// delete the map entry and the result is discarded here instead. The
// fingerprint is looked up after the drain: streaming backends stamp their
// read record lazily, once the GET response arrives.
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
    const token = latestFingerprint(records, path)
    await withCacheMutation(cache, async () => {
      const facts = cacheFacts?.(path)
      // The large-object path stamps the bound too, or a streamed read
      // would be the one thing `bounded` never expires. Task identity
      // and cacheability are asked separately so this stays one
      // callback rather than two.
      if (isCurrent() && (facts === undefined || facts.cacheable)) {
        await cache.add(path, materialized, {
          fingerprint: token,
          ttl: facts?.ttl ?? null,
        })
      }
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`background drain failed for ${path}: ${msg}`)
  }
}
