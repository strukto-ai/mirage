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

import { activeRecords, runWithRecording } from '../observe/context.ts'
import { OpRecord } from '../observe/record.ts'
import type * as RecordModule from '../observe/record.ts'
import { publishRead } from './context.ts'
import { mountKey } from '../utils/key_prefix.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileStat, FileType, PathSpec } from '../types.ts'
import { withCacheMutation } from './file/io.ts'
import { RAMFileCacheStore } from './file/ram.ts'
import { IndexEntry, LookupStatus } from './index/config.ts'
import { CHECKED_LIMIT, LISTING_TRUST_WINDOW, PROBED_LIMIT } from './index/constants.ts'
import { RAMIndexCacheStore } from './index/ram.ts'
import { RedisIndexCacheStore } from './index/redis.ts'
import { runInCommandScope } from './index/scope.ts'
import { IndexView } from './index/view.ts'
import { CacheManager } from './manager.ts'
import { RefusingStore, shiftPerformanceNow } from './_test_util.ts'
import { enoent } from '../errors/fs.ts'

const built = vi.hoisted((): number[] => [])
vi.mock('../observe/record.ts', async (importOriginal) => {
  const real = await importOriginal<typeof RecordModule>()
  class CountedIndex extends real.RecordIndex {
    constructor(records: readonly OpRecord[]) {
      built.push(records.length)
      super(records)
    }
  }
  return { ...real, RecordIndex: CountedIndex }
})

async function seeded(): Promise<[RAMFileCacheStore, RAMIndexCacheStore]> {
  const cache = new RAMFileCacheStore()
  const index = new RAMIndexCacheStore({ ttl: 600 })
  await cache.set('/data/arch/h.txt', new TextEncoder().encode('two\n'))
  await index.setDir('/data/arch', [
    ['h.txt', new IndexEntry({ id: 'h', name: 'h.txt', resourceType: 'file' })],
  ])
  return [cache, index]
}

function file(name: string): IndexEntry {
  return new IndexEntry({ id: name, name, resourceType: 'file' })
}

