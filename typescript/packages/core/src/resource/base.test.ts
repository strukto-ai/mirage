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

import { describe, expect, it } from 'vitest'
import { IndexType, type RedisIndexConfig } from '../cache/index/config.ts'
import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import { RedisIndexCacheStore } from '../cache/index/redis.ts'
import { BaseResource } from './base.ts'

class Probe extends BaseResource {
  readonly indexTtl: number = 123
}

describe('BaseResource index', () => {
  it('defaults to a RAM index using the resource indexTtl', () => {
    const r = new Probe()
    expect(r.index).toBeInstanceOf(RAMIndexCacheStore)
    expect((r.index as unknown as { ttl: number }).ttl).toBe(123)
  })

  it('setIndex with a ram config rebuilds RAM with the config ttl', () => {
    const r = new Probe()
    r.setIndex({ type: IndexType.RAM, ttl: 5 })
    expect(r.index).toBeInstanceOf(RAMIndexCacheStore)
    expect((r.index as unknown as { ttl: number }).ttl).toBe(5)
  })

  it('setIndex with a redis config swaps in a RedisIndexCacheStore', () => {
    const r = new Probe()
    const cfg: RedisIndexConfig = {
      type: IndexType.REDIS,
      url: 'redis://localhost:6379/0',
      keyPrefix: 'p:',
    }
    r.setIndex(cfg)
    expect(r.index).toBeInstanceOf(RedisIndexCacheStore)
  })
})
