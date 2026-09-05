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

import { mountKey } from '../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'

import { PathSpec } from '../types.ts'
import { RAMFileCacheStore } from './file/ram.ts'
import { IndexEntry } from './index/config.ts'
import { RAMIndexCacheStore } from './index/ram.ts'
import { CacheManager } from './manager.ts'

async function seeded(): Promise<[RAMFileCacheStore, RAMIndexCacheStore]> {
  const cache = new RAMFileCacheStore()
  const index = new RAMIndexCacheStore({ ttl: 600 })
  await cache.set('/data/arch/h.txt', new TextEncoder().encode('two\n'))
  await index.setDir('/data/arch', [
    ['h.txt', new IndexEntry({ id: 'h', name: 'h.txt', resourceType: 'file' })],
  ])
  return [cache, index]
}

describe('CacheManager', () => {
  it('write evicts file entry and parent listing', async () => {
    const [cache, index] = await seeded()
    const manager = new CacheManager(cache, index, '/data/', true)
    await manager.invalidateAfterWrite('/arch/h.txt')
    expect(await cache.exists('/data/arch/h.txt')).toBe(false)
    const listing = await index.listDir('/data/arch')
    expect(listing.entries ?? null).toBeNull()
  })

  it('unlink evicts file entry, listing, and index entry', async () => {
    const [cache, index] = await seeded()
    const manager = new CacheManager(cache, index, '/data/', true)
    await manager.invalidateAfterUnlink('/arch/h.txt')
    expect(await cache.exists('/data/arch/h.txt')).toBe(false)
    const listing = await index.listDir('/data/arch')
    expect(listing.entries ?? null).toBeNull()
    const entry = await index.get('/data/arch/h.txt')
    expect(entry.entry ?? null).toBeNull()
  })

  it('local mount keeps file cache but invalidates index', async () => {
    const [cache, index] = await seeded()
    const manager = new CacheManager(cache, index, '/data/', false)
    await manager.invalidateAfterWrite('/arch/h.txt')
    expect(await cache.exists('/data/arch/h.txt')).toBe(true)
    const listing = await index.listDir('/data/arch')
    expect(listing.entries ?? null).toBeNull()
  })

  it('accepts PathSpec input and maps to the virtual key', async () => {
    const [cache, index] = await seeded()
    const manager = new CacheManager(cache, index, '/data/', true)
    const spec = new PathSpec({
      virtual: '/data/arch/h.txt',
      directory: '/data/arch',
      resourcePath: mountKey('/data/arch/h.txt', '/data'),
    })
    await manager.invalidateAfterWrite(spec)
    expect(await cache.exists('/data/arch/h.txt')).toBe(false)
  })

  it('tolerates a missing index', async () => {
    const cache = new RAMFileCacheStore()
    await cache.set('/data/a.txt', new TextEncoder().encode('x'))
    const manager = new CacheManager(cache, null, '/data/', true)
    await manager.invalidateAfterWrite('/a.txt')
    expect(await cache.exists('/data/a.txt')).toBe(false)
  })

  it('invalidateAncestors walks up to the mount root', async () => {
    // One put materializes every missing level of the key, so every listing
    // above the written file gained an entry.
    const index = new RAMIndexCacheStore({ ttl: 600 })
    for (const dir of ['/data', '/data/a', '/data/a/b']) await index.setDir(dir, [])
    const manager = new CacheManager(null, index, '/data/', true)
    await manager.invalidateAncestors(PathSpec.fromStrPath('/a/b/c.txt'))
    expect((await index.listDir('/data')).entries ?? null).toBeNull()
    expect((await index.listDir('/data/a')).entries ?? null).toBeNull()
    // The immediate parent is invalidateAfterWrite's job, not this one.
    expect((await index.listDir('/data/a/b')).entries ?? null).not.toBeNull()
  })

  it('invalidateAncestors reaches the root listing', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    for (const dir of ['/', '/a']) await index.setDir(dir, [])
    const manager = new CacheManager(null, index, '/', true)
    await manager.invalidateAncestors(PathSpec.fromStrPath('/a/b/c.txt'))
    expect((await index.listDir('/')).entries ?? null).toBeNull()
    expect((await index.listDir('/a')).entries ?? null).toBeNull()
  })

  it("drops this mount's bodies without touching a neighbour", async () => {
    const [cache, index] = await seeded()
    await cache.set('/data', new TextEncoder().encode('exact'))
    await cache.set('/other/keep.txt', new TextEncoder().encode('safe'))
    const manager = new CacheManager(cache, index, '/data/', true)
    await manager.dropPrefix()
    expect(await cache.exists('/data')).toBe(false)
    expect(await cache.exists('/data/arch/h.txt')).toBe(false)
    expect(await cache.exists('/other/keep.txt')).toBe(true)
  })

  it('leaves a non-caching mount alone', async () => {
    const [cache, index] = await seeded()
    const manager = new CacheManager(cache, index, '/data/', false)
    await manager.dropPrefix()
    expect(await cache.exists('/data/arch/h.txt')).toBe(true)
  })

  it('invalidateSubtree drops nested bodies and listings', async () => {
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const entry = new IndexEntry({ id: '1', name: 'f', resourceType: 'file' })
    await cache.set('/data/chan/day/chat.jsonl', new TextEncoder().encode('one\n'))
    await cache.set('/data/chan/day/files/a.png', new TextEncoder().encode('png'))
    await index.setDir('/data/chan/day', [['chat.jsonl', entry]])
    await index.setDir('/data/chan/day/files', [['a.png', entry]])
    await index.setDir('/data/chan', [['day', entry]])
    const manager = new CacheManager(cache, index, '/data/', true)
    await manager.invalidateSubtree(PathSpec.fromStrPath('/chan/day'))
    expect(await cache.exists('/data/chan/day/files/a.png')).toBe(false)
    expect((await index.listDir('/data/chan/day')).entries).toBeUndefined()
    expect((await index.listDir('/data/chan/day/files')).entries).toBeUndefined()
    expect((await index.listDir('/data/chan')).entries).toBeUndefined()
  })

  it('a write does not reach into the subtree', async () => {
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const entry = new IndexEntry({ id: '1', name: 'f', resourceType: 'file' })
    await index.setDir('/data/chan/day/files', [['a.png', entry]])
    const manager = new CacheManager(cache, index, '/data/', true)
    await manager.invalidateAfterWrite(PathSpec.fromStrPath('/chan/day'))
    expect((await index.listDir('/data/chan/day/files')).entries).toEqual([
      '/data/chan/day/files/a.png',
    ])
  })

  it('a relative path that looks prefixed is still prefixed', async () => {
    // '/day' starts with the '/d' prefix as characters while naming something
    // else; reading it as absolute evicted '/day' and left '/d/day' cached,
    // which is an eviction that hits no key.
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const entry = new IndexEntry({ id: '1', name: 'f', resourceType: 'file' })
    await index.setDir('/d/day', [['chat.jsonl', entry]])
    const manager = new CacheManager(cache, index, '/d/', true)
    await manager.invalidateAfterUnlink(PathSpec.fromStrPath('/day'))
    expect((await index.listDir('/d/day')).entries).toBeUndefined()
  })

  it('reaches every key on a root mount', async () => {
    // A root mount strips to the empty prefix, so the eviction argument is '/'
    // and matches every key rather than nothing.
    const cache = new RAMFileCacheStore()
    await cache.set('/a.txt', new TextEncoder().encode('x'))
    await cache.set('/sub/b.txt', new TextEncoder().encode('y'))
    const manager = new CacheManager(cache, null, '/', true)
    await manager.dropPrefix()
    expect(await cache.exists('/a.txt')).toBe(false)
    expect(await cache.exists('/sub/b.txt')).toBe(false)
  })
})