const REDIS_URL = process.env.REDIS_URL

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
      vfsPath: mountKey('/data/arch/h.txt', '/data'),
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
    await cache.set('/other/keep.txt', new TextEncoder().encode('safe'))
    const manager = new CacheManager(cache, index, '/data/', true)
    await manager.dropPrefix()
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

  for (const kind of ['ram', 'ram-no-bodies', 'redis']) {
    it.skipIf(kind === 'redis' && REDIS_URL === undefined)(
      `${kind}: removing a folder drops what is cached beneath it`,
      async () => {
        const index =
          kind === 'redis'
            ? new RedisIndexCacheStore({
                ...(REDIS_URL === undefined ? {} : { url: REDIS_URL }),
                keyPrefix: `remove:${crypto.randomUUID()}:`,
              })
            : new RAMIndexCacheStore({ ttl: 600 })
        const cache = kind === 'ram-no-bodies' ? null : new RAMFileCacheStore()
        try {
          if (cache !== null) {
            await cache.set('/data/dir/sub/f', new TextEncoder().encode('old\n'))
            await cache.set('/data/dir2/x', new TextEncoder().encode('keep\n'))
          }
          await index.setDir('/data/dir/sub', [['f', file('f')]])
          await index.setDir('/data/dirx', [['y', file('y')]])
          await index.setDir('/data', [['other', file('other')]])
          const manager = new CacheManager(cache, index, '/data/', cache !== null)
          await manager.invalidateAfterRemove(PathSpec.fromStrPath('/data/dir'))
          expect((await index.listDir('/data/dir/sub')).status).toBe(LookupStatus.NOT_FOUND)
          expect((await index.listDir('/data')).entries).toBeUndefined()
          expect((await index.listDir('/data/dirx')).entries).toEqual(['/data/dirx/y'])
          if (cache !== null) {
            expect(await cache.exists('/data/dir/sub/f')).toBe(false)
            expect(await cache.exists('/data/dir2/x')).toBe(true)
          }
        } finally {
          try {
            await index.clear()
          } finally {
            await index.close()
          }
        }
      },
    )
  }

  it('removing a file does unlink work and nothing more', async () => {
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await cache.set('/data/d/f', new TextEncoder().encode('f'))
    await cache.set('/data/d/g', new TextEncoder().encode('g'))
    await cache.set('/data/e/h', new TextEncoder().encode('h'))
    await index.setDir(
      '/data',
      ['d', 'e'].map((name) => [name, new IndexEntry({ id: name, name, resourceType: 'folder' })]),
    )
    await index.setDir('/data/d', [
      ['f', file('f')],
      ['g', file('g')],
    ])
    await index.setDir('/data/e', [['h', file('h')]])
    const manager = new CacheManager(cache, index, '/data/', true)
    const evict = vi.spyOn(cache, 'evictPrefix')
    const drop = vi.spyOn(index, 'invalidatePrefix')
    const probe = vi.spyOn(index, 'holdsSubtree')
    await manager.invalidateAfterRemove(PathSpec.fromStrPath('/data/d/f'))
    expect(await cache.exists('/data/d/f')).toBe(false)
    expect(await cache.exists('/data/d/g')).toBe(true)
    expect(await cache.exists('/data/e/h')).toBe(true)
    expect((await index.listDir('/data')).entries).toEqual(['/data/d', '/data/e'])
    expect(
      Object.fromEntries([...(await index.entries())].map(([key, row]) => [key, row.resourceType])),
    ).toEqual({
      '/data/d': 'folder',
      '/data/e': 'folder',
      '/data/e/h': 'file',
    })
    expect((await index.listDir('/data/d')).entries).toBeUndefined()
    expect((await index.listDir('/data/e')).entries).toEqual(['/data/e/h'])
    expect(evict).toHaveBeenCalledTimes(0)
    expect(drop).toHaveBeenCalledTimes(0)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it.each(['probe', 'drop'] as const)(
    'still drops the body and listings when removal fails at %s',
    async (stage) => {
      const cache = new RAMFileCacheStore()
      const index = new RAMIndexCacheStore({ ttl: 600 })
      await cache.set('/data/d/f', new TextEncoder().encode('f'))
      for (const directory of ['/data/d', '/data/d/f']) await index.setDir(directory, [])
      const method = stage === 'probe' ? 'holdsSubtree' : 'invalidatePrefix'
      const error = new Error('registry recovery failed')
      vi.spyOn(index, method).mockRejectedValue(error)
      const manager = new CacheManager(cache, index, '/data/', true)
      await expect(manager.invalidateAfterRemove(PathSpec.fromStrPath('/data/d/f'))).rejects.toBe(
        error,
      )
      expect(await cache.exists('/data/d/f')).toBe(false)
      for (const directory of ['/data/d', '/data/d/f']) {
        expect((await index.listDir(directory)).entries).toBeUndefined()
      }
    },
  )

  it.each([false, true])('preserves cleanup failures when probe fails: %s', async (probeFails) => {
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await cache.set('/data/d/f', new TextEncoder().encode('f'))
    const manager = new CacheManager(cache, index, '/data/', true)
    const probe = vi.spyOn(index, 'holdsSubtree')
    if (probeFails) probe.mockRejectedValue(0)
    else probe.mockResolvedValue(false)
    const cleanupError = new Error('listing cleanup failed')
    const cleanup = vi.spyOn(index, 'invalidateDir').mockRejectedValue(cleanupError)
    const result = manager.invalidateAfterRemove(PathSpec.fromStrPath('/data/d/f'))
    if (probeFails) {
      await expect(result).rejects.toBeInstanceOf(AggregateError)
      await expect(result).rejects.toHaveProperty('errors', [0, cleanupError])
    } else {
      await expect(result).rejects.toBe(cleanupError)
    }
    expect(cleanup).toHaveBeenCalledExactlyOnceWith('/data/d/f')
    expect(await cache.exists('/data/d/f')).toBe(false)
  })

  it('without an index, treats a removed path as holding nothing below', async () => {
    // Mirrors the Python null index: no listing is cached anywhere, so only
    // the path itself goes and bodies beneath it stay until their ttl.
    const cache = new RAMFileCacheStore()
    await cache.set('/data/dir', new TextEncoder().encode('d'))
    await cache.set('/data/dir/f', new TextEncoder().encode('f'))
    const manager = new CacheManager(cache, null, '/data/', true)
    await manager.invalidateAfterRemove(PathSpec.fromStrPath('/data/dir'))
    expect(await cache.exists('/data/dir')).toBe(false)
    expect(await cache.exists('/data/dir/f')).toBe(true)
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

describe('CacheManager read gate', () => {
  const spec = (path = '/data/x.txt') =>
    new PathSpec({
      vfsPath: mountKey(path, '/data/'),
      virtual: path,
      directory: '/data/',
    })

  async function withEntry(data = new TextEncoder().encode('cached')) {
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await cache.set('/data/x.txt', data)
    return [cache, index] as const
  }

  const ownsAll = () => true

  it.each([
    [null, 'cached'],
    ['/data/x.txt', 'cached'],
    ['/data/x.txt/', null],
  ] as const)('serves the spelling %s as %s', async (dotted, served) => {
    // GNU's ENOTDIR for `f/` comes from the backend; the cache key drops the slash.
    const [cache, index] = await withEntry()
    const manager = new CacheManager(cache, index, '/data/', true)
    const path = new PathSpec({
      vfsPath: mountKey('/data/x.txt', '/data/'),
      virtual: '/data/x.txt',
      directory: '/data/',
      dotted,
    })
    const got = await manager.cachedBytes(path)
    expect(got === null ? null : new TextDecoder().decode(got)).toBe(served)
  })

  it('a refusal withholds the cached bytes', async () => {
    const [cache, index] = await withEntry()
    const asked: string[] = []
    const manager = new CacheManager(cache, index, '/data/', true, ownsAll, (key) => {
      asked.push(key)
      return Promise.resolve(false)
    })
    expect(await manager.cachedBytes(spec())).toBeNull()
    expect(asked).toEqual(['/data/x.txt'])
  })

  it('is not asked for a path the cache does not hold', async () => {
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const asked: string[] = []
    const manager = new CacheManager(cache, index, '/data/', true, ownsAll, (key) => {
      asked.push(key)
      return Promise.resolve(true)
    })
    expect(await manager.cachedBytes(spec())).toBeNull()
    expect(asked).toEqual([])
  })

  it('is not asked for a non-caching mount', async () => {
    const [cache, index] = await withEntry()
    const asked: string[] = []
    const manager = new CacheManager(cache, index, '/data/', false, ownsAll, (key) => {
      asked.push(key)
      return Promise.resolve(true)
    })
    expect(await manager.cachedBytes(spec())).toBeNull()
    expect(asked).toEqual([])
  })

  it('is not asked for a key the mount no longer owns', async () => {
    const [cache, index] = await withEntry()
    const asked: string[] = []
    const manager = new CacheManager(
      cache,
      index,
      '/data/',
      true,
      () => false,
      (key) => {
        asked.push(key)
        return Promise.resolve(true)
      },
    )
    expect(await manager.cachedBytes(spec())).toBeNull()
    expect(asked).toEqual([])
  })

  it('a gate reporting the object gone propagates', async () => {
    const [cache, index] = await withEntry()
    const manager = new CacheManager(cache, index, '/data/', true, ownsAll, () =>
      Promise.reject(enoent('/data/x.txt')),
    )
    await expect(manager.cachedBytes(spec())).rejects.toThrow()
  })

  it('cachedSize reports the length without revalidating', async () => {
    const [cache, index] = await withEntry()
    const asked: string[] = []
    const manager = new CacheManager(cache, index, '/data/', true, ownsAll, (key) => {
      asked.push(key)
      return Promise.resolve(false)
    })
    expect(await manager.cachedSize(spec())).toBe(6)
    expect(asked).toEqual([])
  })

  it('cachedSize of an empty render is 0, not null', async () => {
    const [cache, index] = await withEntry(new Uint8Array(0))
    const manager = new CacheManager(cache, index, '/data/', true)
    expect(await manager.cachedSize(spec())).toBe(0)
  })

  it('cachedSize of an absent path is null', async () => {
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(cache, index, '/data/', true)
    expect(await manager.cachedSize(spec())).toBeNull()
  })
})

function settleWithin(work: Promise<unknown>, ms: number): Promise<'done' | 'pending'> {
  return Promise.race([
    work.then(() => 'done' as const),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => {
        resolve('pending')
      }, ms)
    }),
  ])
}

describe('CacheManager index views', () => {
  it('shares one view per store', () => {
    const manager = new CacheManager(new RAMFileCacheStore(), null, '/data', true)
    const a = new RAMIndexCacheStore()
    expect(manager.scopeIndex(a)).toBe(manager.scopeIndex(a))
  })

  it('builds a new view when the store is replaced', async () => {
    const manager = new CacheManager(new RAMFileCacheStore(), null, '/data', true)
    const a = new RAMIndexCacheStore()
    const b = new RAMIndexCacheStore()
    manager.scopeIndex(a)
    const view = manager.scopeIndex(b)
    expect((view as IndexView).store).toBe(b)
    await view.setDir('/data', [
      ['x', new IndexEntry({ id: 'x', name: 'x', resourceType: 'file' })],
    ])
    expect((await b.listDir('/data')).entries).toEqual(['/data/x'])
    expect((await a.listDir('/data')).entries).toBeUndefined()
  })

  it('hands back a view it is given, whatever it has memoized', () => {
    const cache = new RAMFileCacheStore()
    const manager = new CacheManager(cache, null, '/data', true)
    manager.scopeIndex(new RAMIndexCacheStore())
    const other = new IndexView(new RAMIndexCacheStore(), cache, '/data', () => true)
    expect(manager.scopeIndex(other)).toBe(other)
  })

  it('hands back the raw store without a file cache', () => {
    const a = new RAMIndexCacheStore()
    const manager = new CacheManager(null, null, '/data', true)
    expect(manager.scopeIndex(a)).toBe(a)
  })

  it('refuses to build a lock-held view over a view', () => {
    const cache = new RAMFileCacheStore()
    const manager = new CacheManager(cache, null, '/data', true)
    const view = new IndexView(new RAMIndexCacheStore(), cache, '/data', () => true)
    expect(typeof manager.scopeIndexLocked).toBe('function')
    expect(() => manager.scopeIndexLocked(view)).toThrow()
  })

  it('hands back the raw store for a lock-held scope without a file cache', () => {
    const a = new RAMIndexCacheStore()
    const manager = new CacheManager(null, null, '/data', true)
    expect(manager.scopeIndexLocked(a)).toBe(a)
  })

  it('never memoizes a lock-held view or shares the memo slot', async () => {
    const cache = new RAMFileCacheStore()
    const manager = new CacheManager(cache, null, '/data', true)
    const a = new RAMIndexCacheStore()
    const locked = manager.scopeIndexLocked(a)
    expect(locked).toBeInstanceOf(IndexView)
    expect(manager.scopeIndexLocked(a)).not.toBe(locked)
    const shared = manager.scopeIndex(a)
    expect(shared).not.toBe(locked)
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = withCacheMutation(cache, () => gate)
    try {
      const pending = shared.get('/data/x')
      expect(await settleWithin(pending, 20)).toBe('pending')
      release()
      expect(await settleWithin(pending, 1000)).toBe('done')
    } finally {
      release()
      await held
    }
  })
})

describe('what a mount has listed since a command started', () => {
  // A glob writes through its own locked view; the command's later ls
  // through the shared view must trust that same write.
  it('counts a write through the locked view for the shared one', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    await runInCommandScope(async () => {
      await manager.scopeIndexLocked(index).setDir('/data', [])
      expect(manager.listingTrusted('/data')).toBe(true)
      expect(manager.listingTrusted('/data/other')).toBe(false)
    })
  })

  it('does not count a write before the command', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    await manager.scopeIndex(index).setDir('/data', [])
    await runInCommandScope(() => {
      expect(manager.listingTrusted('/data')).toBe(false)
      return Promise.resolve()
    })
  })

  it('forgets what the old store was written when the store is replaced', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    await runInCommandScope(async () => {
      await manager.scopeIndex(index).setDir('/data', [])
      manager.scopeIndex(new RAMIndexCacheStore({ ttl: 600 }))
      expect(manager.listingTrusted('/data')).toBe(false)
    })
  })
})

