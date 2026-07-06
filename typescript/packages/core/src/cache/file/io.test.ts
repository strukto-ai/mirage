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

import { CachableAsyncIterator } from '../../io/cachable_iterator.ts'
import { IOResult } from '../../io/types.ts'
import { OpRecord } from '../../observe/record.ts'
import { applyIo } from './io.ts'
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

  it('prefers reads over writes for the same path', async () => {
    const cache = new RAMFileCacheStore()
    const io = new IOResult({
      reads: { '/f.txt': ENC.encode('read-data') },
      writes: { '/f.txt': ENC.encode('write-data') },
      cache: ['/f.txt'],
    })
    await applyIo(cache, io)
    expect(DEC.decode((await cache.get('/f.txt')) ?? undefined)).toBe('read-data')
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

function readRecord(path: string, fingerprint: string | null): OpRecord {
  return new OpRecord({
    op: 'read',
    path,
    source: 's3',
    bytes: 0,
    timestamp: 0,
    durationMs: 0,
    fingerprint,
  })
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
  it('drains unbounded when threshold is null', async () => {
    const cache = new RAMFileCacheStore()
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(100).fill(97))
    const io = new IOResult({
      reads: { '/big.txt': makeChunkedStream(chunks) },
      cache: ['/big.txt'],
    })
    await applyIo(cache, io)
    await sleep(50)
    const cached = await cache.get('/big.txt')
    expect(cached).not.toBeNull()
    expect(cached?.byteLength).toBe(1000)
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
