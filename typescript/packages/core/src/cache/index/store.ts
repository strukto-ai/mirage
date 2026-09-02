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

import type { IndexEntry, ListResult, LookupResult } from './config.ts'

export abstract class IndexCacheStore {
  /**
   * Whether this store stands in for a `fresh` op.
   *
   * False on every store a mount owns and true only on the private,
   * empty one the dispatcher substitutes for a `fresh` op. It is the
   * signal a backend reads when the memory it has to silence does not
   * live in this store: sharepoint remembers site and drive ids on its
   * accessor, so an empty index alone would not stop a
   * deleted-and-recreated drive from answering with the old id.
   * Nothing consults it for entries; it says only "no memory answers
   * this one". Mirrors Python `IndexCacheStore.fresh`.
   */
  readonly fresh: boolean

  constructor(fresh = false) {
    this.fresh = fresh
  }

  abstract get(resourcePath: string): Promise<LookupResult>
  abstract put(resourcePath: string, entry: IndexEntry): Promise<void>
  abstract listDir(resourcePath: string): Promise<ListResult>
  abstract setDir(
    resourcePath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
  ): Promise<void>
  abstract invalidateDir(resourcePath: string): Promise<void>
  /**
   * Drop `resourcePath` and everything cached below it.
   *
   * `invalidateDir` drops one directory's listing and its direct children's
   * entries, which is enough for a mutation that named a path. A push
   * notification that can only name a scope needs the whole subtree gone,
   * because the listings further down were cached independently and nothing
   * above them expires them.
   *
   * Mirrors Python `IndexCacheStore.invalidate_prefix`.
   */
  abstract invalidatePrefix(resourcePath: string): Promise<void>
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
   * called once per owning resource, and a resource shared between
   * workspaces is closed by whichever one owns it.
   *
   * Mirrors Python `IndexCacheStore.close` (`cache/index/store.py`).
   */
  close(): Promise<void> {
    return Promise.resolve()
  }
}
