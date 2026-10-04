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
import { DEL_BATCH, RedisFileCacheStore } from './redis.ts'

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
    await cache.clear()
  })

  afterEach(async () => {
    await cache.clear()
    await cache.close()
  })

  it('prefix eviction preserves nested mount roots and descendants', async () => {
    const value = new TextEncoder().encode('value')
    for (const key of [
      '/data/sub/old',
      '/data/sub/nested',
      '/data/sub/nested/file',
      '/data/sub/nested2',
    ]) {
      await cache.set(key, value)
    }
    await cache.evictPrefix('/data/sub/', ['/data/sub/nested'])
    expect(await cache.get('/data/sub/nested')).toEqual(value)
    expect(await cache.get('/data/sub/nested/file')).toEqual(value)
    expect(await cache.get('/data/sub/old')).toBeNull()
    expect(await cache.get('/data/sub/nested2')).toBeNull()
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

  it.each(['set', 'add'] as const)(
    '%s of an unrelated key survives a prefix eviction while it awaited the client',
    async (method) => {
      // The scoped twin of the case above: the writer is held inside the
      // gated client while evictPrefix runs to completion, so a store-wide
      // retirement would discard it even though nothing under its key went.
      const real = cache.cacheClient.bind(cache)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let held = false
      cache.cacheClient = async (): Promise<RedisClientType> => {
        if (!held) {
          held = true
          await gate
        }
        return real()
      }
      const data = new Uint8Array([1, 2, 3])
      const fill = cache[method]('other', data)
      await cache.evictPrefix('pend')
      release()
      cache.cacheClient = real
      await fill
      expect(await cache.get('other')).toEqual(data)
      await cache.remove('other')
    },
  )

  it.each(['set', 'add'] as const)(
    '%s under an excluded root survives a prefix eviction while it awaited the client',
    async (method) => {
      // The excluded root is a nested mount: its keys are not this drop's,
      // so its in-flight fill must survive the eviction of the folder above.
      const real = cache.cacheClient.bind(cache)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let held = false
      cache.cacheClient = async (): Promise<RedisClientType> => {
        if (!held) {
          held = true
          await gate
        }
        return real()
      }
      const data = new Uint8Array([1, 2, 3])
      const fill = cache[method]('pend/nested/f', data)
      await cache.evictPrefix('pend/', ['pend/nested'])
      release()
      cache.cacheClient = real
      await fill
      expect(await cache.get('pend/nested/f')).toEqual(data)
      await cache.remove('pend/nested/f')
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

// The two prefix-wide drops, each over everything under `/t/`.
const PREFIX_DROPS = [
  ['evictPrefix', (c: RedisFileCacheStore) => c.evictPrefix('/t/')],
  ['clear', (c: RedisFileCacheStore) => c.clear()],
] as const

// Counted on the store's own client, not with `INFO commandstats`: the
// server is shared with every other Redis test running at once. The store
// scans through a type-mapped view of the client, which is a separate
// object, so the view's `scan` is wrapped as well as the client's own.
function spyScan(client: RedisClientType): unknown[][] {
  const calls: unknown[][] = []
  interface Scanner {
    scan: (...args: unknown[]) => Promise<unknown>
  }
  const wrap = (target: Scanner): void => {
    const real = target.scan.bind(target)
    target.scan = (...args: unknown[]) => {
      calls.push(args)
      return real(...args)
    }
  }
  const target = client as unknown as Scanner & {
    withTypeMapping: (mapping: unknown) => Scanner
  }
  wrap(target)
  const realMapping = target.withTypeMapping.bind(client)
  target.withTypeMapping = (mapping: unknown) => {
    const view = realMapping(mapping)
    wrap(view)
    return view
  }
  return calls
}

// Record, per pipeline the client opens, how many keys each DEL names.
function spyPipelines(client: RedisClientType): number[][] {
  const pipelines: number[][] = []
  const target = client as unknown as { multi: () => { del: (keys: string[]) => unknown } }
  const real = target.multi.bind(client)
  target.multi = () => {
    const pipe = real()
    const sizes: number[] = []
    pipelines.push(sizes)
    const realDel = pipe.del.bind(pipe)
    pipe.del = (keys: string[]) => {
      sizes.push(keys.length)
      return realDel(keys)
    }
    return pipe
  }
  return pipelines
}

async function dropMatching(client: RedisClientType, pattern: string): Promise<void> {
  for await (const page of client.scanIterator({ MATCH: pattern, COUNT: 1000 })) {
    const keys = Array.isArray(page) ? page : [page]
    if (keys.length > 0) await client.del(keys)
  }
}

async function keysMatching(client: RedisClientType, pattern: string): Promise<string[]> {
  const out: string[] = []
  for await (const page of client.scanIterator({ MATCH: pattern, COUNT: 1000 })) {
    out.push(...(Array.isArray(page) ? page : [page]))
  }
  return out.sort()
}

describe.skipIf(skip)('RedisFileCacheStore prefix drops', () => {
  const url = REDIS_URL !== undefined ? { url: REDIS_URL } : {}
  let prefix: string
  let cache: RedisFileCacheStore
  const x = new Uint8Array([0x78])

  beforeEach(() => {
    prefix = `mirage:cache:test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`
    cache = new RedisFileCacheStore({ ...url, keyPrefix: prefix })
  })

  afterEach(async () => {
    const c = await cache.cacheClient()
    await dropMatching(c, `${prefix}*`)
    await cache.close()
  })

  it.each(PREFIX_DROPS)('%s scans the server once in large pages', async (_name, drop) => {
    // One pass over data and meta together, at COUNT 1000: about
    // dbsize / 1000 SCAN calls. Two passes double it, and the client
    // default (COUNT 10) makes it about dbsize / 5.
    const c = await cache.cacheClient()
    const seed = c.multi()
    for (let i = 0; i < 5000; i++) seed.set(`${prefix}unrelated:${String(i)}`, 'x')
    await seed.exec()
    await cache.set('/t/a', x, { fingerprint: 'etag' })
    const scans = spyScan(c)
    await drop(cache)
    const pages = Math.ceil((await c.dbSize()) / 1000)
    // At least one: a spy that sees no SCAN would pass the bound below.
    expect(scans.length).toBeGreaterThan(0)
    expect(scans.length).toBeLessThanOrEqual(pages + 2)
    expect(await cache.get('/t/a')).toBeNull()
    expect(await c.exists(`${prefix}meta:/t/a`)).toBe(0)
  })

  it('a drop spanning pages takes data and meta and nothing else', async () => {
    for (let i = 0; i < 2500; i++)
      await cache.set(`/t/sub/${String(i)}`, x, { fingerprint: 'etag' })
    await cache.set('/t/subway', x, { fingerprint: 'etag' })
    await cache.set('/t/sub/nested/kept', x, { fingerprint: 'etag' })
    const c = await cache.cacheClient()
    const pipelines = spyPipelines(c)
    await cache.evictPrefix('/t/sub/', ['/t/sub/nested'])
    // Deleted page by page, each page in DELs of at most DEL_BATCH keys:
    // one DEL of N keys blocks the server for all N at once, and N bodies
    // may each be large. A page goes out as one pipeline, one round trip.
    const sizes = pipelines.flat()
    expect(pipelines.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(DEL_BATCH)
    expect(pipelines.some((pipe) => pipe.length > 1)).toBe(true)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(5000)
    expect(await keysMatching(c, `${prefix}[dm][ae]ta:*`)).toEqual(
      [
        `${prefix}data:/t/sub/nested/kept`,
        `${prefix}data:/t/subway`,
        `${prefix}meta:/t/sub/nested/kept`,
        `${prefix}meta:/t/subway`,
      ].sort(),
    )
  })

  it.each(PREFIX_DROPS)('%s leaves keys that only resemble cache keys', async (_name, drop) => {
    // `[dm][ae]ta:` also matches `mata:` and `deta:`; only `data:` and
    // `meta:` belong to the cache. The VFS store shares the key prefix.
    const c = await cache.cacheClient()
    await c.set(`${prefix}mata:/t/x`, 'x')
    await c.set(`${prefix}file:/t/x`, 'x')
    await cache.set('/t/x', x, { fingerprint: 'etag' })
    await drop(cache)
    expect(await cache.get('/t/x')).toBeNull()
    expect(await c.exists(`${prefix}mata:/t/x`)).toBe(1)
    expect(await c.exists(`${prefix}file:/t/x`)).toBe(1)
  })

  it.each(PREFIX_DROPS)(
    'a key prefix with glob characters matches only itself under %s',
    async (_name, drop) => {
      const globbed = new RedisFileCacheStore({ ...url, keyPrefix: `${prefix}[1]:` })
      const plain = new RedisFileCacheStore({ ...url, keyPrefix: `${prefix}1:` })
      try {
        await globbed.set('/t/x', new TextEncoder().encode('mine'))
        await plain.set('/t/x', new TextEncoder().encode('other'))
        await drop(globbed)
        expect(await globbed.get('/t/x')).toBeNull()
        expect(new TextDecoder().decode((await plain.get('/t/x')) ?? undefined)).toBe('other')
      } finally {
        await globbed.close()
        await plain.close()
      }
    },
  )

  it.each(PREFIX_DROPS)(
    '%s drops keys that are not UTF-8 and skips their lookalikes',
    async (_name, drop) => {
      // A shared server can hold any bytes as a key. A string-decoded name
      // (invalid bytes read as U+FFFD) names a different key, so a binary
      // key under the cache's own `data:` prefix would survive the drop.
      const c = await cache.cacheClient()
      const bad = Buffer.from([0xff, 0xfe])
      const own = Buffer.concat([Buffer.from(`${prefix}data:/t/`), bad])
      const lookalike = Buffer.concat([Buffer.from(`${prefix}mata:/t/`), bad])
      await c.set(own, 'x')
      await c.set(lookalike, 'x')
      try {
        await cache.set('/t/a', x, { fingerprint: 'etag' })
        await drop(cache)
        expect(await cache.get('/t/a')).toBeNull()
        expect(await c.exists(own)).toBe(0)
        expect(await c.exists(lookalike)).toBe(1)
      } finally {
        await c.del([own, lookalike])
      }
    },
  )

  it('an excluded root is compared byte for byte', async () => {
    // Dropping the byte `\xff` would read `/t/ex\xff/y` as `/t/ex/y`, under
    // the excluded root `/t/ex`; the exact bytes put it beside.
    const c = await cache.cacheClient()
    const beside = Buffer.concat([
      Buffer.from(`${prefix}data:/t/ex`),
      Buffer.from([0xff]),
      Buffer.from('/y'),
    ])
    const under = Buffer.concat([Buffer.from(`${prefix}data:/t/ex/`), Buffer.from([0xff])])
    await c.set(beside, 'x')
    await c.set(under, 'x')
    try {
      await cache.evictPrefix('/t/', ['/t/ex'])
      expect(await c.exists(beside)).toBe(0)
      expect(await c.exists(under)).toBe(1)
    } finally {
      await c.del([beside, under])
    }
  })

  it('an excluded root holding U+FFFD is not a stand-in for any byte', async () => {
    // A replacing decode reads the byte `\xff` as U+FFFD, which would put
    // `/t/\xff/x` under an excluded root spelled `/t/\ufffd`.
    const c = await cache.cacheClient()
    const key = Buffer.concat([
      Buffer.from(`${prefix}data:/t/`),
      Buffer.from([0xff]),
      Buffer.from('/x'),
    ])
    await c.set(key, 'x')
    try {
      await cache.evictPrefix('/t/', ['/t/\ufffd'])
      expect(await c.exists(key)).toBe(0)
    } finally {
      await c.del([key])
    }
  })

  it('an excluded root with a non-ASCII name keeps what lies under it', async () => {
    // A nested mount named in UTF-8: its keys only match the root once
    // both sides are compared in the same form.
    await cache.set('/t/café/f', x)
    await cache.set('/t/other', x)
    await cache.evictPrefix('/t/', ['/t/café'])
    expect(await cache.get('/t/café/f')).toEqual(x)
    expect(await cache.get('/t/other')).toBeNull()
  })

  it.each(PREFIX_DROPS)('%s drops under a non-ASCII key prefix', async (_name, drop) => {
    const accented = new RedisFileCacheStore({ ...url, keyPrefix: `${prefix}café:` })
    try {
      await accented.set('/t/a', x)
      await drop(accented)
      expect(await accented.get('/t/a')).toBeNull()
    } finally {
      await accented.close()
    }
  })
})
