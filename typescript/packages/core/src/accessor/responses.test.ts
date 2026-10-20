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
import { ReadPolicy } from '../types.ts'
import { ResponseCache } from './responses.ts'

function service(): () => Promise<number> {
  let asked = 0
  return () => Promise.resolve(++asked)
}

describe('ResponseCache', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps an ungoverned answer until cleared', async () => {
    const answer = service()
    const cache = new ResponseCache<string, number>()
    expect(await cache.get('q', answer)).toBe(1)
    expect(await cache.get('q', answer)).toBe(1)
    cache.clear()
    expect(await cache.get('q', answer)).toBe(2)
  })

  it('keeps nothing on a fresh mount', async () => {
    const answer = service()
    const cache = new ResponseCache<string, number>()
    cache.govern({ policy: ReadPolicy.FRESH, ttl: 600 })
    expect(await cache.get('q', answer)).toBe(1)
    expect(await cache.get('q', answer)).toBe(2)
  })

  it("keeps an answer within a bounded mount's bound", async () => {
    vi.useFakeTimers({ now: 100_000 })
    const answer = service()
    const cache = new ResponseCache<string, number>()
    cache.govern({ policy: ReadPolicy.BOUNDED, ttl: 30 })
    expect(await cache.get('q', answer)).toBe(1)
    vi.setSystemTime(129_000)
    expect(await cache.get('q', answer)).toBe(1)
    vi.setSystemTime(130_000)
    expect(await cache.get('q', answer)).toBe(2)
  })

  it('keeps the strictest bound', async () => {
    // The client's own bound when it is shorter, and the shorter of two
    // mounts' bounds for a client mounted twice.
    vi.useFakeTimers({ now: 0 })
    const answer = service()
    const cache = new ResponseCache<string, number>(5)
    cache.govern({ policy: ReadPolicy.BOUNDED, ttl: 600 })
    cache.govern({ policy: ReadPolicy.BOUNDED, ttl: 60 })
    expect(await cache.get('q', answer)).toBe(1)
    vi.setSystemTime(5_000)
    expect(await cache.get('q', answer)).toBe(2)
  })

  it('drops what it kept when a stricter mount governs it', async () => {
    // Kept under a 600 s bound, an answer would outlive a 30 s one.
    const answer = service()
    const cache = new ResponseCache<string, number>()
    cache.govern({ policy: ReadPolicy.BOUNDED, ttl: 600 })
    expect(await cache.get('q', answer)).toBe(1)
    cache.govern({ policy: ReadPolicy.BOUNDED, ttl: 30 })
    expect(await cache.get('q', answer)).toBe(2)
  })

  it('does not keep an answer that raced a clear', async () => {
    // The clear may be for the very write the answer predates.
    const cache = new ResponseCache<string, string>()
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const asking = cache.get('q', async () => {
      await held
      return 'before'
    })
    cache.clear()
    release()
    expect(await asking).toBe('before')
    expect(await cache.get('q', () => Promise.resolve('after'))).toBe('after')
  })
})
