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
  abstract get(resourcePath: string): Promise<LookupResult>
  abstract put(resourcePath: string, entry: IndexEntry): Promise<void>
  abstract listDir(resourcePath: string): Promise<ListResult>
  abstract setDir(
    resourcePath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
  ): Promise<void>
  abstract invalidateDir(resourcePath: string): Promise<void>
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
