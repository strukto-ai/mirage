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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { CachableAsyncIterator } from '../../io/cachable_iterator.ts'
import { IOResult, type ByteSource } from '../../io/types.ts'
import { OpRecord } from '../../observe/record.ts'
import type { CacheFacts, PathSpec } from '../../types.ts'
import { applyIo, latestFingerprint, writtenVerdict } from './io.ts'
import { RAMFileCacheStore } from './ram.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeStream(data: string): CachableAsyncIterator {
  async function* gen(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    yield ENC.encode(data)
  }
  return new CachableAsyncIterator(gen())
}

function makeChunkedStream(chunks: Uint8Array[]): CachableAsyncIterator {
  async function* gen(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    for (const c of chunks) yield c
  }
  return new CachableAsyncIterator(gen())
}

describe('cache population via applyIo', () => {
  it('caches reads', async () => {
    const cache = new RAMFileCacheStore()
    const io = new IOResult({
      reads: { '/data/file.txt': ENC.encode('hello') },
      cache: ['/data/file.txt'],
    })
    await applyIo(cache, io)
    expect(DEC.decode((await cache.get('/data/file.txt')) ?? undefined)).toBe('hello')
  })

  it('caches writes', async () => {
    const cache = new RAMFileCacheStore()
    const io = new IOResult({
      writes: { '/data/out.txt': ENC.encode('output') },
      cache: ['/data/out.txt'],
    })
    await applyIo(cache, io)
    expect(DEC.decode((await cache.get('/data/out.txt')) ?? undefined)).toBe('output')
  })

  it('drops a path read and written', async () => {
    // `cat f; printf z >> f` reads f before appending to it: neither side
    // is the file, so the entry the line started with goes too. Mirrors
    // Python's test_apply_io_drops_a_path_read_and_written.
    const cache = new RAMFileCacheStore()
    await cache.set('/f.txt', ENC.encode('stale'))
    const io = new IOResult({
      reads: { '/f.txt': ENC.encode('read-data') },
      writes: { '/f.txt': ENC.encode('z') },
      cache: ['/f.txt'],
    })
    await applyIo(cache, io)
    expect(await cache.get('/f.txt')).toBeNull()
  })

  it.each([
    [{}, 'abc'],
    [{ '/f': ENC.encode('z') }, null],
  ])('leaves a read to its live drain (writes %j)', async (writes, cached) => {
    // The outer line of an `eval` gets the read its inner line drains; a write
    // there drops the drain, and the read is closed instead. Mirrors Python's
    // test_apply_io_leaves_a_read_to_its_live_drain.
    async function* source(): AsyncGenerator<Uint8Array> {
      for (const chunk of ['a', 'b', 'c']) {
        await sleep(1)
        yield ENC.encode(chunk)
      }
    }
    const cache = new RAMFileCacheStore()
    const stream = new CachableAsyncIterator(source())
    expect(DEC.decode((await stream.next()).value as Uint8Array)).toBe('a')
    await applyIo(cache, new IOResult({ reads: { '/f': stream }, cache: ['/f'] }))
    await applyIo(cache, new IOResult({ reads: { '/f': stream }, writes, cache: ['/f'] }))
    await Promise.all([...cache.drainTasks.values()])
    const entry = await cache.get('/f')
    expect([entry === null ? null : DEC.decode(entry), stream.exhausted]).toEqual([cached, true])
  })

  it('stores all paths in the cache list', async () => {
    const cache = new RAMFileCacheStore()
    const io = new IOResult({
      reads: { '/a.txt': ENC.encode('aaa'), '/b.txt': ENC.encode('bbb') },
      cache: ['/a.txt', '/b.txt'],
    })
    await applyIo(cache, io)
    expect(DEC.decode((await cache.get('/a.txt')) ?? undefined)).toBe('aaa')
    expect(DEC.decode((await cache.get('/b.txt')) ?? undefined)).toBe('bbb')
  })
})

function opRecord(
  op: string,
  path: string,
  fingerprint: string | null,
  nbytes = 0,
  claimed: ByteSource | null = null,
): OpRecord {
  return new OpRecord({
    op,
    path,
    source: 's3',
    bytes: nbytes,
    timestamp: 0,
    durationMs: 0,
    fingerprint,
    claimed,
  })
}

