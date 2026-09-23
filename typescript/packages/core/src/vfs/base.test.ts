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
import { BaseVFS } from './base.ts'
import { vfsStateRequiresOverride } from './secrets.ts'

class Probe extends BaseVFS {
  readonly kind = 'probe'
  override readonly indexTtl: number = 123
}

describe('BaseVFS index', () => {
  it('defaults to a RAM index using the VFS indexTtl', () => {
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

describe('BaseVFS state', () => {
  // Mirrors Python `BaseVFS.get_state` / `load_state`: a VFS that
  // holds nothing of its own names only the class to rebuild.
  it('getState names the VFS kind and carries no config', () => {
    expect(new Probe().getState()).toEqual({ type: 'probe' })
  })

  it('loadState takes nothing back', () => {
    expect(new Probe().loadState({ type: 'probe' })).toBeUndefined()
  })

  // A bare `{type}` leaves no redaction marker, which is exactly why a
  // config-backed VFS may not inherit it: the marker is what makes
  // load demand a fresh config instead of substituting an empty mount.
  it('the default state does not ask for an override at load', () => {
    expect(vfsStateRequiresOverride(new Probe().getState())).toBe(false)
  })
})

describe('BaseVFS close', () => {
  it('closes the index, once', async () => {
    const r = new Probe()
    let closes = 0
    const index = r.index as RAMIndexCacheStore & { close: () => Promise<void> }
    index.close = () => {
      closes++
      return Promise.resolve()
    }
    await r.close()
    await r.close()
    // Without this the redis client behind `index: {type: redis}` stays
    // connected past closeWorkspace and the Node process never exits.
    expect(closes).toBe(1)
  })

  it('does not build an index for a VFS that never used one', async () => {
    const r = new Probe()
    await r.close()
    expect((r as unknown as { _index?: unknown })._index).toBeUndefined()
  })
})
