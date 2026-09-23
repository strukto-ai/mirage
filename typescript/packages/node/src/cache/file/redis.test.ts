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

import { applyIo } from '@struktoai/mirage-core/cache/file/io'
import { CachableAsyncIterator } from '@struktoai/mirage-core/io/cachable_iterator'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { OpRecord } from '@struktoai/mirage-core/observe/record'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RedisClientType } from 'redis'
import { RedisFileCacheStore } from './redis.ts'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

describe('RedisFileCacheStore configuration', () => {
  it('rejects maxDrainBytes above cacheLimit', () => {
    expect(() => new RedisFileCacheStore({ cacheLimit: 1024, maxDrainBytes: 1025 })).toThrow(
      'maxDrainBytes cannot exceed cacheLimit',
    )
  })
})

describe.skipIf(skip)('RedisFileCacheStore', () => {
  let cache: RedisFileCacheStore
  const prefix = `mirage:cache:test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`

  beforeEach(async () => {
    cache = new RedisFileCacheStore(
      REDIS_URL !== undefined ? { url: REDIS_URL, keyPrefix: prefix } : { keyPrefix: prefix },
    )
    await cache.open()
    await cache.clear()
  })

  afterEach(async () => {
    await cache.clear()
    await cache.close()
  })

  it.each(['set', 'add'] as const)(
    '%s discards a fill invalidated while it awaited the client',
    async (method) => {
      // This store's window is its own: `set` and `add` both
      // `await this.cacheClient()` between `invalidation.enter` and the
      // `stale` check. core's ram.test.ts covers the lock path, a
      // different suspension point, so neither stands in for the other.
      // (Python's redis store has no await there at all -- see the note in
      // tests/cache/file/test_redis_cache.py -- so this case is one-host.)
      //
      // The client is gated rather than merely raced: letting the
      // invalidation run to completion while the writer is held is what
      // separates "the guard discarded the fill" from "the fill landed and
      // the invalidation deleted it afterwards". Both end with the key
      // absent, so a racy version of this test passes with the guard
      // removed -- measured, not assumed.
      for (const invalidate of [
        () => cache.clear(),
        () => cache.remove('pending'),
        () => cache.evictPrefix('pend'),
      ]) {
        const real = cache.cacheClient.bind(cache)
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        // One-shot: only the writer is held. `clear`, `remove` and
        // `evictPrefix` reach for the same client, so a gate that held
        // every call would deadlock the invalidation instead of ordering
        // it.
        let held = false
        cache.cacheClient = async (): Promise<RedisClientType> => {
          if (!held) {
            held = true
            await gate
          }
          return real()
        }
        // Held across the whole invalidation: the writer has taken its
        // stamp and is parked inside the gated client, so `invalidate()`
        // runs to completion before the writer ever reaches its stale
        // check. Releasing first is what makes this racy and vacuous.
        const fill = cache[method]('pending', new Uint8Array([1, 2, 3]))
        await invalidate()
        release()
        cache.cacheClient = real
        await fill
        expect(await cache.get('pending')).toBeNull()
        await cache.remove('pending')
      }
    },
  )

  it('a tokenless add still bounds its data key', async () => {
    // add.lua nests the meta EXPIRE inside the data EXPIRE, so a mistake
    // in that nesting takes the data key's bound with it. This is the
    // combination the background drain now reaches: it calls `add` with
    // whatever latestFingerprint returned -- which may be null -- and the
    // mount's bound. An immortal tokenless entry is the one thing
    // `bounded` can never expire.
    expect(await cache.add('a', new Uint8Array([1]), { ttl: 100 })).toBe(true)
    const c = await cache.cacheClient()
    expect(await c.ttl(`${prefix}data:a`)).toBeGreaterThan(0)
    expect(await c.exists(`${prefix}meta:a`)).toBe(0)
  })

  it('a losing tokenless add leaves the incumbent token alone', async () => {
    // The early return has to happen before the meta delete. A drain that
    // finishes late correctly declines to overwrite a newer fill; if it
    // still dropped that fill's token on the way out, the survivor would
    // be unverifiable and a `fresh` mount would refetch it on every read.
    await cache.set('a', new Uint8Array([2]), { fingerprint: 'etag-new' })
    expect(await cache.add('a', new Uint8Array([3]))).toBe(false)
    expect(await cache.get('a')).toEqual(new Uint8Array([2]))
    expect(await cache.isFresh('a', 'etag-new')).toBe(true)
  })

  it('a token-bearing set bounds its meta key too', async () => {
    // The other side of the branch the tokenless case added: when there
    // IS a token the meta key still has to take the ttl. Leaving it
    // immortal lets it outlive the data key redis expires, and the next
    // isFresh then matches a token describing bytes that are gone -- the
    // same false positive the tokenless delete exists to prevent, one
    // branch over.
    await cache.set('a', new Uint8Array([1]), { fingerprint: 'etag-1', ttl: 100 })
    const c = await cache.cacheClient()
    expect(await c.ttl(`${prefix}meta:a`)).toBeGreaterThan(0)
    expect(await c.ttl(`${prefix}data:a`)).toBeGreaterThan(0)
  })

  it('a fill with no token writes no meta key', async () => {
    await cache.set('a', new Uint8Array([1]))
    const c = await cache.cacheClient()
    expect(await cache.get('a')).toEqual(new Uint8Array([1]))
    expect(await c.exists(`${prefix}meta:a`)).toBe(0)
    expect(await cache.isFresh('a', 'etag-1')).toBe(false)
  })

  it('a tokenless set deletes a stale meta key', async () => {
    // Redis expires and evicts the data and meta keys independently, so a
    // meta key can outlive the bytes it described. Leaving it would let
    // isFresh match the old token against the new bytes and serve them.
    await cache.set('a', new Uint8Array([1]), { fingerprint: 'etag-old' })
    expect(await cache.isFresh('a', 'etag-old')).toBe(true)
    await cache.set('a', new Uint8Array([2]))
    const c = await cache.cacheClient()
    expect(await cache.get('a')).toEqual(new Uint8Array([2]))
    // Asserted on the key itself: "deleted" and "overwritten with
    // something that happens not to match" are the same isFresh answer,
    // and only the first is what this branch claims to do.
    expect(await c.exists(`${prefix}meta:a`)).toBe(0)
    expect(await cache.isFresh('a', 'etag-old')).toBe(false)
  })

  it('a tokenless add deletes a meta key that outlived its data', async () => {
    // add.lua only checks the data key, so a meta key that survived its
    // data key is invisible to the insert-only guard and must be dropped.
    await cache.set('a', new Uint8Array([1]), { fingerprint: 'etag-old' })
    const c = await cache.cacheClient()
    await c.del(`${prefix}data:a`)
    expect(await c.exists(`${prefix}meta:a`)).toBe(1)
    expect(await cache.add('a', new Uint8Array([2]))).toBe(true)
    expect(await cache.get('a')).toEqual(new Uint8Array([2]))
    expect(await c.exists(`${prefix}meta:a`)).toBe(0)
    expect(await cache.isFresh('a', 'etag-old')).toBe(false)
  })

  it('treats an empty token as absent', async () => {
    await cache.set('a', new Uint8Array([1]), { fingerprint: '' })
    expect(await cache.isFresh('a', '')).toBe(false)
  })

  it('set + get round-trips binary data', async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x10])
    await cache.set('key1', bytes)
    const got = await cache.get('key1')
    expect(got).toEqual(bytes)
  })

  it('returns null for missing key', async () => {
    expect(await cache.get('nope')).toBeNull()
  })

  // Redis answers isUnbounded as a ttl probe, so the two sentinels are
  // the whole behaviour: -1 is present with no expiry, -2 is absent.
  // Reading one as the other makes every warm bounded read either drop
  // and refetch its entry forever, or never self-heal a bound-less one.
  // The RAM store's twin cannot catch it -- only redis encodes it this way.
  it('isUnbounded distinguishes absent from boundless', async () => {
    const data = new Uint8Array([1])
    expect(await cache.isUnbounded('absent')).toBe(false)
    await cache.set('no-bound', data)
    expect(await cache.isUnbounded('no-bound')).toBe(true)
    await cache.set('bounded', data, { ttl: 30 })
    expect(await cache.isUnbounded('bounded')).toBe(false)
  })

  it('a bound set on redis actually expires the key', async () => {
    // The stamp has to reach redis itself, not just the client's view: a
    // `set` that dropped the ttl would leave isUnbounded answering off a
    // key redis never expires.
    await cache.set('bounded2', new Uint8Array([1]), { ttl: 30 })
    const c = await (
      cache as unknown as { cacheClient(): Promise<{ ttl(k: string): Promise<number> }> }
    ).cacheClient()
    const key = (cache as unknown as { dataKey(k: string): string }).dataKey('bounded2')
    const remaining = await c.ttl(key)
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(30)
  })

  it('add returns false if key exists, true otherwise', async () => {
    const data = new Uint8Array([1, 2, 3])
    expect(await cache.add('k', data)).toBe(true)
    expect(await cache.add('k', data)).toBe(false)
  })

  it('gives concurrent add calls exactly one winner', async () => {
    const contenders = Array.from({ length: 32 }, (_, i) => ({
      data: new TextEncoder().encode(`value-${String(i)}`),
      fingerprint: `fingerprint-${String(i)}`,
    }))
    const inserted = await Promise.all(
      contenders.map(({ data, fingerprint }) => cache.add('shared', data, { fingerprint })),
    )

    expect(inserted.filter(Boolean)).toHaveLength(1)
    const winner = contenders.find((_value, index) => inserted[index])
    if (winner === undefined) throw new Error('expected one add call to win')
    expect(await cache.get('shared')).toEqual(winner.data)
    expect(await cache.isFresh('shared', winner.fingerprint)).toBe(true)
  })

  it('preserves binary data and applies ttl to data and metadata on add', async () => {
    const data = new Uint8Array([0x00, 0xff, 0x80, 0x42])
    expect(await cache.add('binary', data, { fingerprint: 'binary-fp', ttl: 1 })).toBe(true)
    expect(await cache.get('binary')).toEqual(data)
    expect(await cache.isFresh('binary', 'binary-fp')).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(await cache.get('binary')).toBeNull()
    expect(await cache.isFresh('binary', 'binary-fp')).toBe(false)
  })

  it('remove deletes data and meta', async () => {
    await cache.set('k', new Uint8Array([9]))
    expect(await cache.exists('k')).toBe(true)
    await cache.remove('k')
    expect(await cache.exists('k')).toBe(false)
    expect(await cache.get('k')).toBeNull()
  })

  it('multiGet returns [bytes|null] in order', async () => {
    await cache.set('a', new Uint8Array([1]))
    await cache.set('c', new Uint8Array([3]))
    const out = await cache.multiGet(['a', 'b', 'c'])
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual(new Uint8Array([1]))
    expect(out[1]).toBeNull()
    expect(out[2]).toEqual(new Uint8Array([3]))
  })

  it('isFresh matches fingerprint', async () => {
    const data = new Uint8Array([1, 1, 1])
    const fp = 'etag-1-1-1'
    await cache.set('k', data, { fingerprint: fp })
    expect(await cache.isFresh('k', fp)).toBe(true)
    expect(await cache.isFresh('k', 'other')).toBe(false)
  })

  it('ttl expires entries', async () => {
    await cache.set('k', new Uint8Array([1]), { ttl: 1 })
    expect(await cache.get('k')).not.toBeNull()
    await new Promise((r) => setTimeout(r, 1100))
    expect(await cache.get('k')).toBeNull()
  })

  it('clear removes everything under the prefix', async () => {
    await cache.set('a', new Uint8Array([1]))
    await cache.set('b', new Uint8Array([2]))
    await cache.clear()
    expect(await cache.exists('a')).toBe(false)
    expect(await cache.exists('b')).toBe(false)
  })

  it('background-drains an unexhausted stream, carrying the record fingerprint', async () => {
    async function* gen(): AsyncGenerator<Uint8Array> {
      await Promise.resolve()
      yield new TextEncoder().encode('drained')
    }
    const stream = new CachableAsyncIterator(gen())
    const io = new IOResult({ reads: { '/file.txt': stream }, cache: ['/file.txt'] })
    const records = [
      new OpRecord({
        op: 'read',
        path: '/file.txt',
        source: 's3',
        bytes: 0,
        timestamp: 0,
        durationMs: 0,
        fingerprint: 'etag-9',
      }),
    ]
    await applyIo(cache, io, undefined, records)
    expect(cache.drainTasks.has('/file.txt')).toBe(true)
    await Promise.all([...cache.drainTasks.values()])
    expect(new TextDecoder().decode((await cache.get('/file.txt')) ?? undefined)).toBe('drained')
    expect(await cache.isFresh('/file.txt', 'etag-9')).toBe(true)
  })

  it('remove aborts a pending drain fill', async () => {
    let started!: () => void
    const gate = new Promise<void>((r) => {
      started = r
    })
    async function* gen(): AsyncGenerator<Uint8Array> {
      started()
      await new Promise((r) => setTimeout(r, 200))
      yield new TextEncoder().encode('slow')
    }
    const stream = new CachableAsyncIterator(gen())
    const io = new IOResult({ reads: { '/slow.txt': stream }, cache: ['/slow.txt'] })
    await applyIo(cache, io)
    const task = cache.drainTasks.get('/slow.txt')
    expect(task).toBeDefined()
    await gate
    await cache.remove('/slow.txt')
    expect(cache.drainTasks.has('/slow.txt')).toBe(false)
    await task
    expect(await cache.get('/slow.txt')).toBeNull()
  })
})
