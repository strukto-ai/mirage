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

import { IndexType, type IndexConfig, type RedisIndexConfig } from './config.ts'
import { RAMIndexCacheStore } from './ram.ts'
import { RedisIndexCacheStore } from './redis.ts'
import type { IndexCacheStore } from './store.ts'

/**
 * The index store a mount runs its driver under.
 *
 * A mount builds one when it is placed, from the workspace or mount
 * `index` config when there is one and from the driver's own `indexTtl`
 * otherwise. Two mounts of one driver instance share the store the first
 * one built; that sharing is the registry's. Mirrors Python
 * `cache/index/factory.py`.
 *
 * @param config the configured store, or undefined for a RAM store at the driver's TTL
 * @param ttl the driver's `indexTtl`, read when `config` is undefined
 */
export function buildIndex(config: IndexConfig | undefined, ttl: number): IndexCacheStore {
  if (config === undefined) return new RAMIndexCacheStore({ ttl })
  if (config.type === IndexType.REDIS) {
    const redis = config as RedisIndexConfig
    return new RedisIndexCacheStore({
      ttl: redis.ttl ?? 600,
      ...(redis.url !== undefined ? { url: redis.url } : {}),
      ...(redis.keyPrefix !== undefined ? { keyPrefix: redis.keyPrefix } : {}),
    })
  }
  return new RAMIndexCacheStore({ ttl: config.ttl ?? 600 })
}