describe('which listings a mount trusts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('trusts a listing for the window outside any command', async () => {
    const clock = shiftPerformanceNow()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    await manager.scopeIndex(index).setDir('/data', [])
    expect(manager.listingTrusted('/data')).toBe(true)
    expect(manager.listingTrusted('/data/other')).toBe(false)
    clock.advance(LISTING_TRUST_WINDOW * 1000)
    expect(manager.listingTrusted('/data')).toBe(false)
  })

  // A listing the previous command wrote a moment ago is still re-listed by
  // the next one: the window is only for reads that belong to no command.
  it('does not apply the window inside a command', async () => {
    const clock = shiftPerformanceNow()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    await manager.scopeIndex(index).setDir('/data', [])
    await runInCommandScope(async () => {
      expect(manager.listingTrusted('/data')).toBe(false)
      await manager.scopeIndex(index).setDir('/data', [])
      clock.advance(LISTING_TRUST_WINDOW * 10_000)
      expect(manager.listingTrusted('/data')).toBe(true)
    })
  })
})

describe('which version check a mount remembers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Check A is sent and stalls; once it is out of the window a caller sends
  // check B, which answers V2 first. A then lands with V1, the head it saw
  // before the move. Recording A would put the memo back to V1: a listing
  // stored at V2 would be re-checked, and one stored at V1 served as current.
  it('never lets a late, older check replace a newer memo', async () => {
    const clock = shiftPerformanceNow()
    const manager = new CacheManager(
      new RAMFileCacheStore(),
      new RAMIndexCacheStore({ ttl: 600 }),
      '/data/',
      true,
    )
    let release: (version: string) => void = () => undefined
    const stalled = new Promise<string>((resolve) => {
      release = resolve
    })
    const asked: string[] = []
    const answer = (version: string) => (): Promise<string> => {
      asked.push(version)
      return Promise.resolve(version)
    }
    const first = manager.checkedVersion('/data', 'V0', () => stalled)
    clock.advance(LISTING_TRUST_WINDOW * 1000 + 10)
    expect(await manager.checkedVersion('/data', 'V0', answer('V2'))).toBe('V2')
    release('V1')
    expect(await first).toBe('V1')
    asked.length = 0
    expect(await manager.checkedVersion('/data', 'V2', answer('V3'))).toBe('V2')
    expect(asked).toEqual([])
    expect(await manager.checkedVersion('/data', 'V1', answer('V4'))).toBe('V4')
    expect(asked).toEqual(['V4'])
  })

  // A check serves only a caller inside its window, so once the map is full
  // the stale entries are dead weight; dropping one costs at most another
  // check, never a stale listing.
  it('drops checks out of their window once the map is full', async () => {
    const clock = shiftPerformanceNow()
    const manager = new CacheManager(
      new RAMFileCacheStore(),
      new RAMIndexCacheStore({ ttl: 600 }),
      '/data/',
      true,
    )
    const limit: number = CHECKED_LIMIT
    expect(limit).toBeGreaterThan(0)
    const check = (): Promise<string> => Promise.resolve('V')
    for (let n = 0; n < limit; n++) {
      expect(await manager.checkedVersion(`/data/old${String(n)}`, 'V', check)).toBe('V')
    }
    clock.advance(LISTING_TRUST_WINDOW * 1000 + 10)
    expect(await manager.checkedVersion('/data/new', 'V', check)).toBe('V')
    const checked = (manager as unknown as { checked: Map<string, unknown> }).checked
    expect([...checked.keys()]).toEqual(['/data/new'])
  })
})

