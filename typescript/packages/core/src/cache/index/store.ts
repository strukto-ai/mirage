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

import type {
  Evicted,
  IndexEntry,
  IndexSnapshot,
  ListResult,
  LookupResult,
  SetDirOptions,
} from './config.ts'

export abstract class IndexCacheStore {
  /** Seconds a listing lives when its writer names no expiry. */
  abstract readonly ttl: number
  /**
   * Whether this store is a throwaway built for one freshness check. The
   * reconcile probe and the snapshot drift check stat through an empty store
   * dropped right after, so a backend that would list a whole folder to
   * answer a miss can ask for the one path instead. A mount's own index is
   * never scratch.
   */
  readonly scratch: boolean = false
  /**
   * Merge snapshots by path; deferred stores flush before operations or
   * close. Clear discards them. `version` replaces the version of every
   * listed folder, and null clears it.
   */
  abstract seed(
    entries: ReadonlyMap<string, IndexEntry>,
    children: ReadonlyMap<string, readonly string[]>,
    expiresAt: Date,
    version?: string | null,
  ): void
  /** Apply this index's ownership rules to a refill snapshot. */
  scopeSnapshot(snapshot: IndexSnapshot): IndexSnapshot {
    return snapshot
  }
  abstract entries(): Promise<Map<string, IndexEntry>>
  abstract get(vfsPath: string): Promise<LookupResult>
  abstract put(vfsPath: string, entry: IndexEntry): Promise<void>
  abstract listDir(vfsPath: string): Promise<ListResult>
  /**
   * Cache a complete directory listing. A complete listing names every
   * child, so a child the previous listing named and this one does not is
   * gone: its row goes, and a gone directory takes its listing and every
   * row beneath it. Rows only `put` wrote were never named, so they stay. A
   * window evicts nothing. Resolves to the children that went.
   */
  abstract setDir(
    vfsPath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
    options?: SetDirOptions,
  ): Promise<Evicted[]>
  /**
   * Hand children a re-list found gone to the mount's cleanup. A raw store
   * belongs to no mount, so there is nothing to clean.
   */
  reportGone(_gone: readonly Evicted[]): Promise<void> {
    return Promise.resolve()
  }
  /** Drop one metadata row while preserving listing history. */
  abstract invalidateEntry(vfsPath: string): Promise<void>
  abstract invalidateDir(vfsPath: string): Promise<void>
  /**
   * Cache observed children without claiming a complete directory. Stores
   * supporting partial freshness return these keys as `partialEntries`
   * until expiry or invalidation. A partial listing proves nothing
   * complete, so it carries no version. Custom stores inherit the conservative
   * put-only fallback, which refreshes the parent on the next lookup.
   */
  async setPartialDir(
    vfsPath: string,
    entries: readonly [string, IndexEntry][],
    _expiredAt?: Date | null,
  ): Promise<void> {
    await this.invalidateDir(vfsPath)
    const stem = vfsPath.replace(/\/$/, '')
    for (const [name, entry] of entries) await this.put(`${stem}/${name}`, entry)
  }
  /**
   * Drop `vfsPath` and everything cached below it.
   *
   * `invalidateDir` drops one directory's listing and its direct children's
   * entries, which is enough for a mutation that named a path. A push
   * notification that can only name a scope needs the whole subtree gone,
   * because the listings further down were cached independently and nothing
   * above them expires them.
   *
   * Mirrors Python `IndexCacheStore.invalidate_prefix`.
   */
  abstract invalidatePrefix(vfsPath: string, excluded?: readonly string[]): Promise<void>
  /**
   * Mark every entry stale without discarding it.
   *
   * The difference from `clear` is what a later lookup can tell. `clear`
   * leaves an empty store, which reads exactly like a store that was never
   * filled, so a backend whose index *is* its listing cannot tell an
   * invalidation from an empty repository. Expiring instead keeps that
   * distinction: the lookup answers EXPIRED and the backend refetches.
   */
  abstract invalidate(): Promise<void>

  abstract clear(): Promise<void>

  /**
   * Release whatever the store holds open. The default is a no-op:
   * an in-memory index owns nothing. A store backed by a connection
   * (redis) overrides this and must be idempotent — `close()` is
   * called once per owning VFS, and a VFS shared between
   * workspaces is closed by whichever one owns it.
   *
   * Mirrors Python `IndexCacheStore.close` (`cache/index/store.py`).
   */
  close(): Promise<void> {
    return Promise.resolve()
  }
}
