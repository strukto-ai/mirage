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

import { afterEach, describe, expect, it, vi } from 'vitest'

import { RAMFileCacheStore } from './file/ram.ts'
import { LISTING_TRUST_WINDOW } from './index/constants.ts'
import { RAMIndexCacheStore } from './index/ram.ts'
import { CacheManager } from './manager.ts'
import { shiftPerformanceNow } from './_test_util.ts'
import { PathSpec } from '../types.ts'
import {
  activeCacheManager,
  evictAfter,
  invalidateAfterMove,
  invalidateAfterUnlink,
  invalidateAfterWrite,
  invalidateAncestors,
  invalidateSubtree,
  listingRefreshed,
  runWithCacheManager,
} from './context.ts'

class FakeManager {
  listingTrusted(_folder: string): boolean {
    return false
  }

  probedStat(): null {
    return null
  }

  readThrough(_path: PathSpec, fetch: () => Promise<Uint8Array>): Promise<Uint8Array> {
    return fetch()
  }

  writes: string[] = []
  unlinks: string[] = []
  subtrees: string[] = []
  ancestors: PathSpec[] = []

  invalidateAfterWrite(path: string | PathSpec): Promise<void> {
    this.writes.push(path as string)
    return Promise.resolve()
  }

  invalidateAfterUnlink(path: string | PathSpec): Promise<void> {
    this.unlinks.push(path as string)
    return Promise.resolve()
  }

  invalidateAncestors(path: PathSpec): Promise<void> {
    this.ancestors.push(path)
    return Promise.resolve()
  }

  invalidateAfterMove(path: string | PathSpec, folder: boolean): Promise<void> {
    return folder ? this.invalidateSubtree(path) : this.invalidateAfterUnlink(path)
  }

  invalidateSubtree(path: string | PathSpec): Promise<void> {
    this.subtrees.push(path as string)
    return Promise.resolve()
  }

  cachedBytes(_path: PathSpec): Promise<Uint8Array | null> {
    return Promise.resolve(null)
  }

  cachedSize(_path: PathSpec): Promise<number | null> {
    return Promise.resolve(null)
  }
}

describe('cache context', () => {
  it('delegates to the active manager', async () => {
    const manager = new FakeManager()
    await runWithCacheManager(manager, async () => {
      await invalidateAfterWrite('/a.txt')
      await invalidateAfterUnlink('/b.txt')
      await invalidateSubtree('/c')
      await invalidateAfterMove('/d', true)
      await invalidateAfterMove('/e', false)
    })
    expect(manager.writes).toEqual(['/a.txt'])
    expect(manager.unlinks).toEqual(['/b.txt', '/e'])
    expect(manager.subtrees).toEqual(['/c', '/d'])
  })

  it('no-ops without an active manager', async () => {
    await invalidateAfterWrite('/a.txt')
    await invalidateAfterUnlink('/b.txt')
    await invalidateSubtree('/c')
    await invalidateAncestors(PathSpec.fromStrPath('/c/d'))
  })

  it('scopes the manager to the run', async () => {
    const manager = new FakeManager()
    await runWithCacheManager(manager, async () => {
      expect(activeCacheManager()).toBe(manager)
      await Promise.resolve()
    })
    expect(activeCacheManager()).toBeNull()
  })

  it('nested runs restore the outer manager', async () => {
    const outer = new FakeManager()
    const inner = new FakeManager()
    await runWithCacheManager(outer, async () => {
      await runWithCacheManager(inner, async () => {
        expect(activeCacheManager()).toBe(inner)
        await Promise.resolve()
      })
      expect(activeCacheManager()).toBe(outer)
    })
  })

  it('invalidateAncestors preserves the full virtual path', async () => {
    const manager = new FakeManager()
    const path = new PathSpec({
      virtual: '/data/data/a/b.txt',
      vfsPath: 'data/a/b.txt',
      directory: '/data/data/a',
    })
    await runWithCacheManager(manager, async () => {
      await invalidateAncestors(path)
    })
    expect(manager.ancestors).toEqual([path])
    expect(manager.writes).toEqual([])
  })
})

it.each(['/data', '/nested/data'])('evicts ancestors under repeated mount %s', async (prefix) => {
  const index = new RAMIndexCacheStore({ ttl: 600 })
  const manager = new CacheManager(null, index, prefix, true)
  const directory = `${prefix}${prefix}/a`
  const ancestors = [prefix, `${prefix}${prefix}`, directory]
  for (const ancestor of ancestors) await index.setDir(ancestor, [])
  await index.setDir(`${prefix}/unrelated`, [])
  const path = new PathSpec({
    virtual: `${directory}/b.txt`,
    directory,
    vfsPath: `${directory.slice(prefix.length + 1)}/b.txt`,
  })
  await runWithCacheManager(manager, async () => {
    await invalidateAfterWrite(path)
    await invalidateAncestors(path)
  })
  for (const ancestor of ancestors) expect((await index.listDir(ancestor)).entries).toBeUndefined()
  expect((await index.listDir(`${prefix}/unrelated`)).entries).toBeDefined()
})

describe('listingRefreshed', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // github's truncated-tree walk asks here rather than through the gate, so a
  // read that belongs to no command trusts a listing for the window too.
  it("follows the manager's listing rule", async () => {
    const clock = shiftPerformanceNow()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    await manager.scopeIndex(index).setDir('/data', [])
    await runWithCacheManager(manager, () => {
      expect(listingRefreshed('/data')).toBe(true)
      clock.advance(LISTING_TRUST_WINDOW * 1000)
      expect(listingRefreshed('/data')).toBe(false)
      return Promise.resolve()
    })
  })
})

class OpFailed extends Error {}
class EvictFailed extends Error {}

describe('evictAfter', () => {
  // The op's own error wins over an eviction that fails after it; that
  // eviction error is reported instead.
  it.each([
    [null, false, null, 'done'],
    [OpFailed, false, OpFailed, undefined],
    [OpFailed, true, OpFailed, undefined],
    [null, true, EvictFailed, 'done'],
  ] as const)(
    'op error %o, eviction breaks %s: raises %o',
    async (opError, breaks, raised, seen) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const results: (string | undefined)[] = []
      const run = evictAfter(
        () => (opError === null ? Promise.resolve('done') : Promise.reject(new opError())),
        (result) => {
          results.push(result)
          return breaks ? Promise.reject(new EvictFailed()) : Promise.resolve()
        },
      )
      if (raised === null) expect(await run).toBe('done')
      else await expect(run).rejects.toBeInstanceOf(raised)
      expect(results).toEqual([seen])
      expect(warn).toHaveBeenCalledTimes(opError !== null && breaks ? 1 : 0)
      warn.mockRestore()
    },
  )
})
