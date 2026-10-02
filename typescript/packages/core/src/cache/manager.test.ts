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
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileStat, FileType, PathSpec, ReadPolicy } from '../types.ts'
import { withCacheMutation } from './file/io.ts'
import { RAMFileCacheStore } from './file/ram.ts'
import { IndexEntry } from './index/config.ts'
import { LISTING_TRUST_WINDOW, PROBED_LIMIT } from './index/constants.ts'
import { RAMIndexCacheStore } from './index/ram.ts'
import { runInCommandScope } from './index/scope.ts'
import { IndexView } from './index/view.ts'
import { CacheManager } from './manager.ts'
import type { WriteReceipt } from './types.ts'
import { shiftPerformanceNow } from './_test_util.ts'
import { enoent } from '../utils/errors.ts'

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

  it("invalidateSubtree leaves a nested mount's bodies", async () => {
    // A mount nested under the subtree has its own backend, which nothing
    // done to this mount changes: dropping its bodies only forced a
    // re-download of every file it had cached.
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await cache.set('/data/chan/day/chat.jsonl', new TextEncoder().encode('one\n'))
    await cache.set('/data/chan/day/inner/kept.txt', new TextEncoder().encode('kept'))
    const manager = new CacheManager(
      cache,
      index,
      '/data/',
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ['/data/chan/day/inner'],
    )
    await manager.invalidateSubtree(PathSpec.fromStrPath('/chan/day'))
    expect(await cache.exists('/data/chan/day/chat.jsonl')).toBe(false)
    expect(await cache.exists('/data/chan/day/inner/kept.txt')).toBe(true)
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

describe('settleAfterWrite', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
  const dec = (b: Uint8Array | null): string | null =>
    b === null ? null : new TextDecoder().decode(b)
  const spec = (): PathSpec => PathSpec.fromStrPath('/data/x.txt')

  async function settled(
    receipt: WriteReceipt | null,
    policy: ReadPolicy = ReadPolicy.BOUNDED,
  ): Promise<RAMFileCacheStore> {
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await cache.set('/data/x.txt', enc('old\n'), { fingerprint: 't-old', ttl: 600 })
    const manager = newManager(cache, index, true, policy)
    await manager.settleAfterWrite(spec(), enc('new\n'), receipt, manager.generation)
    return cache
  }

  function newManager(
    cache: RAMFileCacheStore,
    index: RAMIndexCacheStore,
    cachesReads = true,
    policy: ReadPolicy = ReadPolicy.BOUNDED,
    ownsPath: (path: string) => boolean = () => true,
  ): CacheManager {
    return new CacheManager(
      cache,
      index,
      '/data/',
      cachesReads,
      ownsPath,
      undefined,
      600,
      undefined,
      undefined,
      undefined,
      policy,
    )
  }

  for (const policy of [ReadPolicy.BOUNDED, ReadPolicy.FRESH]) {
    it(`drops bytes the backend stored differently (${policy})`, async () => {
      // SharePoint property promotion: 4 bytes sent, 15 stored.
      const cache = await settled({ storedSize: 15, token: 't1' }, policy)
      expect(await cache.exists('/data/x.txt')).toBe(false)
    })

    for (const size of [4, null]) {
      it(`keeps vouched bytes with the backend token (${policy}, size ${String(size)})`, async () => {
        const cache = await settled({ storedSize: size, token: 't1' }, policy)
        expect(dec(await cache.get('/data/x.txt'))).toBe('new\n')
        expect(await cache.isFresh('/data/x.txt', 't1')).toBe(true)
        expect(await cache.isUnbounded('/data/x.txt')).toBe(false)
      })
    }
  }

  for (const receipt of [null, { storedSize: null, token: null }]) {
    it(`keeps a silent write tokenless on bounded (${JSON.stringify(receipt)})`, async () => {
      const cache = await settled(receipt, ReadPolicy.BOUNDED)
      expect(dec(await cache.get('/data/x.txt'))).toBe('new\n')
      expect(await cache.isFresh('/data/x.txt', 't-old')).toBe(false)
      // Bounded: the kept bytes expire with the mount's ttl like a read.
      expect(await cache.isUnbounded('/data/x.txt')).toBe(false)
    })
  }

  for (const receipt of [null, { storedSize: null, token: null }, { storedSize: 4, token: null }]) {
    it(`drops a silent write on fresh (${JSON.stringify(receipt)})`, async () => {
      const cache = await settled(receipt, ReadPolicy.FRESH)
      expect(await cache.exists('/data/x.txt')).toBe(false)
    })
  }

  it('drops when another mutation landed mid-upload', async () => {
    // Two writes race on one path and the earlier upload settles last: its
    // bytes may no longer be what the backend holds.
    const cache = new RAMFileCacheStore()
    const manager = newManager(cache, new RAMIndexCacheStore({ ttl: 600 }))
    const generation = manager.generation
    await manager.invalidateAfterWrite(PathSpec.fromStrPath('/data/y.txt'))
    await manager.settleAfterWrite(spec(), enc('new\n'), { storedSize: 4, token: 't1' }, generation)
    expect(await cache.exists('/data/x.txt')).toBe(false)
  })

  it('drops without a noted generation', async () => {
    const cache = new RAMFileCacheStore()
    await cache.set('/data/x.txt', enc('old\n'))
    const manager = newManager(cache, new RAMIndexCacheStore({ ttl: 600 }))
    await manager.settleAfterWrite(spec(), enc('new\n'), { storedSize: 4, token: 't1' }, null)
    expect(await cache.exists('/data/x.txt')).toBe(false)
  })

  it('keeps nothing for a key the mount does not own', async () => {
    const cache = new RAMFileCacheStore()
    await cache.set('/data/x.txt', enc('old\n'))
    const manager = newManager(
      cache,
      new RAMIndexCacheStore({ ttl: 600 }),
      true,
      ReadPolicy.BOUNDED,
      () => false,
    )
    await manager.settleAfterWrite(
      spec(),
      enc('new\n'),
      { storedSize: 4, token: 't1' },
      manager.generation,
    )
    expect(await cache.exists('/data/x.txt')).toBe(false)
  })

  it('leaves a non-caching mount uncached', async () => {
    const cache = new RAMFileCacheStore()
    const manager = newManager(cache, new RAMIndexCacheStore({ ttl: 600 }), false)
    await manager.settleAfterWrite(
      spec(),
      enc('new\n'),
      { storedSize: 4, token: 't1' },
      manager.generation,
    )
    expect(await cache.exists('/data/x.txt')).toBe(false)
  })

  for (const receipt of [{ storedSize: 4, token: 't1' }, null]) {
    it(`evicts the parent listing (${JSON.stringify(receipt)})`, async () => {
      const index = new RAMIndexCacheStore({ ttl: 600 })
      await index.setDir('/data', [
        ['x.txt', new IndexEntry({ id: 'x', name: 'x.txt', resourceType: 'file' })],
      ])
      const manager = newManager(new RAMFileCacheStore(), index)
      await manager.settleAfterWrite(spec(), enc('new\n'), receipt, manager.generation)
      expect((await index.listDir('/data')).entries ?? null).toBeNull()
    })
  }

  it('retires a read that began before the keep', async () => {
    // A readThrough that fetched the pre-write bytes and lands after the
    // keep must not put them back over what the write kept.
    const cache = new RAMFileCacheStore()
    const manager = newManager(cache, new RAMIndexCacheStore({ ttl: 600 }))
    let fetched!: () => void
    const fetchedP = new Promise<void>((r) => (fetched = r))
    let release!: () => void
    const releaseP = new Promise<void>((r) => (release = r))
    const reader = manager.readThrough(spec(), async () => {
      fetched()
      await releaseP
      return enc('old\n')
    })
    await fetchedP
    await manager.settleAfterWrite(
      spec(),
      enc('new\n'),
      { storedSize: 4, token: 't1' },
      manager.generation,
    )
    release()
    expect(dec(await reader)).toBe('old\n')
    expect(dec(await cache.get('/data/x.txt'))).toBe('new\n')
  })

  it("retires the command's probe answers", async () => {
    const manager = newManager(new RAMFileCacheStore(), new RAMIndexCacheStore({ ttl: 600 }))
    await runInCommandScope(async () => {
      manager.noteProbed(spec(), new FileStat({ name: 'x.txt', size: 4, type: FileType.FILE }))
      await manager.settleAfterWrite(
        spec(),
        enc('new\n'),
        { storedSize: 4, token: 't1' },
        manager.generation,
      )
      expect(manager.probedStat(spec())).toBeNull()
    })
  })

  it('retires probe answers on a non-caching mount', async () => {
    // A probe answer is remembered whether or not the mount caches bytes; a
    // write must still retire it, or a later stat in the same command serves
    // the pre-write size.
    const manager = newManager(new RAMFileCacheStore(), new RAMIndexCacheStore({ ttl: 600 }), false)
    await runInCommandScope(async () => {
      manager.noteProbed(spec(), new FileStat({ name: 'x.txt', size: 4, type: FileType.FILE }))
      await manager.settleAfterWrite(
        spec(),
        enc('new\n'),
        { storedSize: 4, token: 't1' },
        manager.generation,
      )
      expect(manager.probedStat(spec())).toBeNull()
    })
  })

  it('keeps nothing bigger than the cache', async () => {
    // A write larger than the whole cache would evict every warm entry, then
    // itself: it is dropped instead, and the warm entry survives.
    const cache = new RAMFileCacheStore({ limit: 10 })
    await cache.set('/data/w.txt', enc('abc'))
    await cache.set('/data/x.txt', enc('o'))
    const manager = newManager(cache, new RAMIndexCacheStore({ ttl: 600 }))
    await manager.settleAfterWrite(
      spec(),
      enc('x'.repeat(11)),
      { storedSize: 11, token: 't1' },
      manager.generation,
    )
    expect(await cache.exists('/data/x.txt')).toBe(false)
    expect(dec(await cache.get('/data/w.txt'))).toBe('abc')
  })

  it('keeps a write exactly the size of the cache', async () => {
    const cache = new RAMFileCacheStore({ limit: 10 })
    const manager = newManager(cache, new RAMIndexCacheStore({ ttl: 600 }))
    await manager.settleAfterWrite(
      spec(),
      enc('x'.repeat(10)),
      { storedSize: 10, token: 't1' },
      manager.generation,
    )
    expect(dec(await cache.get('/data/x.txt'))).toBe('x'.repeat(10))
  })

  it('a failed fill does not fail the write', async () => {
    // The upload already landed: like a background drain that fails, the
    // fill is skipped with a warning, and the parent listing still goes.
    class RefusingCache extends RAMFileCacheStore {
      override set(): Promise<void> {
        return Promise.reject(new Error('cache store refused the fill'))
      }
    }
    const cache = new RefusingCache()
    await RAMFileCacheStore.prototype.set.call(cache, '/data/x.txt', enc('old\n'))
    const index = new RAMIndexCacheStore({ ttl: 600 })
    await index.setDir('/data', [
      ['x.txt', new IndexEntry({ id: 'x', name: 'x.txt', resourceType: 'file' })],
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const manager = newManager(cache, index)
      await manager.settleAfterWrite(
        spec(),
        enc('new\n'),
        { storedSize: 4, token: 't1' },
        manager.generation,
      )
      expect(await cache.exists('/data/x.txt')).toBe(false)
      expect((await index.listDir('/data')).entries ?? null).toBeNull()
      expect(String(warn.mock.calls[0]?.[0])).toContain('/data/x.txt')
    } finally {
      warn.mockRestore()
    }
  })

  it('treats an empty token as none', async () => {
    // An empty token vouches for nothing: on a fresh mount the bytes are
    // dropped rather than kept under a fingerprint of ''.
    const cache = await settled({ storedSize: null, token: '' }, ReadPolicy.FRESH)
    expect(await cache.exists('/data/x.txt')).toBe(false)
  })
})
