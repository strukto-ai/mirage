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
import { type CacheInvalidator, activeCacheManager } from './context.ts'
import type { IndexCacheStore } from './index/store.ts'

type OpStream<A extends Accessor> = ReadStreamFn<
  [accessor: A, path: PathSpec, index?: IndexCacheStore]
>

type OpBytes<A extends Accessor> = ReadBytesFn<
  [accessor: A, path: PathSpec, index?: IndexCacheStore]
>

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
 * manager is captured when binding the reader, falling back to its call
 * scope when bound outside a command. Lazy consumers keep that manager
 * after the command scope has returned. No-op for non-caching mounts.
 */
export function cacheAwareReadStream<A extends Accessor>(raw: OpStream<A>): OpStream<A> {
  const manager = activeCacheManager()
  return (accessor, path, index) =>
    serveStream(manager ?? activeCacheManager(), path, () => raw(accessor, path, index))
}

/** Wrap a backend `readBytes` op (factory shape) for warm read-through. */
export function cacheAwareReadBytes<A extends Accessor>(raw: OpBytes<A>): OpBytes<A> {
  const manager = activeCacheManager()
  return (accessor, path, index) =>
    serveBytes(manager ?? activeCacheManager(), path, () => raw(accessor, path, index))
}