describe('what a probe saw this command', () => {
  const path = PathSpec.fromStrPath('/data/arch/h.txt')
  const probed = (): FileStat => new FileStat({ name: 'h.txt', size: 4, type: FileType.FILE })

  it('is served for the rest of its command only', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    const stat = probed()
    await runInCommandScope(() => {
      manager.noteProbed(path, stat)
      expect(manager.probedStat(path)).toBe(stat)
      expect(manager.probedStat(PathSpec.fromStrPath('/data/arch/other'))).toBeNull()
      return Promise.resolve()
    })
    expect(manager.probedStat(path)).toBeNull()
    await runInCommandScope(() => {
      expect(manager.probedStat(path)).toBeNull()
      return Promise.resolve()
    })
  })

  it('is never served for a probe outside a command', () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    manager.noteProbed(path, probed())
    expect(manager.probedStat(path)).toBeNull()
  })

  it.each([false, true])('does not reuse an overlapping probe (scoped: %s)', async (scoped) => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    let ready = (): void => undefined
    let release = (): void => undefined
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve
    })
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    const note = async (): Promise<void> => {
      ready()
      await releasePromise
      manager.noteProbed(path, probed())
    }
    const producer = scoped ? runInCommandScope(note) : note()
    await readyPromise
    await runInCommandScope(async () => {
      release()
      await producer
      expect(manager.probedStat(path)).toBeNull()
    })
  })

  // Every door that drops cached state: a write the command makes, a clear
  // after native code ran (an external program, a remote runtime line), a
  // path-less CLI mutation, and a re-list that found the file gone. Each one
  // means the backend may no longer match what the probe saw.
  const DROPS: [string, (manager: CacheManager, index: RAMIndexCacheStore) => Promise<void>][] = [
    ['a write', (m) => m.invalidateAfterWrite(PathSpec.fromStrPath('/data/elsewhere'))],
    ['an unlink', (m) => m.invalidateAfterUnlink(PathSpec.fromStrPath('/data/elsewhere'))],
    ['a subtree drop', (m) => m.invalidateSubtree(PathSpec.fromStrPath('/data/elsewhere'))],
    ['a removal', (m) => m.invalidateAfterRemove(PathSpec.fromStrPath('/data/elsewhere'))],
    ['an external clear', (m, index) => m.clearIndex(index)],
    ['a path-less drop', (m) => m.dropPrefix()],
    [
      'a re-list that found it gone',
      async (m, index) => {
        const view = m.scopeIndex(index)
        await view.setDir('/data/arch', [
          ['h.txt', new IndexEntry({ id: 'h', name: 'h.txt', resourceType: 'file' })],
        ])
        await view.setDir('/data/arch', [])
      },
    ],
  ]
  for (const [name, drop] of DROPS) {
    it(`is retired by ${name} in the same command`, async () => {
      const index = new RAMIndexCacheStore({ ttl: 600 })
      const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
      await runInCommandScope(async () => {
        manager.noteProbed(path, probed())
        expect(manager.probedStat(path)).not.toBeNull()
        await drop(manager, index)
        expect(manager.probedStat(path)).toBeNull()
      })
    })
  }

  // Only the probing command is ever served an answer, so once the map is
  // full the other commands' entries are dead weight; dropping one costs at
  // most a backend stat, never a wrong answer.
  // Past the bound, a prune that frees nothing (every entry is the running
  // command's) must not run again on the next insert, or a large walk turns
  // quadratic: the next prune waits until the map has doubled.
  it('does not rescan one large command on every insert', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    const spy = vi.spyOn(manager as unknown as { pruneProbes: () => void }, 'pruneProbes')
    await runInCommandScope(() => {
      for (let n = 0; n < PROBED_LIMIT * 4; n++) {
        manager.noteProbed(PathSpec.fromStrPath(`/data/f${String(n)}`), probed())
      }
      return Promise.resolve()
    })
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('drops finished commands past the bound', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    for (let n = 0; n < PROBED_LIMIT; n++) {
      await runInCommandScope(() => {
        manager.noteProbed(PathSpec.fromStrPath(`/data/old${String(n)}`), probed())
        return Promise.resolve()
      })
    }
    await runInCommandScope(() => {
      const mine = PathSpec.fromStrPath('/data/mine')
      manager.noteProbed(mine, probed())
      expect(manager.probedStat(mine)).not.toBeNull()
      expect((manager as unknown as { probed: Map<string, unknown> }).probed.size).toBe(1)
      return Promise.resolve()
    })
  })
})

