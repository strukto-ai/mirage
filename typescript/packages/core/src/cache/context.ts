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

import type { FileStat, PathSpec } from '../types.ts'
import { type ContextCall, createAsyncContext } from '../utils/async_context.ts'

/**
 * What this module needs from a cache manager. `CacheManager` in
 * `cache/manager.ts` satisfies this structurally; this module never
 * imports it, keeping the dependency one-way: core mutators ->
 * cache/context <- mount (which installs a manager).
 */
export interface CacheInvalidator {
  invalidateAfterWrite(path: string | PathSpec): Promise<void>
  invalidateAfterUnlink(path: string | PathSpec): Promise<void>
  invalidateSubtree(path: string | PathSpec): Promise<void>
  invalidateAncestors(path: PathSpec): Promise<void>
  cachedSize(path: PathSpec): Promise<number | null>
  listingTrusted(folder: string): boolean
  probedStat(path: PathSpec): FileStat | null
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

/** Keep the mount's cache manager bound while a command's lazy output is read. */
export function captureCacheContext(): ContextCall {
  return storage.capture()
}

/**
 * Return the active cache manager for the current async context.
 *
 * Serves the read-through paths, so a wrong manager is worse than
 * none: a warm hit from another mount's cache is another mount's
 * bytes, where a miss just reads the backend. On an isolating runtime
 * one binding is live and answers as bound; on the fallback storage
 * the manager answers only while every live frame agrees on it, and a
 * disagreement (overlapping commands on different mounts) reads as no
 * manager, failing toward the cold read.
 */
export function activeCacheManager(): CacheInvalidator | null {
  const states = storage.liveStores()
  const first = states[0]
  if (first === undefined) return null
  for (const state of states) {
    if (state.manager !== first.manager) return null
  }
  return first.manager
}

/**
 * Every distinct manager bound by a live frame. Invalidation is the
 * opposite trade from the read side: dropping a live frame's
 * invalidation serves stale bytes later, while evicting from a mount
 * the write never touched only costs a refetch, so writes broadcast
 * where reads abstain.
 */
function liveManagers(): CacheInvalidator[] {
  const managers: CacheInvalidator[] = []
  for (const state of storage.liveStores()) {
    const manager = state.manager
    if (manager !== null && !managers.includes(manager)) managers.push(manager)
  }
  return managers
}

/**
 * Report a backend write so caches are invalidated at the mutation
 * site. No-op if no cache manager is active.
 */
export async function invalidateAfterWrite(path: string | PathSpec): Promise<void> {
  for (const manager of liveManagers()) {
    await manager.invalidateAfterWrite(path)
  }
}

/**
 * Report a backend deletion so caches are invalidated at the mutation
 * site. No-op if no cache manager is active.
 */
export async function invalidateAfterUnlink(path: string | PathSpec): Promise<void> {
  for (const manager of liveManagers()) {
    await manager.invalidateAfterUnlink(path)
  }
}

/**
 * Report a backend deletion that took a whole subtree with it.
 *
 * `invalidateAfterUnlink` evicts the path's own listing and its
 * parent's, which is the whole story for a file. A recursive delete or a
 * directory rename also strands every listing and every cached body
 * *below* the path, and those were cached under their own keys, so
 * nothing above them evicts one: `ls` kept printing a deleted
 * directory's contents and `cat` kept serving a deleted file's bytes
 * until the index TTL expired.
 *
 * Unlike {@link invalidateAncestors}, this cannot be assembled from
 * `invalidateAfterWrite` calls, because the set of keys beneath the path
 * is only known to the caches themselves.
 */
export async function invalidateSubtree(path: string | PathSpec): Promise<void> {
  for (const manager of liveManagers()) {
    await manager.invalidateSubtree(path)
  }
}

/**
 * Report one end of a backend rename.
 *
 * A renamed folder strands everything cached beneath both of its names, so
 * it takes {@link invalidateSubtree}. A renamed file has nothing beneath it
 * and takes {@link invalidateAfterUnlink}, which spares the walk of every
 * store. The caller passes `folder: true` whenever it cannot tell, and for
 * a destination the backend may have replaced a non-empty folder at.
 */
export async function invalidateAfterMove(path: string | PathSpec, folder: boolean): Promise<void> {
  await (folder ? invalidateSubtree(path) : invalidateAfterUnlink(path))
}

/**
 * Run `op`, then `evict`, also when `op` fails.
 *
 * An op that fails partway (a paginated delete, a folder copy that merged
 * some children) has already changed the backend, so what it touched is
 * stale either way. `evict` gets the op's result, or undefined when the op
 * failed. After a failed op an eviction error is reported, not thrown, so
 * the caller still learns why the op failed.
 *
 * Args:
 *   op: the backend change.
 *   evict: records and evicts what the op changed, given its result.
 */
export async function evictAfter<T>(
  op: () => Promise<T>,
  evict: (result: T | undefined) => Promise<void>,
): Promise<T> {
  let result: T
  try {
    result = await op()
  } catch (error) {
    await evict(undefined).catch((evictError: unknown) => {
      console.warn(`evicting after a failed op: ${String(evictError)}`)
    })
    throw error
  }
  await evict(result)
  return result
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
  for (const manager of liveManagers()) {
    await manager.invalidateAncestors(path)
  }
}

/**
 * Whether the active mount's listing of `folder` is recent enough: the same
 * rule as the fresh listing gate, written during this command or within the
 * trust window when no command is running.
 */
export function listingRefreshed(folder: string): boolean {
  return activeCacheManager()?.listingTrusted(folder) === true
}

const readFacts = createAsyncContext<{
  path: string
  facts: WeakMap<Uint8Array, (string | null)[]>
}>()

/** Collect tokens belonging to the exact bytes returned by a fetch. */
export async function captureRead<T>(
  path: string,
  fetch: () => Promise<T>,
): Promise<[T, (string | null)[]]> {
  const facts = new WeakMap<Uint8Array, (string | null)[]>()
  return readFacts.run({ path, facts }, async () => {
    const data = await fetch()
    return [data, data instanceof Uint8Array ? (facts.get(data) ?? []) : []]
  })
}

/** Publish a backend-verified token without activating observation. */
export function publishRead(path: string, data: Uint8Array, fingerprint: string | null): void {
  // Fallback contexts overlap; exact result identity makes broadcast safe.
  for (const capture of readFacts.liveStores()) {
    if (capture.path !== path) continue
    const tokens = capture.facts.get(data) ?? []
    tokens.push(fingerprint)
    capture.facts.set(data, tokens)
  }
}
