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

import { describe, expect, it, vi } from 'vitest'
import {
  type CacheInvalidator,
  activeCacheManager,
  invalidateAfterUnlink,
  invalidateAfterWrite,
  invalidateSubtree,
  runWithCacheManager,
} from './context.ts'
import type * as asyncContextModule from '../utils/async_context.ts'

// The browser-runtime branch under node's test runner: the real
// FallbackStorage, no task isolation.
vi.mock('../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return {
    ...real,
    asyncContextIsolatesTasks: false,
    createAsyncContext<T>() {
      return new real.FallbackStorage<T>()
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
    invalidateAfterWrite(path) {
      log.push(`${name}:write:${typeof path === 'string' ? path : path.virtual}`)
      return Promise.resolve()
    },
    invalidateAfterUnlink(path) {
      log.push(`${name}:unlink:${typeof path === 'string' ? path : path.virtual}`)
      return Promise.resolve()
    },
    invalidateSubtree(path) {
      log.push(`${name}:subtree:${typeof path === 'string' ? path : path.virtual}`)
      return Promise.resolve()
    },
    cachedBytes() {
      return Promise.resolve(null)
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
      release()
    })
    await Promise.all([long, short])
    expect(log.sort()).toEqual([
      'a:subtree:/m/d',
      'a:unlink:/m/x',
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
