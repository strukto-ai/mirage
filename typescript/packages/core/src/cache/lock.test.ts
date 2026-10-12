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

// Behavioral mirror of python/tests/cache/test_lock.py. Python exposes a
// per-key asyncio lock (`_lock_for`); TS exposes a `withLock(key, fn)` runner.
// The guarantees are the same: same key serializes, different keys run
// concurrently, the lock releases on throw, and discard/clear are safe.

import { describe, expect, it } from 'vitest'
import { KeyLock } from './lock.ts'

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('KeyLock', () => {
  it('serializes calls on the same key', async () => {
    const lock = new KeyLock()
    const order: string[] = []
    const first = lock.withLock('/same', async () => {
      order.push('first_start')
      await tick()
      order.push('first_end')
    })
    const second = lock.withLock('/same', async () => {
      order.push('second_start')
      await tick()
      order.push('second_end')
    })
    await Promise.all([first, second])
    expect(order).toEqual(['first_start', 'first_end', 'second_start', 'second_end'])
  })

  it('runs different keys concurrently without blocking', async () => {
    const lock = new KeyLock()
    const order: string[] = []
    const a = lock.withLock('/a', async () => {
      order.push('a_start')
      await tick()
      order.push('a_end')
    })
    const b = lock.withLock('/b', async () => {
      order.push('b_start')
      await tick()
      order.push('b_end')
    })
    await Promise.all([a, b])
    // Both critical sections start before either ends (they interleave).
    expect(order.indexOf('b_start')).toBeLessThan(order.indexOf('a_end'))
    expect(order.indexOf('a_start')).toBeLessThan(order.indexOf('b_end'))
  })

  it('returns the callback result', async () => {
    const lock = new KeyLock()
    expect(await lock.withLock('/k', () => Promise.resolve(42))).toBe(42)
  })

  it('releases the lock when the callback throws', async () => {
    const lock = new KeyLock()
    await expect(lock.withLock('/k', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    )
    // A subsequent call on the same key must still acquire the lock.
    expect(await lock.withLock('/k', () => Promise.resolve('ok'))).toBe('ok')
  })

  it('discard and clear are safe (including a missing key)', async () => {
    const lock = new KeyLock()
    await lock.withLock('/a', () => Promise.resolve(undefined))
    expect(() => {
      lock.discard('/missing')
    }).not.toThrow()
    expect(() => {
      lock.discard('/a')
    }).not.toThrow()
    expect(() => {
      lock.clear()
    }).not.toThrow()
    // Still usable after clear.
    expect(await lock.withLock('/a', () => Promise.resolve('again'))).toBe('again')
  })
})

it('removes cancelled waiters before the holder finishes and preserves FIFO admission', async () => {
  const lock = new KeyLock()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = lock.withLock('session', () => held)
  const abort = new AbortController()
  let entered = false
  const cancelled = lock.withLock(
    'session',
    () => {
      entered = true
      return Promise.resolve()
    },
    abort.signal,
  )
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  abort.abort()
  await rejected
  const queues = (lock as unknown as { queues: Map<string, Set<unknown>> }).queues
  expect(queues.get('session')?.size).toBe(0)
  const order: number[] = []
  const second = lock.withLock('session', () => {
    order.push(2)
    return Promise.resolve()
  })
  const third = lock.withLock('session', () => {
    order.push(3)
    return Promise.resolve()
  })
  expect(order).toEqual([])
  release()
  await Promise.all([first, second, third])
  expect(entered).toBe(false)
  expect(order).toEqual([2, 3])
  expect(queues.size).toBe(0)
})

it('cancels during handoff without stranding the next waiter', async () => {
  const lock = new KeyLock()
  const abort = new AbortController()
  let release!: () => void
  const first = lock.withLock(
    'session',
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const next = lock.withLock(
    'session',
    () => Promise.reject(new Error('must not run')),
    abort.signal,
  )
  const rejected = expect(next).rejects.toMatchObject({ name: 'AbortError' })
  const last = lock.withLock('session', () => Promise.resolve('last'))
  release()
  await Promise.resolve()
  abort.abort()
  await first
  await rejected
  expect(await last).toBe('last')
})
