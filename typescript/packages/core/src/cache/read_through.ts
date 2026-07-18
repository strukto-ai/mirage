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
import type { IndexCacheStore } from './index/store.ts'
import { type CacheInvalidator, activeCacheManager } from './context.ts'

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
    const cached = await manager.cachedBytes(path)
    if (cached !== null) return cached
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
  return (accessor, path, index) =>
    serveBytes(activeCacheManager(), path, () => raw(accessor, path, index))
}

/**
 * Wrap a path-keyed stream reader (the shape generics receive) for warm
 * read-through, reading the manager when the reader is called. Used by
 * grep/rg, whose consumers invoke the reader inside the command scope.
 */
export function cacheAwareStream(raw: PathStream): PathStream {
  return (path) => serveStream(activeCacheManager(), path, () => raw(path))
}

/**
 * Wrap a path-keyed stream reader for warm read-through, capturing the
 * active manager **eagerly** when this wrapper is applied. Used by
 * head/tail/wc, whose multi-file consumers drain lazily after the mount's
 * cache scope is gone, so reading the manager at drain time would always
 * miss. Apply inside the command's scope (the consumers do) so the
 * captured manager travels with the stream.
 */
export function cacheAwareStreamEager(raw: PathStream): PathStream {
  const manager = activeCacheManager()
  return (path) => serveStream(manager, path, () => raw(path))
}

/**
 * Return the first `n` cached bytes of `path` when warm, else null. Lets a
 * range-read fast path (e.g. `head -c N`) serve from a fully cached file
 * without a partial backend fetch. `n = null` returns the whole cached blob.
 */
export async function cachedPrefixBytes(
  path: PathSpec,
  n: number | null,
): Promise<Uint8Array | null> {
  const manager = activeCacheManager()
  if (manager === null || !(path instanceof PathSpec)) return null
  const cached = await manager.cachedBytes(path)
  if (cached === null) return null
  return n === null ? cached : cached.slice(0, n)
}
