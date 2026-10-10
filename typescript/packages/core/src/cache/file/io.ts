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

import { type LostPaths, lineVersion } from '../../observe/context.ts'
import {
  RecordIndex,
  type OpRecord,
  READ_FINGERPRINT_OPS,
  STAMP_FINGERPRINT_OPS,
} from '../../observe/record.ts'
import type { CacheFacts } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { FileCache } from './mixin.ts'
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
 * Reads only: a write's own record labels the bytes it sent. Backends stamp a
 * read record with the content
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
 * Keep `data` for `path` under the mutation lock. The facts are read under
 * the lock, so a mount that stopped owning the path, or stopped caching it,
 * keeps nothing. `fingerprint` is the backend's token for the bytes, null
 * when it vouched for none. Mirrors Python's `set_cached`.
 */
export async function setCached(
  cache: FileCache,
  path: string,
  data: Uint8Array,
  fingerprint: string | null,
  cacheFacts: (path: string) => CacheFacts,
): Promise<void> {
  await withCacheMutation(cache, async () => {
    const facts = cacheFacts(path)
    if (!facts.cacheable) return
    if (data.byteLength > cache.cacheLimit) {
      // Bytes over the whole cache limit would evict every warm entry.
      await cache.remove(path)
      return
    }
    await store(cache, path, data, fingerprint, facts.ttl)
  })
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

/**
 * Keep the version each path last had on the line, on conditional mounts. A
 * read that fills no cache (`grep`, `head`) or a write that keeps no bytes
 * (`>>`, a resize, a cross-mount `cp`) still names the version it saw, and
 * the next line's write on a conditional mount needs it; so does a refusal,
 * whose read may have been served from the cache and left no record. Runs
 * when the line ends. Mirrors Python's `keep_versions`.
 *
 * @param nested a nested line's (`eval`, `$(...)`): it keeps only the
 *   versions of paths still lost; its line keeps the rest. Its read records
 *   do not count: a concurrent sibling stage records into the same list.
 */
export async function keepVersions(
  cache: FileCache,
  records: readonly OpRecord[],
  cacheFacts: (path: string) => CacheFacts,
  lost: LostPaths | null,
  nested = false,
): Promise<void> {
  const counted = nested ? records.filter((rec) => !READ_FINGERPRINT_OPS.has(rec.op)) : records
  const index = new RecordIndex(counted)
  const paths = new Set(
    nested
      ? []
      : counted
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