function readRecord(path: string, fingerprint: string | null): OpRecord {
  return opRecord('read', path, fingerprint)
}

class CountingCache extends RAMFileCacheStore {
  gets = 0
  existsCalls = 0

  override async get(key: string): Promise<Uint8Array | null> {
    this.gets += 1
    return await super.get(key)
  }

  override async exists(key: string | PathSpec): Promise<boolean> {
    this.existsCalls += 1
    return await super.exists(key)
  }
}

describe('backend fingerprint threading', () => {
  it('stamps the cache entry with the record fingerprint', async () => {
    const cache = new RAMFileCacheStore()
    const io = new IOResult({
      reads: { '/s3/f.txt': ENC.encode('hello') },
      cache: ['/s3/f.txt'],
    })
    await applyIo(cache, io, undefined, [readRecord('/s3/f.txt', 'etag-multipart-2')])
    expect(DEC.decode((await cache.get('/s3/f.txt')) ?? undefined)).toBe('hello')
    expect(await cache.isFresh('/s3/f.txt', 'etag-multipart-2')).toBe(true)
  })

  it('leaves bytes from an unvouched later read untokened', async () => {
    // One line read the path twice and the backend vouched only for the first:
    // the bytes stored are the second read's, so the first read's token would
    // label bytes it never described.
    const cache = new RAMFileCacheStore()
    const io = new IOResult({ reads: { '/m/f.txt': ENC.encode('new') }, cache: ['/m/f.txt'] })
    await applyIo(cache, io, undefined, [
      readRecord('/m/f.txt', 'token-a'),
      readRecord('/m/f.txt', null),
    ])
    expect(await cache.exists('/m/f.txt')).toBe(true)
    expect(await cache.isFresh('/m/f.txt', 'token-a')).toBe(false)
  })

  it('uses the record fingerprint for an exhausted stream', async () => {
    const cache = new RAMFileCacheStore()
    const stream = makeStream('hello')
    expect(DEC.decode(await stream.drain())).toBe('hello')
    const io = new IOResult({ reads: { '/s3/f.txt': stream }, cache: ['/s3/f.txt'] })
    await applyIo(cache, io, undefined, [readRecord('/s3/f.txt', 'etag-multipart-2')])
    expect(await cache.isFresh('/s3/f.txt', 'etag-multipart-2')).toBe(true)
  })

  it('preserves the entry fingerprint on a warm re-apply', async () => {
    const cache = new RAMFileCacheStore()
    const cold = new IOResult({
      reads: { '/s3/f.txt': ENC.encode('hello') },
      cache: ['/s3/f.txt'],
    })
    await applyIo(cache, cold, undefined, [readRecord('/s3/f.txt', 'etag-3')])
    const warm = new IOResult({
      reads: { '/s3/f.txt': ENC.encode('hello') },
      cache: ['/s3/f.txt'],
    })
    await applyIo(cache, warm, undefined, [])
    expect(await cache.isFresh('/s3/f.txt', 'etag-3')).toBe(true)
  })

  it('replaces the entry when data changed without a record', async () => {
    const cache = new RAMFileCacheStore()
    const cold = new IOResult({
      reads: { '/s3/f.txt': ENC.encode('old') },
      cache: ['/s3/f.txt'],
    })
    await applyIo(cache, cold, undefined, [readRecord('/s3/f.txt', 'etag-3')])
    const fresh = new IOResult({
      writes: { '/s3/f.txt': ENC.encode('new') },
      cache: ['/s3/f.txt'],
    })
    await applyIo(cache, fresh, undefined, [])
    expect(DEC.decode((await cache.get('/s3/f.txt')) ?? undefined)).toBe('new')
    expect(await cache.isFresh('/s3/f.txt', 'etag-3')).toBe(false)
  })

  it('picks up a fingerprint recorded during the background drain', async () => {
    const cache = new RAMFileCacheStore()
    const records: OpRecord[] = []
    async function* gen(): AsyncGenerator<Uint8Array> {
      await Promise.resolve()
      records.push(readRecord('/s3/f.txt', 'etag-multipart-2'))
      yield ENC.encode('hello')
    }
    const stream = new CachableAsyncIterator(gen())
    const io = new IOResult({ reads: { '/s3/f.txt': stream }, cache: ['/s3/f.txt'] })
    await applyIo(cache, io, undefined, records)
    await sleep(50)
    expect(DEC.decode((await cache.get('/s3/f.txt')) ?? undefined)).toBe('hello')
    expect(await cache.isFresh('/s3/f.txt', 'etag-multipart-2')).toBe(true)
  })

  it('does not refetch the blob on a warm re-apply', async () => {
    // A warm re-apply asks whether the entry exists, never for its bytes.
    // The read-through already served them out of that entry, so fetching
    // the blob back to compare it with itself was the whole cost of #1009
    // -- on a Redis cache, the file over the wire twice.
    const cache = new CountingCache()
    const cold = new IOResult({
      reads: { '/s3/f.txt': ENC.encode('hello') },
      cache: ['/s3/f.txt'],
    })
    await applyIo(cache, cold, undefined, [readRecord('/s3/f.txt', 'etag-3')])
    cache.gets = 0
    cache.existsCalls = 0
    const warm = new IOResult({
      reads: { '/s3/f.txt': ENC.encode('hello') },
      cache: ['/s3/f.txt'],
    })
    await applyIo(cache, warm, undefined, [])
    expect(cache.gets).toBe(0)
    expect(cache.existsCalls).toBe(1)
    expect(await cache.isFresh('/s3/f.txt', 'etag-3')).toBe(true)
  })

  it('replaces a live entry of the same bytes on a write without a token', async () => {
    // A write always writes: the guard's existence check is gated on
    // the read direction, so a backend that stamps no write token cannot
    // skip the set and leave a pre-write entry standing. The bytes are
    // identical here, so only the fingerprint can show it happened -- and
    // the direction short-circuits before the cache is asked anything, so
    // the write path costs no lookup at all.
    const cache = new CountingCache()
    const cold = new IOResult({
      reads: { '/s3/f.txt': ENC.encode('hello') },
      cache: ['/s3/f.txt'],
    })
    await applyIo(cache, cold, undefined, [readRecord('/s3/f.txt', 'etag-3')])
    cache.gets = 0
    cache.existsCalls = 0
    const rewrite = new IOResult({
      writes: { '/s3/f.txt': ENC.encode('hello') },
      cache: ['/s3/f.txt'],
    })
    await applyIo(cache, rewrite, undefined, [])
    expect(cache.gets).toBe(0)
    expect(cache.existsCalls).toBe(0)
    expect(DEC.decode((await cache.get('/s3/f.txt')) ?? undefined)).toBe('hello')
    expect(await cache.isFresh('/s3/f.txt', 'etag-3')).toBe(false)
  })

  it('keeps the entry it found on a tokenless read', async () => {
    // The one case the existence check answers differently from the byte
    // compare it replaces: a read that reached the backend while an entry
    // stood, with no token to stamp. Only `cp`'s guarded primitive walk
    // reads that way, and `bounded` already calls the entry it kept trusted,
    // so preserving it is the policy's answer rather than an accidental
    // repair.
    const cache = new RAMFileCacheStore()
    const cold = new IOResult({
      reads: { '/s3/f.txt': ENC.encode('old') },
      cache: ['/s3/f.txt'],
    })
    await applyIo(cache, cold, undefined, [readRecord('/s3/f.txt', 'etag-3')])
    const raw = new IOResult({
      reads: { '/s3/f.txt': ENC.encode('new') },
      cache: ['/s3/f.txt'],
    })
    await applyIo(cache, raw, undefined, [])
    expect(DEC.decode((await cache.get('/s3/f.txt')) ?? undefined)).toBe('old')
    expect(await cache.isFresh('/s3/f.txt', 'etag-3')).toBe(true)
  })
})

