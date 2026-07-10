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

import type { PathSpec } from '../types.ts'
import {
  activeCacheManager,
  invalidateAfterUnlink,
  invalidateAfterWrite,
  runWithCacheManager,
} from './context.ts'

class FakeManager {
  writes: string[] = []
  unlinks: string[] = []

  invalidateAfterWrite(path: string | PathSpec): Promise<void> {
    this.writes.push(path as string)
    return Promise.resolve()
  }

  invalidateAfterUnlink(path: string | PathSpec): Promise<void> {
    this.unlinks.push(path as string)
    return Promise.resolve()
  }

  cachedBytes(_path: PathSpec): Promise<Uint8Array | null> {
    return Promise.resolve(null)
  }
}

describe('cache context', () => {
  it('delegates to the active manager', async () => {
    const manager = new FakeManager()
    await runWithCacheManager(manager, async () => {
      await invalidateAfterWrite('/a.txt')
      await invalidateAfterUnlink('/b.txt')
    })
    expect(manager.writes).toEqual(['/a.txt'])
    expect(manager.unlinks).toEqual(['/b.txt'])
  })

  it('no-ops without an active manager', async () => {
    await invalidateAfterWrite('/a.txt')
    await invalidateAfterUnlink('/b.txt')
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
})