it.each(['none', 'write', 'replace', 'unmount'])(
  'retained fallback row is fenced: %s',
  async (interference) => {
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore()
    let owns = true
    const manager = new CacheManager(cache, index, '/data/', true, () => owns)
    let old = new IndexEntry({ id: 'old', name: 'a', resourceType: 'file' })
    const confirmed = old.copyWith({ id: 'confirmed' })
    await index.setDir('/data', [['a', old]])
    const listing = await index.listDir('/data')
    old = (await index.get('/data/a')).entry ?? old
    const generation = manager.generation
    let pending: Promise<void> | undefined
    await manager.withMutation(async () => {
      pending = manager.retainResolvedEntry(
        PathSpec.fromStrPath('/data/a'),
        generation,
        JSON.stringify(old),
        confirmed,
      )
      await Promise.resolve()
      if (interference === 'write') await manager.invalidateAfterWrite('/data/a')
      else if (interference === 'replace') await index.put('/data/a', old.copyWith({ id: 'newer' }))
      else if (interference === 'unmount') owns = false
    })
    await pending
    const row = (await index.get('/data/a')).entry
    if (interference === 'none') {
      expect(row?.id).toBe(confirmed.id)
      expect(await index.listDir('/data')).toEqual(listing)
    } else if (interference === 'replace') expect(row?.id).toBe('newer')
    else expect(row == null || row.id === 'old').toBe(true)
  },
)