describe('cache invalidation', () => {
  it('write without cache entry invalidates', async () => {
    const cache = new RAMFileCacheStore()
    await cache.set('/f.txt', ENC.encode('old'))
    const io = new IOResult({ writes: { '/f.txt': ENC.encode('new') } })
    await applyIo(cache, io)
    expect(await cache.get('/f.txt')).toBeNull()
  })
})

describe('edge cases', () => {
  it('skips paths with no data', async () => {
    const cache = new RAMFileCacheStore()
    const io = new IOResult({ cache: ['/missing.txt'] })
    await applyIo(cache, io)
    expect(await cache.get('/missing.txt')).toBeNull()
  })

  it('empty IOResult is a no-op', async () => {
    const cache = new RAMFileCacheStore()
    await applyIo(cache, new IOResult())
  })
})

describe('background drain', () => {
  it('retires an evicted fill before a replacement starts at the same path', async () => {
    const cache = new RAMFileCacheStore()
    let releaseOld = (): void => undefined
    let releaseNew = (): void => undefined
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve
    })
    async function* stream(gate: Promise<void>, data: string) {
      await gate
      yield ENC.encode(data)
    }
    const path = '/data/file'
    await applyIo(
      cache,
      new IOResult({
        reads: { [path]: new CachableAsyncIterator(stream(oldGate, 'old account')) },
        cache: [path],
      }),
    )
    const old = cache.drainTasks.get(path)
    await cache.evictPrefix('/data/')
    expect(cache.drainTasks.has(path)).toBe(false)
    await applyIo(
      cache,
      new IOResult({
        reads: { [path]: new CachableAsyncIterator(stream(newGate, 'new account')) },
        cache: [path],
      }),
    )
    const fresh = cache.drainTasks.get(path)
    try {
      releaseOld()
      await old
      expect(await cache.get(path)).toBeNull()
      expect(cache.drainTasks.get(path)).toBe(fresh)
      releaseNew()
      await fresh
      expect(DEC.decode((await cache.get(path)) ?? undefined)).toBe('new account')
    } finally {
      releaseOld()
      releaseNew()
      await Promise.allSettled([old, fresh])
    }
  })

  it('does not start a duplicate drain for the same path', async () => {
    const cache = new RAMFileCacheStore()
    const io1 = new IOResult({ reads: { '/f.txt': makeStream('first') }, cache: ['/f.txt'] })
    await applyIo(cache, io1)
    expect(cache.drainTasks.has('/f.txt')).toBe(true)
    const io2 = new IOResult({ reads: { '/f.txt': makeStream('second') }, cache: ['/f.txt'] })
    await applyIo(cache, io2)
    expect([...cache.drainTasks.keys()].filter((k) => k === '/f.txt')).toHaveLength(1)
    await sleep(50)
    expect(DEC.decode((await cache.get('/f.txt')) ?? undefined)).toBe('first')
  })

  it('does not drain when the path is already cached', async () => {
    const cache = new RAMFileCacheStore()
    await cache.set('/f.txt', ENC.encode('cached'))
    const io = new IOResult({ reads: { '/f.txt': makeStream('new') }, cache: ['/f.txt'] })
    await applyIo(cache, io)
    expect(cache.drainTasks.has('/f.txt')).toBe(false)
    expect(DEC.decode((await cache.get('/f.txt')) ?? undefined)).toBe('cached')
  })
})

