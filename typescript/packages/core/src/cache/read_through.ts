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

import type { Accessor } from '../accessor/base.ts'
import { PathSpec, type ReadBytesFn, type ReadStreamFn } from '../types.ts'
import type { EntryGate } from '../policy/types.ts'
import type { IndexCacheStore } from './index/store.ts'
import { type CacheInvalidator, activeCacheManager } from './context.ts'
import { getAdmission } from '../context/session_context.ts'

type OpStream<A extends Accessor> = ReadStreamFn<
  [accessor: A, path: PathSpec, index?: IndexCacheStore]
>

type OpBytes<A extends Accessor> = ReadBytesFn<
  [accessor: A, path: PathSpec, index?: IndexCacheStore]
>

type PathStream = ReadStreamFn

async function* serveStream(
  manager: CacheInvalidator | null,
  path: PathSpec,
  produce: () => AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (manager !== null && path instanceof PathSpec) {
    const cached = await manager.cachedBytes(path)
    if (cached !== null) {
      yield cached
      return
    }
  }
  yield* produce()
}

async function serveBytes(
  manager: CacheInvalidator | null,
  path: PathSpec,
  produce: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (manager !== null && path instanceof PathSpec) {
    return manager.readThrough(path, produce)
  }
  return produce()
}

/**
 * Wrap a backend `readStream` op (factory shape) so warm reads serve
 * cached bytes. Keeps the `(accessor, path, index?)` signature, a drop-in
 * for the raw op the factory injects. On a warm hit it yields the whole
 * cached blob as one chunk; otherwise it streams from the backend. The
 * manager is read when the op is called (inside the command's cache scope),
 * not lazily at drain time. No-op for local or non-caching mounts.
 */
export function cacheAwareReadStream<A extends Accessor>(raw: OpStream<A>): OpStream<A> {
  return (accessor, path, index) =>
    serveStream(activeCacheManager(), path, () => raw(accessor, path, index))
}

/** Wrap a backend `readBytes` op (factory shape) for warm read-through. */
export function cacheAwareReadBytes<A extends Accessor>(raw: OpBytes<A>): OpBytes<A> {
  const manager = activeCacheManager()
  return (accessor, path, index) =>
    serveBytes(manager ?? activeCacheManager(), path, () => raw(accessor, path, index))
}

/**
 * The manager a generic's own read may serve a warm copy from: none where
 * anything could refuse the path for the running command (a rule in force,
 * or a coded or scripted preVfs policy, which only the guarded reader
 * asks). That reader answers instead, and the factory's cache beneath its
 * guards serves the copy once the path is admitted.
 */
function serving(
  manager: CacheInvalidator | null,
  gate: EntryGate | null,
  path: PathSpec,
): CacheInvalidator | null {
  return gate !== null && path instanceof PathSpec && gate.scopes(path.virtual) ? null : manager
}

/**
 * Wrap a path-keyed stream reader (the shape generics receive) for warm
 * read-through, reading the manager when the reader is called. Used by
 * grep/rg, whose consumers invoke the reader inside the command scope.
 * The reader may be guarded, so a path the running command could be
 * refused is left to it (`serving`).
 */
export function cacheAwareStream(raw: PathStream): PathStream {
  return (path) =>
    serveStream(serving(activeCacheManager(), getAdmission(), path), path, () => raw(path))
}

/**
 * Wrap a path-keyed stream reader for warm read-through, capturing the
 * active manager **eagerly** when this wrapper is applied. Used by
 * head/tail/wc, whose multi-file consumers drain lazily after the mount's
 * cache scope is gone, so reading the manager at drain time would always
 * miss. Apply inside the command's scope (the consumers do) so the
 * captured manager travels with the stream. The admission gate is
 * captured with it, and a path the running command could be refused is
 * left to the reader, which may be guarded (`serving`).
 */
export function cacheAwareStreamEager(raw: PathStream): PathStream {
  const manager = activeCacheManager()
  const gate = getAdmission()
  return (path) => serveStream(serving(manager, gate, path), path, () => raw(path))
}

/**
 * Return the first `n` cached bytes of `path` when warm, else null. Lets a
 * range-read fast path (e.g. `head -c N`) serve from a fully cached file
 * without a partial backend fetch. `n = null` returns the whole cached blob.
 */