it.each(['replace', 'delete'])(
  'retention cannot overwrite a peer workspace: %s',
  async (interference) => {
    const index = new RAMIndexCacheStore()
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    const peer = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    const path = PathSpec.fromStrPath('/data/a')
    const old = new IndexEntry({ id: 'old', name: 'a', resourceType: 'file', indexTime: 'old' })
    const latest = old.copyWith({ size: 9 })
    await index.put(path.virtual, old)
    const originalGet = index.get.bind(index)
    let interferences = 0
    const originalReplace = index.replaceIfUnchanged.bind(index)
    const interfere = () =>
      peer.withMutation(async () => {
        interferences++
        const view = peer.scopeIndexLocked(index)
        if (interference === 'replace') await view.put(path.virtual, latest)
        else await view.invalidateEntry(path.virtual)
      })
    const lookup = vi.spyOn(index, 'get').mockImplementation(async (key) => {
      const result = await originalGet(key)
      await interfere()
      return result
    })
    const replace = vi
      .spyOn(index, 'replaceIfUnchanged')
      .mockImplementation(async (key, predecessor, replacement) => {
        await interfere()
        return originalReplace(key, predecessor, replacement)
      })
    try {
      await manager.retainResolvedEntry(
        path,
        manager.generation,
        JSON.stringify(old),
        old.copyWith({ id: 'confirmed' }),
      )
      expect(interferences).toBe(1)
      expect((await originalGet(path.virtual)).entry ?? null).toEqual(
        interference === 'replace' ? latest : null,
      )
    } finally {
      lookup.mockRestore()
      replace.mockRestore()
    }
  },
)