describe('maxDrainBytes (cancellable cache drain)', () => {
  it('defaults the budget to cacheLimit, never unbounded', async () => {
    const cache = new RAMFileCacheStore({ limit: 500 })
    const small = makeChunkedStream(Array.from({ length: 3 }, () => new Uint8Array(100).fill(97)))
    const huge = makeChunkedStream(Array.from({ length: 10 }, () => new Uint8Array(100).fill(98)))
    await applyIo(cache, new IOResult({ reads: { '/small.txt': small }, cache: ['/small.txt'] }))
    await applyIo(cache, new IOResult({ reads: { '/huge.txt': huge }, cache: ['/huge.txt'] }))
    await sleep(50)
    expect((await cache.get('/small.txt'))?.byteLength).toBe(300)
    expect(await cache.get('/huge.txt')).toBeNull()
  })

  it('releases an over-budget buffer without evicting warm data', async () => {
    const cache = new RAMFileCacheStore({ limit: 500, maxDrainBytes: 300 })
    await cache.set('/warm.txt', new Uint8Array(200).fill(119))
    const stream = makeChunkedStream(Array.from({ length: 10 }, () => new Uint8Array(100).fill(99)))
    const io = new IOResult({ reads: { '/big.txt': stream }, cache: ['/big.txt'] })
    await applyIo(cache, io)
    await sleep(50)
    expect((await cache.get('/warm.txt'))?.byteLength).toBe(200)
    expect(await cache.get('/big.txt')).toBeNull()
    expect(stream.bufferedChunks).toHaveLength(0)
  })

  it('drain completes below threshold', async () => {
    const cache = new RAMFileCacheStore({ maxDrainBytes: 10000 })
    const chunks = Array.from({ length: 5 }, () => new Uint8Array(100).fill(120))
    const io = new IOResult({
      reads: { '/small.txt': makeChunkedStream(chunks) },
      cache: ['/small.txt'],
    })
    await applyIo(cache, io)
    await sleep(50)
    const cached = await cache.get('/small.txt')
    expect(cached).not.toBeNull()
    expect(cached?.byteLength).toBe(500)
  })

  it('drain stops above threshold and skips the cache fill', async () => {
    const cache = new RAMFileCacheStore({ maxDrainBytes: 300 })
    const chunks = Array.from({ length: 20 }, () => new Uint8Array(100).fill(122))
    const io = new IOResult({
      reads: { '/huge.txt': makeChunkedStream(chunks) },
      cache: ['/huge.txt'],
    })
    await applyIo(cache, io)
    await sleep(50)
    expect(await cache.get('/huge.txt')).toBeNull()
  })

  it('threshold is per drain task, not shared', async () => {
    const cache = new RAMFileCacheStore({ maxDrainBytes: 300 })
    const s1 = makeChunkedStream([new Uint8Array(100).fill(97), new Uint8Array(100).fill(97)])
    const s2 = makeChunkedStream([new Uint8Array(100).fill(98), new Uint8Array(100).fill(98)])
    await applyIo(cache, new IOResult({ reads: { '/a.txt': s1 }, cache: ['/a.txt'] }))
    await applyIo(cache, new IOResult({ reads: { '/b.txt': s2 }, cache: ['/b.txt'] }))
    await sleep(50)
    expect(await cache.get('/a.txt')).not.toBeNull()
    expect(await cache.get('/b.txt')).not.toBeNull()
  })
})

