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

import { CacheManager } from './manager.ts'
import { RAMFileCacheStore } from './file/ram.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  type CacheInvalidator,
  activeCacheManager,
  captureRead,
  publishRead,
  invalidateAfterUnlink,
  invalidateAfterWrite,
  invalidateAncestors,
  invalidateSubtree,
  runWithCacheManager,
  runWithOwnVersion,
  runWithWriteContext,
  writeCondition,
  writesConditioned,
} from './context.ts'
import { MountMode, PathSpec, WritePolicy } from '../types.ts'
import { RAMIndexCacheStore } from './index/ram.ts'
import { captureCommandScope, runInCommandScope } from './index/scope.ts'
import { MountEntry } from '../workspace/mount/mount.ts'
import { BaseVFS } from '../vfs/base.ts'
import type * as asyncContextModule from '../utils/async_context.ts'

const captureState = vi.hoisted(() => ({ enabled: false, value: undefined as unknown }))

// The browser-runtime branch under node's test runner: the real
// FallbackStorage, no task isolation.
vi.mock('../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return {
    ...real,
    asyncContextIsolatesTasks: false,
    createAsyncContext<T>() {
      class TrackedStorage extends real.FallbackStorage<T> {
        override run<R>(store: T, fn: () => R | Promise<R>): R | Promise<R> {
          if (captureState.enabled) captureState.value = store
          return super.run(store, fn)
        }
      }
      return new TrackedStorage()
    },
  }
})

function gate(): [Promise<void>, () => void] {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return [held, release]
}

function fakeManager(log: string[], name: string): CacheInvalidator {
  return {
    listingTrusted: () => false,
    probedStat: () => null,
    invalidateAfterWrite(path) {
      log.push(`${name}:write:${typeof path === 'string' ? path : path.virtual}`)
      return Promise.resolve()
    },
    invalidateAfterUnlink(path) {
      log.push(`${name}:unlink:${typeof path === 'string' ? path : path.virtual}`)
      return Promise.resolve()
    },
    invalidateAncestors(path) {
      log.push(`${name}:ancestors:${path.virtual}`)
      return Promise.resolve()
    },
    invalidateSubtree(path) {
      log.push(`${name}:subtree:${typeof path === 'string' ? path : path.virtual}`)
      return Promise.resolve()
    },
    cachedSize(): Promise<number | null> {
      return Promise.resolve(null)
    },
  }
}

describe('cache invalidation on the fallback storage', () => {
  it('a write invalidates every live manager, and only live ones', async () => {
    // Dropping a live frame's invalidation serves stale bytes later;
    // evicting a mount the write never touched only costs a refetch.
    // So writes broadcast.
    const log: string[] = []
    const managerA = fakeManager(log, 'a')
    const managerB = fakeManager(log, 'b')
    const [hold, release] = gate()
    const long = runWithCacheManager(managerA, async () => {
      await hold
    })
    const short = runWithCacheManager(managerB, async () => {
      await invalidateAfterWrite('/m/x')
      release()
    })
    await Promise.all([long, short])
    expect(log.sort()).toEqual(['a:write:/m/x', 'b:write:/m/x'])
    log.length = 0
    await invalidateAfterWrite('/m/x')
    expect(log).toEqual([])
  })

  it('an unlink and a subtree drop broadcast the same way', async () => {
    const log: string[] = []
    const managerA = fakeManager(log, 'a')
    const managerB = fakeManager(log, 'b')
    const [hold, release] = gate()
    const long = runWithCacheManager(managerA, async () => {
      await hold
    })
    const short = runWithCacheManager(managerB, async () => {
      await invalidateAfterUnlink('/m/x')
      await invalidateSubtree('/m/d')
      await invalidateAncestors(PathSpec.fromStrPath('/m/d/file'))
      release()
    })
    await Promise.all([long, short])
    expect(log.sort()).toEqual([
      'a:ancestors:/m/d/file',
      'a:subtree:/m/d',
      'a:unlink:/m/x',
      'b:ancestors:/m/d/file',
      'b:subtree:/m/d',
      'b:unlink:/m/x',
    ])
  })

  it('the read side abstains while two managers disagree', async () => {
    // A warm hit from another mount's cache is another mount's bytes;
    // a miss just reads the backend. So reads fail toward the cold
    // read while the frames disagree, and answer again once one
    // manager is live — or while every frame agrees (a nested rebind).
    const log: string[] = []
    const managerA = fakeManager(log, 'a')
    const managerB = fakeManager(log, 'b')
    const [hold, release] = gate()
    let besideOther: CacheInvalidator | null = managerB
    let afterOtherSettled: CacheInvalidator | null = null
    const first = runWithCacheManager(managerB, async () => {
      await hold
    })
    const second = runWithCacheManager(managerA, async () => {
      besideOther = activeCacheManager()
      release()
      await first
      afterOtherSettled = activeCacheManager()
      await runWithCacheManager(managerA, () => {
        expect(activeCacheManager()).toBe(managerA)
        return Promise.resolve()
      })
    })
    await second
    expect(besideOther).toBeNull()
    expect(afterOtherSettled).toBe(managerA)
    expect(activeCacheManager()).toBeNull()
  })
})