it.each(['verified', null])(
  'fill keeps exact read fact without observing: %s',
  async (fingerprint) => {
    const cache = new RAMFileCacheStore()
    const manager = new CacheManager(cache, null, '/s3/', true)
    const data = new TextEncoder().encode('payload')
    expect(
      await manager.fill(PathSpec.fromStrPath('/s3/a.txt', 'a.txt'), () => {
        expect(activeRecords()).toBeUndefined()
        publishRead('/s3/a.txt', data, fingerprint)
        publishRead('/s3/a.txt', new TextEncoder().encode('foreign'), 'wrong')
        return Promise.resolve(data)
      }),
    ).toBe(data)
    expect(await cache.isFresh('/s3/a.txt', 'verified')).toBe(fingerprint !== null)
    expect(await cache.isFresh('/s3/a.txt', 'wrong')).toBe(false)
    expect(activeRecords()).toBeUndefined()
  },
)

it('failed fact capture does not leak into the next fill', async () => {
  const cache = new RAMFileCacheStore()
  const manager = new CacheManager(cache, null, '/s3/', true)
  const data = new TextEncoder().encode('payload')
  await expect(
    manager.fill(PathSpec.fromStrPath('/s3/a.txt', 'a.txt'), () => {
      publishRead('/s3/a.txt', data, 'orphan')
      return Promise.reject(new Error('failed fetch'))
    }),
  ).rejects.toThrow('failed fetch')
  expect(await cache.exists('/s3/a.txt')).toBe(false)
  await manager.fill(PathSpec.fromStrPath('/s3/a.txt', 'a.txt'), () => Promise.resolve(data))
  expect(await cache.isFresh('/s3/a.txt', 'orphan')).toBe(false)
})

