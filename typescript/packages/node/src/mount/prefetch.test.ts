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
import { PREFETCH_TTL_MS, PrefetchCache } from './prefetch.ts'

const HELLO = new TextEncoder().encode('hello')

describe('PrefetchCache', () => {
  it('reads back a stored entry', () => {
    const cache = new PrefetchCache()
    cache.put('/a.txt', HELLO)

    expect(cache.get('/a.txt')).toEqual(HELLO)
  })

  it('answers null for an unknown path', () => {
    expect(new PrefetchCache().get('/nope')).toBeNull()
  })

  it('drops an expired entry rather than returning it', () => {
    // A zero TTL expires the moment it is stored, which is what the
    // release-then-stat window looks like once it has closed.
    const cache = new PrefetchCache(0)
    cache.put('/a.txt', HELLO)

    expect(cache.get('/a.txt')).toBeNull()
    expect(cache.get('/a.txt')).toBeNull()
  })

  it('forgets named paths and tolerates unknown ones', () => {
    const cache = new PrefetchCache()
    cache.put('/a.txt', HELLO)
    cache.put('/b.txt', HELLO)

    cache.invalidate('/a.txt', '/never-stored')

    expect(cache.get('/a.txt')).toBeNull()
    expect(cache.get('/b.txt')).toEqual(HELLO)
  })

  it('forgets everything on clear', () => {
    const cache = new PrefetchCache()
    cache.put('/a.txt', HELLO)
    cache.clear()

    expect(cache.get('/a.txt')).toBeNull()
  })

  it('joins a second claim to the first fetch', async () => {
    // The asymmetry with python: a TS mount is served by one event loop
    // and two opens of a path can interleave, so the second must not
    // start a second fetch. Both claims are made before either awaits,
    // which is exactly the interleaving a mount produces.
    const cache = new PrefetchCache()
    let fills = 0
    const fill = async (): Promise<Uint8Array> => {
      fills += 1
      await Promise.resolve()
      return HELLO
    }

    const first = cache.claim('/a.txt', fill)
    const second = cache.claim('/a.txt', fill)

    expect(await first).toEqual(HELLO)
    expect(await second).toEqual(HELLO)
    expect(fills).toBe(1)
  })

  it('caches a claim that succeeded and retries one that did not', async () => {
    const cache = new PrefetchCache()
    let fills = 0

    expect(
      await cache.claim('/a.txt', () => {
        fills += 1
        return Promise.resolve(null)
      }),
    ).toBeNull()
    expect(cache.get('/a.txt')).toBeNull()

    await cache.claim('/a.txt', () => {
      fills += 1
      return Promise.resolve(HELLO)
    })

    expect(cache.get('/a.txt')).toEqual(HELLO)
    expect(fills).toBe(2)
  })

  it('uses the same window as the python twin', () => {
    // The number is a contract across the two languages, not an
    // implementation detail: a mount must not answer differently
    // depending on which one served it.
    expect(PREFETCH_TTL_MS).toBe(30_000)
  })
})
