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

import { md5Hex } from '../../utils/hash.ts'
import { RAMFileCacheStore } from './ram.ts'

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function decode(b: Uint8Array | null): string {
  return b === null ? '' : new TextDecoder().decode(b)
}

describe('RAMFileCacheStore', () => {
  it('stores and retrieves values', async () => {
    const c = new RAMFileCacheStore({ limit: 1024 })
    await c.set('/a', encode('hello'))
    expect(decode(await c.get('/a'))).toBe('hello')
    expect(c.cacheSize).toBe(5)
  })

  it('returns null for missing keys', async () => {
    const c = new RAMFileCacheStore()
    expect(await c.get('/missing')).toBeNull()
  })

  it('overwrites on set', async () => {
    const c = new RAMFileCacheStore()
    await c.set('/a', encode('one'))
    await c.set('/a', encode('two'))
    expect(decode(await c.get('/a'))).toBe('two')
    expect(c.cacheSize).toBe(3)
  })

  it('add is no-op when entry exists', async () => {
    const c = new RAMFileCacheStore()
    expect(await c.add('/a', encode('one'))).toBe(true)
    expect(await c.add('/a', encode('two'))).toBe(false)
    expect(decode(await c.get('/a'))).toBe('one')
  })

  it('remove deletes entries', async () => {
    const c = new RAMFileCacheStore()
    await c.set('/a', encode('x'))
    await c.remove('/a')
    expect(await c.get('/a')).toBeNull()
    expect(c.cacheSize).toBe(0)
  })

  it('exists reflects presence', async () => {
    const c = new RAMFileCacheStore()
    expect(await c.exists('/a')).toBe(false)
    await c.set('/a', encode('x'))
    expect(await c.exists('/a')).toBe(true)
  })

  it('evicts oldest entries when over limit', async () => {
    const c = new RAMFileCacheStore({ limit: 10 })
    await c.set('/a', encode('aaaaa'))
    await c.set('/b', encode('bbbbb'))
    await c.set('/c', encode('ccccc'))
    expect(await c.get('/a')).toBeNull()
    expect(decode(await c.get('/b'))).toBe('bbbbb')
    expect(decode(await c.get('/c'))).toBe('ccccc')
  })

  it('get promotes to most-recently-used (LRU)', async () => {
    const c = new RAMFileCacheStore({ limit: 10 })
    await c.set('/a', encode('aaaaa'))
    await c.set('/b', encode('bbbbb'))
    await c.get('/a')
    await c.set('/c', encode('ccccc'))
    expect(await c.get('/b')).toBeNull()
    expect(decode(await c.get('/a'))).toBe('aaaaa')
  })

  it('isFresh compares fingerprints', async () => {
    const c = new RAMFileCacheStore()
    await c.set('/a', encode('x'), { fingerprint: 'abc' })
    expect(await c.isFresh('/a', 'abc')).toBe(true)
    expect(await c.isFresh('/a', 'xyz')).toBe(false)
    expect(await c.isFresh('/missing', 'abc')).toBe(false)
  })

  it('clear empties the cache', async () => {
    const c = new RAMFileCacheStore()
    await c.set('/a', encode('x'))
    await c.set('/b', encode('y'))
    await c.clear()
    expect(c.cacheSize).toBe(0)
    expect(await c.get('/a')).toBeNull()
  })

  it('evictPrefix drops only matching keys', async () => {
    const c = new RAMFileCacheStore({ limit: 1024 })
    await c.set('/data/a.txt', encode('a'))
    await c.set('/data/sub/b.txt', encode('bb'))
    await c.set('/other/c.txt', encode('ccc'))
    await c.evictPrefix('/data/')
    expect(await c.exists('/data/a.txt')).toBe(false)
    expect(await c.exists('/data/sub/b.txt')).toBe(false)
    expect(await c.exists('/other/c.txt')).toBe(true)
  })

  it('evictPrefix reclaims the evicted bytes', async () => {
    const c = new RAMFileCacheStore({ limit: 1024 })
    await c.set('/data/a.txt', encode('12345'))
    await c.set('/other/c.txt', encode('xy'))
    await c.evictPrefix('/data/')
    expect(c.cacheSize).toBe(2)
    expect(c.cacheEntries).toBe(1)
  })

  it('evictPaths drops the named keys synchronously', async () => {
    const c = new RAMFileCacheStore({ limit: 1024 })
    await c.set('/d/a.txt', encode('12345'))
    await c.set('/d/b.txt', encode('xy'))
    // No await on the eviction itself: the snapshot load path is sync,
    // which is the whole reason this seam exists beside remove().
    c.evictPaths(['/d/a.txt', '/d/missing.txt'])
    expect(c.cacheSize).toBe(2)
    expect(c.cacheEntries).toBe(1)
    expect(await c.get('/d/a.txt')).toBeNull()
  })
})

