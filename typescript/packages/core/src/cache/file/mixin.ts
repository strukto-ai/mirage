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

import type { PathSpec } from '../../types.ts'

export interface FileCache {
  get(key: string): Promise<Uint8Array | null>
  set(
    key: string,
    data: Uint8Array,
    options?: { fingerprint?: string | null; ttl?: number | null },
  ): Promise<void>
  /**
   * Drop `key`'s entry, and with `subtree` every entry below it but those
   * under an `excluded` nested mount root.
   *
   * The subtree is for a change that reaches below a name: a folder removed
   * or renamed, a mount taken down, or a mutation that names no path (an
   * account CLI writing to its service by id) and so can say only which
   * mount's keys went stale. Stores that own their keyspace remotely push the
   * filter down rather than enumerating. `'/'` with `subtree` is every key.
   */
  remove(key: string, options?: { subtree?: boolean; excluded?: readonly string[] }): Promise<void>
  exists(key: string | PathSpec): Promise<boolean>
  /**
   * The byte length of each key's live cached copy, in key order, null where
   * none is held, asked without fetching the bytes.
   */
  sizes(keys: readonly string[]): Promise<(number | null)[]>
  /**
   * The backend token each key's cached copy was stored with, in key order:
   * the version a conditional write sends. An entry past its bound still
   * answers where the store keeps it, since the token stays true for the
   * bytes read.
   */
  fingerprints(keys: readonly string[]): Promise<(string | null)[]>
  /**
   * Keep each key's version where its bytes are not kept. With no entry the
   * store keeps the version alone (reads treat it as absent, a conditional
   * write sends it); with bytes carrying the same token it keeps them and
   * lets the version outlive their bound; live bytes carrying another token
   * were written by someone else since, and are left alone (expired ones are
   * replaced).
   */
  keepFingerprints(fingerprints: Readonly<Record<string, string>>): Promise<void>
  isFresh(key: string, remoteFingerprint: string): Promise<boolean>
  /**
   * Whether an entry exists for `key` and carries no staleness bound.
   *
   * A `bounded` mount cannot serve one: nothing stamped a ttl before the
   * read policy existed, and a warm read short-circuits rather than
   * re-setting, so such an entry would never acquire a bound and never
   * expire. Dropping it makes the cold read that follows stamp one.
   *
   * Asked as one question rather than `exists` plus a ttl lookup so a warm
   * bounded read costs one store round trip, and so a missing entry
   * answers false rather than reading as unbounded.
   */
  isUnbounded(key: string): Promise<boolean>
  clear(): Promise<void>
  // Cached bytes / entry count; null (or absent) for stores that don't
  // track them client-side (e.g. redis owns its own keyspace).
  readonly cacheSize: number | null
  readonly cacheEntries?: number | null
  readonly cacheLimit: number
  maxDrainBytes: number | null
}

/**
 * Max bytes a streamed read may buffer to fill the cache.
 *
 * null (the default) caps each fill at 8 MiB or `cacheLimit`. An explicit
 * value keeps larger streams out of the cache and may not exceed the
 * cache's intended capacity. Mirrors Python `drain_budget`.
 */
export function drainBudget(cache: FileCache): number {
  validateMaxDrainBytes(cache.cacheLimit, cache.maxDrainBytes)
  return cache.maxDrainBytes ?? Math.min(cache.cacheLimit, 8 * 1024 * 1024)
}

export function validateMaxDrainBytes(cacheLimit: number, maxDrainBytes: number | null): void {
  if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 0) {
    throw new RangeError('cacheLimit must be a non-negative safe integer')
  }
  if (maxDrainBytes === null) return
  if (!Number.isSafeInteger(maxDrainBytes) || maxDrainBytes < 0) {
    throw new RangeError('maxDrainBytes must be a non-negative safe integer')
  }
  if (maxDrainBytes > cacheLimit) {
    throw new RangeError('maxDrainBytes cannot exceed cacheLimit')
  }
}
