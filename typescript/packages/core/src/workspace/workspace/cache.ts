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

import { CacheType, type CacheConfig, type RedisCacheConfig } from '../../cache/file/config.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import type { Resource } from '../../resource/base.ts'
import type { Clock } from '../../utils/clock.ts'

export type FileCacheStore = FileCache & Resource
export type FileCacheFactory = (config: RedisCacheConfig) => FileCacheStore

const FACTORIES: Record<string, FileCacheFactory> = {}

/**
 * Register the store that backs a `type:` in {@link buildFileCache}.
 *
 * The redis store extends a node-only resource, and core cannot import
 * node, so `@struktoai/mirage-node` registers it on import — the same
 * seam `registerRuntime` uses for the runtimes it owns. Python needs no
 * equivalent: there, redis is an optional extra of one package, so
 * `build_file_cache` imports it directly behind a try/except.
 */
export function registerFileCacheStore(type: CacheType, factory: FileCacheFactory): void {
  FACTORIES[type] = factory
}

/**
 * Build the workspace's file cache from its config.
 *
 * Mirrors Python `build_file_cache` (`workspace/workspace/cache.py`),
 * including its failure mode: asking for a store whose package has not
 * been loaded names the package rather than silently degrading to RAM.
 *
 * @param cache the cache config; undefined keeps the RAM store sized by
 *   `cacheLimit`.
 * @param cacheLimit the size knob used only when no config is given.
 * @param clock the workspace's clock, handed to the store that ages
 *   entries itself. The redis store takes none: its TTLs are
 *   server-side `EXPIRE` and it reads no time here.
 */
export function buildFileCache(
  cache: CacheConfig | undefined,
  cacheLimit: string | number = '512MB',
  clock?: Clock,
): FileCacheStore {
  // Every CacheConfig field is optional, so a built store is
  // structurally assignable to it and would slip through to the RAM
  // branch below — silently replaced by a cache that never sees a read.
  // Structural typing cannot refuse this; say so instead.
  if (cache !== undefined && typeof (cache as Partial<FileCache>).get === 'function') {
    throw new Error(
      'options.cache takes the config to build a cache from, not a built store; ' +
        'register a factory for its type with registerFileCacheStore(type, ...) ' +
        'and name that type here',
    )
  }
  const type = cache?.type ?? CacheType.RAM
  if (type !== CacheType.RAM) {
    const factory = FACTORIES[type]
    if (factory === undefined) {
      throw new Error(
        `no '${type}' file cache is registered; import '@struktoai/mirage-node' ` +
          `(which registers it) or call registerFileCacheStore('${type}', ...)`,
      )
    }
    return factory(cache as RedisCacheConfig)
  }
  return new RAMFileCacheStore({
    limit: cache?.limit ?? cacheLimit,
    maxDrainBytes: cache?.maxDrainBytes ?? null,
    ...(clock !== undefined ? { clock } : {}),
  })
}