describe('RAMFileCacheStore: a writer waiting on the lock', () => {
  // Staged by call order, not by a sleep: `invalidation.enter` runs
  // synchronously when the store method is called and `KeyLock.withLock`
  // awaits an already-resolved promise, so every writer below takes its
  // stamp before the invalidation lands and is still parked when it does.

  it.each(['set', 'add'] as const)(
    '%s sees an invalidation that landed while it waited',
    async (operation) => {
      const cache = new RAMFileCacheStore()
      const first = cache[operation]('/large', new Uint8Array([0x78]))
      const second = cache[operation]('/large', new Uint8Array([0x79]))
      await cache.clear()
      await Promise.all([first, second])
      expect(await cache.get('/large')).toBeNull()
    },
  )

  it.each(['set', 'add'] as const)(
    '%s parked when the cache is cleared is discarded',
    async (operation) => {
      // One writer, parked on the lock rather than behind another writer.
      // Lived in io/cooperative.test.ts while the cooperative md5 was what
      // parked it; that is no longer this file's subject.
      const cache = new RAMFileCacheStore()
      const pending = cache[operation]('/large', new Uint8Array([0x78]))
      await cache.clear()
      await pending
      expect(await cache.get('/large')).toBeNull()
      expect(cache.cacheSize).toBe(0)
    },
  )

  it.each(['set', 'add'] as const)(
    '%s parked when a covering prefix is evicted is discarded',
    async (operation) => {
      // evictPrefix bumps the same store-wide epoch clear does, but through
      // its own path; the redis suite used to be the only place this was
      // exercised in TypeScript.
      const cache = new RAMFileCacheStore()
      const pending = cache[operation]('/large', new Uint8Array([0x78]))
      await cache.evictPrefix('/lar')
      await pending
      expect(await cache.get('/large')).toBeNull()
    },
  )

  it.each(['set', 'add'] as const)(
    '%s queued behind a removal of its key is discarded',
    async (operation) => {
      // The second writer holds bytes read before the removal, so it must
      // not repopulate the key that was just dropped.
      const cache = new RAMFileCacheStore()
      const first = cache[operation]('/large', new Uint8Array([0x78]))
      const removal = cache.remove('/large')
      const second = cache[operation]('/large', new Uint8Array([0x79]))
      await Promise.all([first, removal, second])
      expect(await cache.get('/large')).toBeNull()
    },
  )

  it.each(['set', 'add'] as const)(
    '%s of one key survives the removal of another key',
    async (operation) => {
      const cache = new RAMFileCacheStore()
      const data = new Uint8Array([0x78, 0x78])
      const fill = cache[operation]('/large', data)
      await cache.remove('/other')
      await fill
      expect(await cache.get('/large')).toEqual(data)
    },
  )
})

describe('a fill that carries no token', () => {
  it.each(['set', 'add'] as const)('%s stores null, not a hash of the bytes', async (operation) => {
    const cache = new RAMFileCacheStore()
    await cache[operation]('/a', encode('data'))
    expect(await cache.isFresh('/a', 'etag-1')).toBe(false)
    // md5Hex, not node:crypto: the exact function the deleted fallback
    // called, and core's own helper, so the test stays runtime-agnostic.
    expect(await cache.isFresh('/a', md5Hex(encode('data')))).toBe(false)
  })

  it.each(['set', 'add'] as const)(
    '%s treats an empty token as absent, matching the redis wire convention',
    async (operation) => {
      // `add` is the door where '' crosses into add.lua as ARGV[2].
      const cache = new RAMFileCacheStore()
      await cache[operation]('/a', encode('data'), { fingerprint: '' })
      expect(await cache.isFresh('/a', '')).toBe(false)
    },
  )

  it.each(['etag-1', '', null])('answers no when asked with %o', async (remote) => {
    // Including a remote that is itself absent. `_probe` never asks then
    // (it answers UNKNOWN on a stat carrying no fingerprint, one line
    // earlier), but the store is what has to hold the rule: two absences
    // comparing equal is a FRESH verdict on a copy nothing verified, and
    // the redis store, whose meta key is simply missing, already answers
    // false for the same pair. A store that disagrees with its twin only
    // for an input the caller is not supposed to send is the shape that
    // passes every RAM-backed test and diverges in production.
    const cache = new RAMFileCacheStore()
    await cache.set('/a', encode('data'))
    expect(await cache.isFresh('/a', remote as unknown as string)).toBe(false)
  })
})

describe('isUnbounded', () => {
  // One question, not `exists` plus a ttl lookup: a warm bounded read asks
  // this on every serve, and a missing entry must answer false rather than
  // reading as unbounded, or the gate would evict nothing and refuse
  // everything.
  it('distinguishes absent from bound-less', async () => {
    const cache = new RAMFileCacheStore()
    expect(await cache.isUnbounded('/absent')).toBe(false)
    await cache.set('/no-bound', new TextEncoder().encode('x'))
    expect(await cache.isUnbounded('/no-bound')).toBe(true)
    await cache.set('/bounded', new TextEncoder().encode('x'), { ttl: 30 })
    expect(await cache.isUnbounded('/bounded')).toBe(false)
  })
})