it.each([false, true])(
  'overlapping same-path fills keep their own tokens, reverse=%s',
  async (reverse) => {
    const caches = [new RAMFileCacheStore(), new RAMFileCacheStore()] as const
    const managers = [
      new CacheManager(caches[0], null, '/s3/', true),
      new CacheManager(caches[1], null, '/s3/', true),
    ] as const
    const path = PathSpec.fromStrPath('/s3/a.txt', 'a.txt')
    const data = [new TextEncoder().encode('first'), new TextEncoder().encode('other')] as const
    const [heldA, releaseA] = gate()
    const [heldB, releaseB] = gate()
    const a = managers[0].fill(path, async () => {
      await heldA
      publishRead(path.virtual, data[0], 'first-token')
      return data[0]
    })
    const b = managers[1].fill(path, async () => {
      await heldB
      publishRead(path.virtual, data[1], 'other-token')
      return data[1]
    })
    // An unscoped backend read has no fill scope to detect as overlap.
    publishRead(path.virtual, new TextEncoder().encode('third'), 'foreign-token')
    if (reverse) {
      releaseB()
      await b
      releaseA()
    } else {
      releaseA()
      await a
      releaseB()
    }
    await Promise.all([a, b])
    expect(await caches[0].isFresh(path.virtual, 'first-token')).toBe(true)
    expect(await caches[1].isFresh(path.virtual, 'other-token')).toBe(true)
  },
)

it('a pending capture owns completed same-path bodies only weakly', async () => {
  const [held, release] = gate()
  captureState.enabled = true
  const pending = captureRead('/m/x', async () => {
    await held
    const data = new Uint8Array([42])
    publishRead('/m/x', data, 'held-token')
    return data
  })
  captureState.enabled = false
  try {
    for (const path of ['/m/x', '/m/other']) {
      for (let n = 0; n < 32; n++) {
        await captureRead(path, () => {
          const body = new Uint8Array(1024)
          publishRead(path, body, 'short-token')
          return Promise.resolve(body)
        })
      }
    }
    const state = captureState.value as Record<string, unknown>
    expect(Object.keys(state).sort()).toEqual(['facts', 'path'])
    expect(state.path).toBe('/m/x')
    expect(state.facts).toBeInstanceOf(WeakMap)
  } finally {
    captureState.value = undefined
    release()
    expect((await pending)[1]).toEqual(['held-token'])
  }
})