describe('the token describes the bytes stored', () => {
  it('read bytes take the read token, not the write', async () => {
    // Read bytes carry the read's token even when a write record of the
    // path comes later. Stamping the write's would make isFresh call stale
    // bytes fresh for as long as the entry lives.
    const cache = new RAMFileCacheStore()
    const io = new IOResult({ reads: { '/s3/f.txt': ENC.encode('old') }, cache: ['/s3/f.txt'] })
    await applyIo(cache, io, undefined, [
      opRecord('read', '/s3/f.txt', 'etag-old-2', 3),
      opRecord('write', '/s3/f.txt', 'etag-new-2', 3),
    ])
    expect(DEC.decode((await cache.get('/s3/f.txt')) ?? undefined)).toBe('old')
    expect(await cache.isFresh('/s3/f.txt', 'etag-old-2')).toBe(true)
    expect(await cache.isFresh('/s3/f.txt', 'etag-new-2')).toBe(false)
  })

  it('written bytes ignore an earlier read token', async () => {
    // sed -i lists the path in writes only, but emits its own pre-edit
    // read record; the entry must carry the post-edit write token.
    const cache = new RAMFileCacheStore()
    const written = ENC.encode('new')
    const io = new IOResult({ writes: { '/s3/f.txt': written }, cache: ['/s3/f.txt'] })
    await applyIo(cache, io, undefined, [
      opRecord('read', '/s3/f.txt', 'etag-old-2', 3),
      opRecord('write', '/s3/f.txt', 'etag-new-2', 3, written),
    ])
    expect(await cache.isFresh('/s3/f.txt', 'etag-new-2')).toBe(true)
    expect(await cache.isFresh('/s3/f.txt', 'etag-old-2')).toBe(false)
  })

  it('a streamed read takes the read token', async () => {
    const cache = new RAMFileCacheStore()
    const stream = makeStream('old')
    expect(DEC.decode(await stream.drain())).toBe('old')
    const io = new IOResult({ reads: { '/s3/f.txt': stream }, cache: ['/s3/f.txt'] })
    await applyIo(cache, io, undefined, [
      opRecord('read', '/s3/f.txt', 'etag-old-2', 3),
      opRecord('write', '/s3/f.txt', 'etag-new-2', 3),
    ])
    expect(await cache.isFresh('/s3/f.txt', 'etag-old-2')).toBe(true)
  })

  it('an op in neither direction is never a token', async () => {
    const cache = new RAMFileCacheStore()
    const io = new IOResult({ reads: { '/s3/f.txt': ENC.encode('x') }, cache: ['/s3/f.txt'] })
    await applyIo(cache, io, undefined, [opRecord('readdir', '/s3/f.txt', 'etag-2', 1)])
    expect(await cache.isFresh('/s3/f.txt', 'etag-2')).toBe(false)
  })

  it('does not size-check a read', async () => {
    // A read record's byte count tracks what was consumed, which a
    // partially drained stream makes smaller than the bytes cached, so
    // the identity rule is the write direction's alone.
    const cache = new RAMFileCacheStore()
    const io = new IOResult({ reads: { '/s3/f.txt': ENC.encode('abcdef') }, cache: ['/s3/f.txt'] })
    await applyIo(cache, io, undefined, [opRecord('read', '/s3/f.txt', 'etag-2', 1)])
    expect(await cache.isFresh('/s3/f.txt', 'etag-2')).toBe(true)
  })
})

