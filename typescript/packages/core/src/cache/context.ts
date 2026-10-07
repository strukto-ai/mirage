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

import { enotsup, staleWrite } from '../errors/fs.ts'
import type { FsError } from '../errors/types.ts'
import { markLost } from '../observe/context.ts'
import type { FileStat, PathSpec } from '../types.ts'
import { type ContextCall, createAsyncContext } from '../utils/async_context.ts'
import { keyPath } from '../utils/key_prefix.ts'

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
  cachedBytes(path: PathSpec): Promise<Uint8Array | null>
  readThrough(path: PathSpec, fetch: () => Promise<Uint8Array>): Promise<Uint8Array>
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

/** The precondition one write carries. Mirrors Python's `WriteCondition`. */
export interface WriteCondition {
  /** The version the object must still have. */
  readonly ifMatch?: string
  /**
   * The object must not exist yet; sent when no version is known, so a new
   * file is created and an existing one is refused.
   */
  readonly ifNoneMatch?: true
}

/**
 * What a write on a `write: conditional` mount needs to know. Bound by the
 * mount's own doors (`executeOp`, `executeCmd`), so a write always sees
 * the context of the mount it lands on; an unconditional mount binds null,
 * which also clears an outer one. Mirrors Python's `WriteContext`.
 */
export interface WriteContext {
  readonly vfs: string
  /** The ops the backend can condition: put, create, copy, delete. */
  readonly conditions: readonly string[]
  /** The version the mount last saw for a path, null when it saw none. */
  readVersion(path: PathSpec): Promise<string | null>
  /** `readVersion` for many paths at once, in one store round trip. */
  readVersions(paths: readonly PathSpec[]): Promise<(string | null)[]>
  /** Drops the mount's cached copy, so the read a refusal asks for fetches. */
  drop(path: PathSpec): Promise<void>
}

export type WriteKind = 'write' | 'copy' | 'delete'

/**
 * The version the mount last saw for each of a walk's backend keys, by key,
 * for the keys it saw one for.
 */
export type KnownVersions = (keys: readonly string[]) => Promise<Map<string, string>>

const writeStorage = createAsyncContext<{ context: WriteContext | null }>()
/** An op's own read that found no file, as against one it never made. */
export enum OwnRead {
  ABSENT = 'absent',
}

const ownVersionStorage = createAsyncContext<{ version: string | OwnRead | null }>()

/** Run `fn` with `context` bound as the mount's write context. */
export function runWithWriteContext<T>(
  context: WriteContext | null,
  fn: () => Promise<T>,
): Promise<T> {
  return Promise.resolve(writeStorage.run({ context }, fn))
}

/**
 * The write context of the current async context. On the fallback storage
 * the live frames can disagree (overlapping lines on different mounts);
 * unlike the read side, that cannot read as "none", which would send a
 * conditional mount's write unconditioned, so it throws and the write is
 * refused instead.
 */
function activeWriteContext(path: PathSpec): WriteContext | null {
  const states = writeStorage.liveStores()
  const first = states[0]
  if (first === undefined) return null
  for (const state of states) {
    if (state.context !== first.context) {
      throw enotsup('workspace', 'conditional write (overlapping lines)', path)
    }
  }
  return first.context
}

/**
 * Hand the version an op just read to the write it makes next: a
 * read-modify-write op (an append, a descriptor pwrite, a resize) bases its
 * write on what it read itself, not on what the agent read.
 */
export function runWithOwnVersion<T>(
  version: string | OwnRead | null,
  fn: () => Promise<T>,
): Promise<T> {
  return Promise.resolve(ownVersionStorage.run({ version }, fn))
}

/**
 * The version an op read itself, handed down to its write. On the fallback
 * storage the live frames can disagree; like the write context, that is
 * refused rather than read as "none", which would send the agent's version
 * in place of the op's own.
 */
