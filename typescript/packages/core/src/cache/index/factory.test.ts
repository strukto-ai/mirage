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

import { IndexType, LookupStatus } from './config.ts'
import { buildIndex } from './factory.ts'
import { RAMIndexCacheStore } from './ram.ts'
import { RedisIndexCacheStore } from './redis.ts'

describe('buildIndex', () => {
  it('builds a RAM store at the driver TTL when no config names one', async () => {
    const store = buildIndex(undefined, -1)
    expect(store).toBeInstanceOf(RAMIndexCacheStore)
    await store.setDir('/listing', [])
    expect((await store.listDir('/listing')).status).toBe(LookupStatus.EXPIRED)
  })

  it("takes the config's TTL over the driver's", async () => {
    const store = buildIndex({ ttl: 3600 }, -1)
    expect(store).toBeInstanceOf(RAMIndexCacheStore)
    await store.setDir('/listing', [])
    expect((await store.listDir('/listing')).status).not.toBe(LookupStatus.EXPIRED)
  })

  it('builds a redis store from a redis config', () => {
    const store = buildIndex(
      { type: IndexType.REDIS, url: 'redis://127.0.0.1:1/0', keyPrefix: 't:' },
      -1,
    )
    expect(store).toBeInstanceOf(RedisIndexCacheStore)
  })
})
