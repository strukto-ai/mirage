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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubAccessor } from '../../accessor/github.ts'
import { IndexEntry, LookupStatus, type ListResult } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { RedisIndexCacheStore } from '../../cache/index/redis.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileType, PathSpec } from '../../types.ts'
import { GitHubApiError } from './client.ts'
import { FakeGitHub, blobSha, raceIndex, servedAccessor } from './_test_util.ts'
import { lookupRetrying, pointLookup } from './lookup.ts'
import { stat } from './stat.ts'
import { refillIndex } from './tree.ts'

const FILES = {
  'README.md': 'hello',
  'docs/a.txt': 'alpha',
  'docs/sub/b.txt': 'bravo',
  'docs/link.txt': 'a.txt',
}

function spec(rel: string, prefix = '/gh'): PathSpec {
  const virtual = `${prefix}/${rel}`
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')),
    resolved: false,
    vfsPath: rel,
  })
}

let gh: FakeGitHub

beforeEach(() => {
  gh = new FakeGitHub(FILES)
  gh.symlinks.add('docs/link.txt')
  vi.stubGlobal('fetch', gh.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// The listings asked, once each. The client re-sends a refused request
// three more times (pre-existing: `request.retries` on the Octokit client
// makes its limiter retry any failure, 401 and 404 included), which python
// does not, so a refused row is compared by what was asked, not how often.
function asked(route: string): string[] {
  return [...new Set(gh.log.filter(([name]) => name === route).map(([, raw]) => raw))]
}

async function listed(index: IndexCacheStore = new RAMIndexCacheStore()): Promise<GitHubAccessor> {
  const accessor = servedAccessor()
  await refillIndex(accessor, index, '/gh')
  gh.log.length = 0
  return accessor
}

function store(backend: string): IndexCacheStore {
  const url = process.env.REDIS_URL
  return backend === 'ram'
    ? new RAMIndexCacheStore()
    : new RedisIndexCacheStore({
        ...(url === undefined ? {} : { url }),
        keyPrefix: `github-lookup:${crypto.randomUUID()}:`,
      })
}

for (const backend of ['ram', 'redis']) {
  describe.skipIf(backend === 'redis' && process.env.REDIS_URL === undefined)(
    `the point route's gate on ${backend}`,
    () => {
      it('asks one directory once the mount has listed', async () => {
        const index = store(backend)
        const accessor = await listed()
        const result = await stat(accessor, spec('docs/a.txt'), index)
        expect(result.fingerprint).toBe(await blobSha('alpha'))
        // One shallow listing of the parent, never the whole repository.
        expect(gh.counts()).toEqual([1, 0, 0])
        await index.close()
      })

      it('answers a live index without a request', async () => {
        const index = store(backend)
        const accessor = await listed(index)
        await stat(accessor, spec('docs/a.txt'), index)
        expect(gh.counts()).toEqual([0, 0, 0])
        await index.close()
      })

      it('refills an expired index rather than asking one directory', async () => {
        const index = store(backend)
        const accessor = await listed(index)
        await index.invalidate()
        await stat(accessor, spec('docs/a.txt'), index)
        expect(gh.counts()).toEqual([0, 1, 0])
        await index.close()
      })

      it('walks and seeds on a mount that never listed', async () => {
        const index = store(backend)
        await stat(servedAccessor(), spec('docs/a.txt'), index)
        expect(gh.counts()).toEqual([0, 1, 0])
        expect((await index.listDir('/gh')).entries).not.toBeNull()
        await index.close()
      })
    },
  )
}

describe('the point route', () => {
  it('never asks one directory without an index', async () => {
    const accessor = await listed()
    await expect(stat(accessor, spec('docs/a.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(gh.counts()).toEqual([0, 0, 0])
  })

  it('keys on the root listing, not on emptiness', async () => {
    const accessor = await listed()
    const index = new RAMIndexCacheStore()
    await index.setDir('/gh/other', [
      ['x', new IndexEntry({ id: 'x', name: 'x', resourceType: 'file', size: 1 })],
    ])
    await stat(accessor, spec('docs/a.txt'), index)
    expect(gh.counts()).toEqual([1, 0, 0])
  })

  it('reads the root before the accessor', async () => {
    const order: string[] = []
    const accessor = await listed()
    let refills = 1
    // ES2022 class fields shadow a subclass getter, so the recording
    // property goes on the instance.
    Object.defineProperty(accessor, 'refills', {
      get: () => {
        order.push('refills')
        return refills
      },
      set: (value: number) => {
        refills = value
      },
    })
    class Ordered extends RAMIndexCacheStore {
      override listDir(path: string): Promise<ListResult> {
        order.push(`list:${path}`)
        return super.listDir(path)
      }
    }
    const live = new Ordered()
    await refillIndex(accessor, live, '/gh')
    order.length = 0
    // A live root answers without the accessor being consulted at all.
    expect(await pointLookup(accessor, live, '/gh', 'docs/a.txt')).toBeNull()
    expect(order).toEqual(['list:/gh'])
    order.length = 0
    const found = await pointLookup(accessor, new Ordered(), '/gh', 'docs/a.txt')
    expect(found?.entry).not.toBeNull()
    expect(order.slice(0, 2)).toEqual(['list:/gh', 'refills'])
  })

  it('writes nothing', async () => {
    const accessor = await listed()
    const tree = accessor.tree
    const snapshot = structuredClone(tree)
    const state = [accessor.truncated, accessor.refills]
    const index = new RAMIndexCacheStore()
    await stat(accessor, spec('docs/a.txt'), index)
    expect(accessor.tree).toBe(tree)
    expect(accessor.tree).toEqual(snapshot)
    expect([accessor.truncated, accessor.refills]).toEqual(state)
    expect((await index.listDir('/gh')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await index.listDir('/gh/docs')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await index.get('/gh/docs/a.txt')).entry ?? null).toBeNull()
  })

  for (const rel of [
    'README.md',
    'docs/a.txt',
    'docs/sub/b.txt',
    'docs/link.txt',
    'docs',
    'docs/sub',
  ]) {
    it(`renders ${rel} as the tree route does`, async () => {
      const byPoint = await stat(await listed(), spec(rel), new RAMIndexCacheStore())
      expect(gh.counts()).toEqual([1, 0, 0])
      const byTree = await stat(servedAccessor(), spec(rel), new RAMIndexCacheStore())
      const fields = (s: typeof byPoint) => [s.name, s.type, s.size, s.fingerprint, s.content]
      expect(fields(byPoint)).toEqual(fields(byTree))
      // A symlink row is the link's own blob: its sha and the length of its
      // text, which is what a read of it returns.
      if (rel === 'docs/link.txt') expect(byPoint.size).toBe('a.txt'.length)
      if (rel === 'docs' || rel === 'docs/sub') expect(byPoint.type).toBe(FileType.DIRECTORY)
    })
  }

  it('answers a missing file absent without a walk', async () => {
    const accessor = await listed()
    await expect(
      stat(accessor, spec('docs/nope.txt'), new RAMIndexCacheStore()),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(gh.counts()).toEqual([1, 0, 0])
  })

  it('defers a missing directory to the tree', async () => {
    const accessor = await listed()
    gh.fail.set('dir', [404, 'Not Found'])
    const result = await stat(accessor, spec('docs/a.txt'), new RAMIndexCacheStore())
    expect(result.fingerprint).toBe(await blobSha('alpha'))
    expect(asked('dir')).toEqual(['main%3Adocs'])
    expect([gh.count('recursive'), gh.count('blob')]).toEqual([1, 0])
  })

  it('reads a repository it cannot see as an error, not absence', async () => {
    const accessor = await listed()
    // Lost access and a deleted ref answer 404 on both endpoints.
    gh.fail.set('dir', [404, 'Not Found'])
    gh.fail.set('recursive', [404, 'Not Found'])
    const err = await stat(accessor, spec('docs/a.txt'), new RAMIndexCacheStore()).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(GitHubApiError)
    expect((err as GitHubApiError).status).toBe(404)
  })

  it('raises a refused token without a walk', async () => {
    const accessor = await listed()
    gh.fail.set('dir', [401, 'Bad credentials'])
    const err = await stat(accessor, spec('docs/a.txt'), new RAMIndexCacheStore()).catch(
      (e: unknown) => e,
    )
    expect((err as GitHubApiError).status).toBe(401)
    expect(asked('dir')).toEqual(['main%3Adocs'])
    expect([gh.count('recursive'), gh.count('blob')]).toEqual([0, 0])
  })

  it('defers a truncated listing that lacks the row', async () => {
    const accessor = await listed()
    gh.truncatedDirs.set('docs', 0)
    const result = await stat(accessor, spec('docs/a.txt'), new RAMIndexCacheStore())
    expect(result.fingerprint).toBe(await blobSha('alpha'))
    expect(gh.counts()).toEqual([1, 1, 0])
  })
})

describe('the retry', () => {
  for (const kind of ['list', 'stale', 'get', 'reseed'] as const) {
    it(`recovers a stat when the index changes under it (${kind})`, async () => {
      const index = raceIndex(kind)
      const accessor = await listed(index)
      index.accessor = accessor
      index.fired = false
      const result = await stat(accessor, spec('docs/sub/b.txt'), index)
      expect(result.fingerprint).toBe(await blobSha('bravo'))
      // The retry asks the index again, so a cleared store refills once.
      expect(gh.counts()).toEqual([0, 1, 0])
    })
  }

  it('asks a genuine miss once', async () => {
    const index = new RAMIndexCacheStore()
    const accessor = await listed(index)
    const gets = vi.spyOn(index, 'get')
    await expect(stat(accessor, spec('docs/sub/nope.txt'), index)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    // A missing key never reaches `get`; the listing answers for it, once.
    const lists = vi.spyOn(index, 'listDir')
    await expect(stat(accessor, spec('docs/sub/nope.txt'), index)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(lists.mock.calls.map(([p]) => p).filter((p) => p === '/gh/docs/sub')).toEqual([
      '/gh/docs/sub',
    ])
    expect(gets).not.toHaveBeenCalled()
    expect(gh.counts()).toEqual([0, 0, 0])
  })

  it('answers absent without an index', async () => {
    // With no store there is nothing a clear could have emptied, and lookup
    // answers at once; python's NULL_INDEX twin counts the single lookup.
    const accessor = await listed()
    await expect(lookupRetrying(accessor, undefined, '/gh', '/gh/docs/sub/b.txt')).resolves.toEqual(
      { entry: null },
    )
    expect(gh.counts()).toEqual([0, 0, 0])
  })
})