function ownVersion(path: PathSpec): string | OwnRead | null {
  const states = ownVersionStorage.liveStores()
  const first = states[0]
  if (first === undefined) return null
  for (const state of states) {
    if (state.version !== first.version) {
      throw enotsup('workspace', 'conditional write (overlapping lines)', path)
    }
  }
  return first.version
}

/**
 * Run a read and return its bytes with the token they carried: the one its
 * backend published for these exact bytes, null when it published none or
 * two that disagree. Mirrors Python's `read_versioned`.
 */
export async function readVersioned<T>(
  path: PathSpec,
  fetch: () => Promise<T>,
): Promise<[T, string | null]> {
  const [data, facts] = await captureRead(path.virtual, fetch)
  const first = facts[0]
  const token = first !== undefined && facts.every((f) => f === first) ? first : null
  return [data, token]
}

/**
 * The condition a write to `path` must carry, null when unconditional.
 * Mirrors Python's `write_condition`.
 *
 * @param own the version the op itself just saw
 * @param preferOwn whether the op's own version wins over the mount's
 *   cached one (true for a read-modify-write, false for a delete)
 * @throws an ENOTSUP error when the backend cannot condition this op
 */
export async function writeCondition(
  path: PathSpec,
  kind: WriteKind,
  own: string | OwnRead | null = null,
  preferOwn = true,
): Promise<WriteCondition | null> {
  const context = activeWriteContext(path)
  if (context === null) return null
  const read = own ?? ownVersion(path)
  const cached = await context.readVersion(path)
  // The op's own read found no file: one the mount saw was removed since.
  if (read === OwnRead.ABSENT && cached !== null && cached !== '') throw await stale(path)
  const mine = read === OwnRead.ABSENT ? null : read
  const ownToken = mine === '' ? null : mine
  const cachedToken = cached === '' ? null : cached
  const version = preferOwn ? (ownToken ?? cachedToken) : (cachedToken ?? ownToken)
  const needed =
    kind === 'copy' ? 'copy' : kind === 'delete' ? 'delete' : version !== null ? 'put' : 'create'
  if (!context.conditions.includes(needed)) {
    throw enotsup(context.vfs, `conditional ${kind}`, path)
  }
  if (version !== null) return { ifMatch: version }
  if (kind === 'delete') return {}
  return { ifNoneMatch: true }
}

/**
 * Whether a `kind` on `path` goes out conditioned, for a prefix walk, which
 * conditions each key itself and needs no version for the operand. Mirrors
 * python's `conditioned`.
 *
 * @throws an ENOTSUP error when the backend cannot condition this op
 */
export function conditioned(path: PathSpec, kind: 'copy' | 'delete'): boolean {
  const context = activeWriteContext(path)
  if (context === null) return false
  if (!context.conditions.includes(kind)) throw enotsup(context.vfs, `conditional ${kind}`, path)
  return true
}

/** Drop the write context's cached copy of `path`, if there is one. */
export async function dropCached(path: PathSpec): Promise<void> {
  markLost(path.virtual)
  const context = activeWriteContext(path)
  if (context !== null) await context.drop(path)
}

/**
 * The refusal for a lost condition, after dropping the cached copy;
 * `landed` marks a move whose copy landed before its source's delete lost,
 * which `mv` reports as a failed removal.
 */
export async function stale(path: PathSpec, landed = false): Promise<FsError> {
  await dropCached(path)
  return staleWrite(path, landed)
}

/**
 * The versions a prefix walk under `root` measures its keys against: a key
 * the agent read is held to the version it read, and the walk's own listing
 * only stands in for keys it never saw. Mirrors python's `known_versions`.
 */
export function knownVersions(root: PathSpec, keyPrefix: string): KnownVersions {
  return async (keys) => {
    const known = new Map<string, string>()
    if (keys.length === 0) return known
    const context = activeWriteContext(root)
    if (context === null) return known
    const tokens = await context.readVersions(keys.map((key) => keyPath(root, keyPrefix, key)))
    keys.forEach((key, i) => {
      const token = tokens[i]
      if (token !== null && token !== undefined && token !== '') known.set(key, token)
    })
    return known
  }
}