describe('a cold read bigger than the cache', () => {
  it('is not kept', async () => {
    const cache = new RAMFileCacheStore({ limit: 10 })
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await cache.set('/data/warm', new TextEncoder().encode('abc'))
    const manager = new CacheManager(cache, index, '/data/', true)
    const big = new TextEncoder().encode('x'.repeat(11))
    const spec = new PathSpec({
      vfsPath: mountKey('/data/big', '/data/'),
      virtual: '/data/big',
      directory: '/data/',
    })
    expect(await manager.fill(spec, () => Promise.resolve(big))).toEqual(big)
    expect(await cache.exists('/data/big')).toBe(false)
    expect(new TextDecoder().decode((await cache.get('/data/warm')) ?? new Uint8Array())).toBe(
      'abc',
    )
  })

  it('still returns its bytes when the store refuses the fill', async () => {
    const manager = new CacheManager(
      new RefusingStore(),
      new RAMIndexCacheStore({ ttl: 600 }),
      '/data/',
      true,
    )
    const hello = new TextEncoder().encode('hello')
    const spec = new PathSpec({
      vfsPath: mountKey('/data/a', '/data/'),
      virtual: '/data/a',
      directory: '/data/',
    })
    expect(await manager.fill(spec, () => Promise.resolve(hello))).toEqual(hello)
  })
})

describe('version lookups in one line', () => {
  it('index the line a bounded number of times, not once per write', async () => {
    // One index per line, absorbing only new records; one per write was quadratic.
    const manager = new CacheManager(new RAMFileCacheStore(), null, '/data/', true)
    const path = PathSpec.fromStrPath('/data/f')
    built.length = 0
    await runWithRecording(async () => {
      const records = activeRecords() as OpRecord[]
      for (let i = 0; i < 50; i++) {
        records.push(
          new OpRecord({
            op: 'write',
            path: '/data/f',
            source: 's3',
            bytes: 1,
            timestamp: 0,
            durationMs: 0,
            fingerprint: `v${String(i)}`,
          }),
        )
        expect(await manager.readVersions([path])).toEqual([`v${String(i)}`])
      }
    })
    expect(built.length).toBeLessThan(3)
  })
})