// ── writtenVerdict: which written bytes a line keeps ─────────────────────

const VERDICT_FIXTURE = new URL(
  '../../../../../../integ/fixtures/cache/written_verdict.json',
  import.meta.url,
)

interface VerdictRow {
  op: string
  path: string
  fingerprint: string | null
  bytes: number
  claimed: string | null
}

interface VerdictCase {
  name: string
  path: string
  records: VerdictRow[] | null
  nbytes: number
  expect: { keep: boolean; token: string | null }
}

const VERDICT_CASES = (
  JSON.parse(readFileSync(VERDICT_FIXTURE, 'utf-8')) as { cases: VerdictCase[] }
).cases

describe('latestFingerprint', () => {
  it('reads only reads', () => {
    // A write's token labels written bytes through writtenVerdict; here it
    // would stamp the write's token onto bytes a read produced, and the
    // entry would read as fresh forever.
    const records = [
      opRecord('read', '/s3/f.txt', 'etag-1', 3),
      opRecord('write', '/s3/f.txt', 'etag-2', 3),
      opRecord('readdir', '/s3/f.txt', 'etag-3', 3),
    ]
    expect(latestFingerprint(records, '/s3/f.txt')).toBe('etag-1')
  })
})

describe('writtenVerdict', () => {
  it('reads a non-empty corpus', () => {
    expect(VERDICT_CASES.length).toBeGreaterThan(0)
  })

  it.each(VERDICT_CASES.map((c) => [c.name, c] as const))(
    'matches the shared fixture: %s',
    (_name, c) => {
      // integ/fixtures/cache/written_verdict.json is the contract: the python
      // suite (tests/cache/file/test_io.py) asserts the same rows. W is the
      // very value being cached, so a claimed W is the same object; W= is an
      // equal copy that is not W; X is other bytes of the same length; W~
      // differs from W only in its last byte; W< is a shorter prefix of W.
      const written = ENC.encode('abc')
      const equalCopy = written.slice()
      const values = new Map<string | null, ByteSource | null>([
        ['W', written],
        ['W=', equalCopy],
        ['X', ENC.encode('xyz')],
        ['W~', ENC.encode('abd')],
        ['W<', ENC.encode('ab')],
        [null, null],
      ])
      const records =
        c.records === null
          ? undefined
          : c.records.map((row) =>
              opRecord(
                row.op,
                row.path,
                row.fingerprint,
                row.bytes,
                values.get(row.claimed) ?? null,
              ),
            )
      expect(writtenVerdict(records, c.path, written, c.nbytes)).toEqual([
        c.expect.keep,
        c.expect.token,
      ])
    },
  )

  it.each([
    ['unfinished', false],
    ['discarded', true],
  ])('a claimed written stream left %s evicts the pre-write entry', async (_name, discard) => {
    // No claimer returns a written stream it did not finish, and its bytes
    // are not the file's; the eviction loop skips claimed paths, so the
    // pre-write entry goes here, with no drain.
    const cache = new RAMFileCacheStore()
    await cache.set('/s3/f.txt', ENC.encode('old'))
    const stream = makeStream('abc')
    if (discard) await stream.discard()
    const io = new IOResult({ writes: { '/s3/f.txt': stream }, cache: ['/s3/f.txt'] })
    await applyIo(cache, io, undefined, [opRecord('write', '/s3/f.txt', 'etag-put-2', 3, stream)])
    expect(cache.drainTasks.size).toBe(0)
    expect(await cache.exists('/s3/f.txt')).toBe(false)
  })

  it.each([
    ['bytes agree', false, 3, true],
    ['bytes differ', false, 99, false],
    ['finished stream agrees', true, 3, true],
    ['finished stream differs', true, 99, false],
  ])('claimed written %s: the verdict decides', async (_, stream, stored, kept) => {
    // A stored size other than the bytes sent means neither they nor the
    // pre-write entry are the file, so the entry is removed, not skipped.
    const cache = new RAMFileCacheStore()
    await cache.set('/s3/f.txt', ENC.encode('old'))
    let written: ByteSource = ENC.encode('abc')
    if (stream) {
      const it = makeStream('abc')
      expect(DEC.decode(await it.drain())).toBe('abc')
      written = it
    }
    const io = new IOResult({ writes: { '/s3/f.txt': written }, cache: ['/s3/f.txt'] })
    await applyIo(cache, io, undefined, [
      opRecord('write', '/s3/f.txt', 'etag-put-2', stored, written),
    ])
    if (kept) {
      expect(DEC.decode((await cache.get('/s3/f.txt')) ?? new Uint8Array())).toBe('abc')
      expect(await cache.isFresh('/s3/f.txt', 'etag-put-2')).toBe(true)
    } else {
      expect(await cache.exists('/s3/f.txt')).toBe(false)
    }
  })
})

