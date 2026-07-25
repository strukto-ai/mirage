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

import { PathSpec } from '../types.ts'
import { createAsyncContext } from '../utils/async_context.ts'

/**
 * What this module needs from a cache manager. `CacheManager` in
 * `cache/manager.ts` satisfies this structurally; this module never
 * imports it, keeping the dependency one-way: core mutators ->
 * cache/context <- mount (which installs a manager).
 */
export interface CacheInvalidator {
  invalidateAfterWrite(path: string | PathSpec): Promise<void>
  invalidateAfterUnlink(path: string | PathSpec): Promise<void>
  cachedBytes(path: PathSpec): Promise<Uint8Array | null>
}

interface CacheContextState {
  manager: CacheInvalidator | null
}

const storage = createAsyncContext<CacheContextState>()

/**
 * Run `fn` with `manager` active for the current async context.
 * Mirrors `runWithRevisions`: the mount entry point wraps command
 * dispatch, core backend mutators report through
 * {@link invalidateAfterWrite} / {@link invalidateAfterUnlink}.
 */
export function runWithCacheManager<T>(
  manager: CacheInvalidator | null,
  fn: () => Promise<T>,
): Promise<T> {
  return Promise.resolve(storage.run({ manager }, fn))
}

/** Return the active cache manager for the current async context. */
export function activeCacheManager(): CacheInvalidator | null {
  return storage.getStore()?.manager ?? null
}

/**
 * Report a backend write so caches are invalidated at the mutation
 * site. No-op if no cache manager is active.
 */
export async function invalidateAfterWrite(path: string | PathSpec): Promise<void> {
  const manager = storage.getStore()?.manager
  if (manager !== null && manager !== undefined) {
    await manager.invalidateAfterWrite(path)
  }
}

/**
 * Report a backend deletion so caches are invalidated at the mutation
 * site. No-op if no cache manager is active.
 */
export async function invalidateAfterUnlink(path: string | PathSpec): Promise<void> {
  const manager = storage.getStore()?.manager
  if (manager !== null && manager !== undefined) {
    await manager.invalidateAfterUnlink(path)
  }
}

/**
 * Evict every ancestor directory listing of `path`.
 *
 * A single invalidateAfterWrite only refreshes the immediate parent
 * listing. When an op materializes several missing levels at once
 * (`mkdir -p a/b/c`, a bucket write that creates parents), the higher
 * ancestors' cached listings stay stale and hide the new entries until
 * the index TTL expires. Walking the chain refreshes each one.
 */
export async function invalidateAncestors(path: PathSpec): Promise<void> {
  let parent = path.mountPath.slice(0, path.mountPath.lastIndexOf('/'))
  while (parent !== '') {
    await invalidateAfterWrite(PathSpec.fromStrPath(parent))
    parent = parent.slice(0, parent.lastIndexOf('/'))
  }
}
