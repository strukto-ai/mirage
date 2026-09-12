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
import { ManualClock } from '../../utils/clock.ts'
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

  it('holds the TTL boundary exactly on an injected clock', async () => {
    // The boundary the seam exists for: probed at ttl-1 and at ttl with
    // no sleep, no real time, and nothing patched globally.
    const clock = new ManualClock(1000)
    const c = new RAMFileCacheStore({ limit: 1024, clock })
    await c.set('/f.txt', encode('hello'), { ttl: 10 })
    clock.advance(9)
    expect(await c.exists('/f.txt')).toBe(true)
    expect(decode(await c.get('/f.txt'))).toBe('hello')
    clock.advance(1)
    expect(await c.exists('/f.txt')).toBe(false)
    expect(await c.get('/f.txt')).toBeNull()
  })

  it('drops an expired entry on read', async () => {
    const clock = new ManualClock(0)
    const c = new RAMFileCacheStore({ limit: 1024, clock })
    await c.set('/f.txt', encode('hello'), { ttl: 5 })
    clock.advance(5)
    expect(await c.get('/f.txt')).toBeNull()
    expect(c.cacheSize).toBe(0)
    expect(c.cacheEntries).toBe(0)
  })

  it('add replaces an entry the clock expired', async () => {
    const clock = new ManualClock(0)
    const c = new RAMFileCacheStore({ limit: 1024, clock })
    await c.set('/f.txt', encode('old'), { ttl: 5 })
    expect(await c.add('/f.txt', encode('new'))).toBe(false)
    clock.advance(5)
    expect(await c.add('/f.txt', encode('new'))).toBe(true)
    expect(decode(await c.get('/f.txt'))).toBe('new')
  })

  it('stamps cachedAt from the injected clock', async () => {
    const clock = new ManualClock(4242)
    const c = new RAMFileCacheStore({ limit: 1024, clock })
    await c.set('/f.txt', encode('hello'))
    expect(c.snapshotEntries()[0]?.entry.cachedAt).toBe(4242)
  })

  it('stamps from the real clock by default', async () => {
    const c = new RAMFileCacheStore({ limit: 1024 })
    await c.set('/f.txt', encode('hello'))
    const cachedAt = c.snapshotEntries()[0]?.entry.cachedAt ?? 0
    expect(Math.abs(cachedAt - Date.now() / 1000)).toBeLessThan(5)
  })
})