// ── the mount's staleness bound reaches the entry ───────────────────────

function facts(ttl: number, cacheable = true): (path: string) => CacheFacts {
  return () => ({ cacheable, ttl })
}

// The value, not just its presence. `isUnbounded` alone would stay green
// if every stamp wrote the same hardcoded bound, which is exactly the
// regression that makes a per-mount `ttl:` cosmetic.
function boundOf(cache: RAMFileCacheStore, key: string): number | null | undefined {
  return cache.snapshotEntries().find((e) => e.key === key)?.entry.ttl
}

describe('applyIo bound stamping', () => {
  it('stamps the bound on a plain read', async () => {
    const cache = new RAMFileCacheStore()
    const io = new IOResult({ reads: { '/s3/f.txt': ENC.encode('hello') }, cache: ['/s3/f.txt'] })
    await applyIo(cache, io, facts(45))
    expect(boundOf(cache, '/s3/f.txt')).toBe(45)
    expect(await cache.isUnbounded('/s3/f.txt')).toBe(false)
  })

  // The large-object path stamps too. A stream the command never
  // exhausted is filled by the background drain, which writes through
  // `add` rather than `set`; missing it would leave streamed reads -- the
  // ones a staleness bound matters most for -- as the only entries
  // `bounded` never expires.
  it('stamps the bound on a background drain', async () => {
    const cache = new RAMFileCacheStore()
    const io = new IOResult({
      reads: { '/s3/big.txt': makeStream('hello') },
      cache: ['/s3/big.txt'],
    })
    await applyIo(cache, io, facts(30))
    await sleep(50)
    expect(DEC.decode((await cache.get('/s3/big.txt')) ?? undefined)).toBe('hello')
    expect(boundOf(cache, '/s3/big.txt')).toBe(30)
    expect(await cache.isUnbounded('/s3/big.txt')).toBe(false)
  })

  // `cacheable` is read first and short-circuits, so the bound is never
  // consulted for a path that is not being cached -- which is what keeps
  // an unresolvable mount from reading as "no bound".
  it('skips a path its mount does not cache', async () => {
    const cache = new RAMFileCacheStore()
    const io = new IOResult({ reads: { '/s3/f.txt': ENC.encode('hello') }, cache: ['/s3/f.txt'] })
    await applyIo(cache, io, facts(30, false))
    expect(await cache.exists('/s3/f.txt')).toBe(false)
  })
})