describe('a conditional write on the fallback storage', () => {
  class S3Stub extends BaseVFS {
    override readonly name = 's3'
    override readonly cachesReads = true
    override close(): Promise<void> {
      return Promise.resolve()
    }
  }

  async function conditional(): Promise<[MountEntry, PathSpec]> {
    const entry = new MountEntry({
      prefix: '/s3/',
      vfs: new S3Stub(),
      mode: MountMode.WRITE,
      write: WritePolicy.CONDITIONAL,
    })
    const cache = new RAMFileCacheStore()
    await cache.set('/s3/f', new TextEncoder().encode('one'), { fingerprint: 'v1' })
    entry.cacheManager = new CacheManager(cache, new RAMIndexCacheStore({ ttl: 600 }), '/s3/', true)
    const path = PathSpec.fromStrPath('/s3/f', '/f')
    return [entry, path]
  }

  it("agrees with itself across one mount's nested frames", async () => {
    // A command's frame and its dispatcher's are one mount, so the version stays.
    const [entry, path] = await conditional()
    const cond = await runWithWriteContext('/s3/', entry.writeContext(), () =>
      runWithWriteContext('/s3/', entry.writeContext(), () => writeCondition(path, 'put')),
    )
    expect(cond).toEqual({ ifMatch: 'v1' })
  })

  it('keeps an own version every live frame agrees on', async () => {
    const [entry, path] = await conditional()
    const cond = await runWithWriteContext('/s3/', entry.writeContext(), () =>
      runWithOwnVersion(path, 'v2', () =>
        runWithOwnVersion(path, 'v2', () => writeCondition(path, 'put')),
      ),
    )
    expect(cond).toEqual({ ifMatch: 'v2' })
  })

  it('refuses an own version the live frames disagree on', async () => {
    const [entry, path] = await conditional()
    await expect(
      runWithWriteContext('/s3/', entry.writeContext(), () =>
        runWithOwnVersion(path, 'v2', () =>
          runWithOwnVersion(path, 'v3', () => writeCondition(path, 'put')),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
  })

  it.each([
    ['a sibling line nested in it', '/u/', true],
    ['a root line nested in it', '/', true],
    ['a root line around it', '/', false],
  ] as const)(
    'answers each path from the mount that owns it while lines overlap: %s',
    async (_name, plainPrefix, inner) => {
      // An unconditional mount's write is not refused for another mount's line.
      const [entry, path] = await conditional()
      const plain = PathSpec.fromStrPath('/u/g', '/g')
      const both = () => Promise.all([writeCondition(path, 'put'), writeCondition(plain, 'put')])
      const [cond, other] = await (inner
        ? runWithWriteContext('/s3/', entry.writeContext(), () =>
            runWithWriteContext(plainPrefix, null, both),
          )
        : runWithWriteContext(plainPrefix, null, () =>
            runWithWriteContext('/s3/', entry.writeContext(), both),
          ))
      expect([cond, other]).toEqual([{ ifMatch: 'v1' }, null])
    },
  )

  it('refuses a path no live frame owns while they disagree', async () => {
    const [entry] = await conditional()
    const stray = PathSpec.fromStrPath('/x/h', '/h')
    await expect(
      runWithWriteContext('/s3/', entry.writeContext(), () =>
        runWithWriteContext('/u/', null, () => writeCondition(stray, 'put')),
      ),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
  })

  it('answers whether a path writes conditioned while lines overlap, never throwing', async () => {
    // A read hands its token on when the owner is unclear: true is the safe side.
    const [entry, path] = await conditional()
    const paths = [path, PathSpec.fromStrPath('/u/g', '/g'), PathSpec.fromStrPath('/x/h', '/h')]
    const got = await runWithWriteContext('/s3/', entry.writeContext(), () =>
      runWithWriteContext('/u/', null, () => Promise.resolve(paths.map(writesConditioned))),
    )
    expect(got).toEqual([true, false, true])
  })

  it.each([
    ['a plain mount nested under it', '/s3/u/', [true, false]],
    ['a plain frame on its own prefix', '/s3/', [true, true]],
  ] as const)(
    'answers the longest owning prefix, true while its frames disagree: %s',
    async (_name, plainPrefix, want) => {
      const [entry, path] = await conditional()
      const paths = [path, PathSpec.fromStrPath('/s3/u/g', '/u/g')]
      const got = await runWithWriteContext('/s3/', entry.writeContext(), () =>
        runWithWriteContext(plainPrefix, null, () => Promise.resolve(paths.map(writesConditioned))),
      )
      expect(got).toEqual(want)
    },
  )

  it("leaves another path's own version alone", async () => {
    const [entry, path] = await conditional()
    const other = PathSpec.fromStrPath('/s3/o', '/o')
    const cond = await runWithWriteContext('/s3/', entry.writeContext(), () =>
      runWithOwnVersion(other, 'v9', () => writeCondition(path, 'put')),
    )
    expect(cond).toEqual({ ifMatch: 'v1' })
  })
})

describe('listedThisCommand on the fallback storage', () => {
  // Without task isolation the latest live stamp may be another command's,
  // so a listing counts as the caller's own only while one command is live.
  it('counts no listing while another command is live', async () => {
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
    const [listed, markListed] = gate()
    const [checked, markChecked] = gate()
    let mine: boolean | null = null
    const a = runInCommandScope(async () => {
      await listed
      mine = manager.listedThisCommand('/data')
      markChecked()
    })
    const b = runInCommandScope(async () => {
      await manager.scopeIndex(index).setDir('/data', [])
      markListed()
      await checked
    })
    await Promise.all([a, b])
    expect(mine).toBe(false)
  })

  // A command's lazy output drains through a replay of its own scope, which
  // stacks a second frame with the same stamp.
  it.each([false, true])(
    'counts a listing the only live command fetched (replayed: %s)',
    async (replayed) => {
      const index = new RAMIndexCacheStore({ ttl: 600 })
      const manager = new CacheManager(new RAMFileCacheStore(), index, '/data/', true)
      await runInCommandScope(async () => {
        await manager.scopeIndex(index).setDir('/data', [])
        const check = (): boolean => manager.listedThisCommand('/data')
        const mine = replayed
          ? await captureCommandScope()(() => Promise.resolve(check()))
          : check()
        expect(mine).toBe(true)
      })
    },
  )
})
