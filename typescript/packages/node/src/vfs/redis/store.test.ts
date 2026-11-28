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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCAN_COUNT } from '@struktoai/mirage-core/vfs/redis/constants'
import { RedisStore } from './store.ts'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

describe.skipIf(skip)('RedisStore', () => {
  let store: RedisStore
  const prefix = `mirage:fs:test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`

  beforeEach(async () => {
    store = new RedisStore(
      REDIS_URL !== undefined ? { url: REDIS_URL, keyPrefix: prefix } : { keyPrefix: prefix },
    )
    await store.clear()
  })

  afterEach(async () => {
    await store.clear()
    await store.close()
  })

  // Twin of test_every_scan_asks_for_many_keys_a_round_trip: Redis looks at
  // COUNT keys a SCAN or SSCAN round trip, ten unless asked for more, and a
  // directory listing walks the whole keyspace, so one listing of a large
  // store took a round trip per ten keys. Every walk the store makes asks for
  // SCAN_COUNT.
  it('asks for many keys a round trip on every scan', async () => {
    const client = await store.client()
    const scans = vi.spyOn(client, 'scanIterator')
    const sets = vi.spyOn(client, 'sScanIterator')
    await store.addDir('/d')
    await store.setFile('/d/a', new TextEncoder().encode('a'))
    const found: [string, boolean][] = []
    for await (const item of store.scanPaths('/d/')) found.push(item)
    expect(found).toEqual([['/d/a', false]])
    expect(await store.listFiles('/d/')).toEqual(['/d/a'])
    await store.clear()
    expect(scans).toHaveBeenCalled()
    expect(sets).toHaveBeenCalled()
    const counts = [
      ...scans.mock.calls.map((call) => call[0]?.COUNT),
      ...sets.mock.calls.map((call) => call[1]?.COUNT),
    ]
    expect(new Set(counts)).toEqual(new Set([SCAN_COUNT]))
  })

  // Twin of test_stat_asks_what_is_at_a_path_in_one_pipeline: whether a
  // directory and a file are at a path, and the fields kept under its name, go
  // out in one pipeline, and none of those lookups on its own.
  it('answers what is at a path in one pipeline', async () => {
    await store.addDir('/sub')
    await store.setFile('/hello.txt', new TextEncoder().encode('hello world'))
    await store.setModified('/hello.txt', '2026-01-02T00:00:00Z')
    const client = await store.client()
    const pipelines = vi.spyOn(client, 'multi')
    const alone = ['sIsMember', 'exists', 'hGetAll', 'strLen', 'get'].map((name) =>
      vi.spyOn(client, name as 'get'),
    )
    expect(await store.statAt('/hello.txt')).toEqual([false, true, {}, 11, '2026-01-02T00:00:00Z'])
    expect(await store.statAt('/sub')).toEqual([true, false, {}, 0, null])
    expect(await store.statAt('/')).toEqual([true, false, {}, 0, null])
    expect(await store.statAt('/nope')).toEqual([false, false, {}, 0, null])
    expect(pipelines).toHaveBeenCalledTimes(4)
    for (const spy of alone) expect(spy).not.toHaveBeenCalled()
    await store.clear()
  })

  it('connects afresh after the server drops its connection', async () => {
    const first = await store.client()
    await store.setFile('/kept.txt', new TextEncoder().encode('kept'))
    const { createClient } = await import('redis')
    const admin = createClient(REDIS_URL !== undefined ? { url: REDIS_URL } : {})
    await admin.connect()
    await admin.clientKill({ filter: 'ID', id: await first.clientId() })
    await admin.quit()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const data = await store.getFile('/kept.txt')
    expect(new TextDecoder().decode(data ?? new Uint8Array())).toBe('kept')
    expect(await store.client()).not.toBe(first)
  })

  it('seeds root dir on first client access', async () => {
    // a fresh store (fresh clientPromise) should seed /
    const fresh = new RedisStore(
      REDIS_URL !== undefined
        ? { url: REDIS_URL, keyPrefix: `${prefix}seed:` }
        : { keyPrefix: `${prefix}seed:` },
    )
    try {
      await fresh.client()
      expect(await fresh.hasDir('/')).toBe(true)
    } finally {
      await fresh.clear()
      await fresh.close()
    }
  })

  it('setFile / getFile round-trips binary data', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 0xff, 0xfe])
    await store.setFile('/a.bin', bytes)
    const got = await store.getFile('/a.bin')
    expect(got).toEqual(bytes)
  })

  it('getFile returns null when missing', async () => {
    expect(await store.getFile('/nope')).toBeNull()
  })

  it('getFiles sizes each file on the server before it reads it', async () => {
    // A file absent, empty or longer than the limit is null, and so is one
    // past what is left of the room once the files before it took theirs; a
    // smaller one after it still fits, and binary bytes come back whole.
    const bytes = new Uint8Array([0, 1, 2, 3, 0xff, 0xfe])
    await store.setFile('/a.bin', bytes)
    await store.setFile('/e', new Uint8Array(0))
    await store.setFile('/long', new Uint8Array(9))
    for (const [p, size] of [
      ['/f', 16],
      ['/g', 16],
      ['/h', 4],
    ] as const) {
      await store.setFile(p, new Uint8Array(size).fill(7))
    }
    expect(await store.getFiles(['/a.bin', '/gone', '/e', '/long'], 8, null)).toEqual([
      bytes,
      null,
      null,
      null,
    ])
    expect(await store.getFiles(['/f', '/g', '/h'], 64, 20)).toEqual([
      new Uint8Array(16).fill(7),
      null,
      new Uint8Array(4).fill(7),
    ])
    expect(await store.getFiles(['/f'], 64, -1)).toEqual([null])
    expect(await store.getFiles([], 8, null)).toEqual([])
  })

  it('getFileRange returns empty for zero-length reads and preserves missing', async () => {
    await store.setFile('/data', new TextEncoder().encode('payload'))
    await store.setFile('/empty', new Uint8Array(0))
    expect(await store.getFileRange('/data', 0, 0)).toEqual(new Uint8Array(0))
    expect(await store.getFileRange('/data', 4, 0)).toEqual(new Uint8Array(0))
    expect(await store.getFileRange('/empty', 0, 0)).toEqual(new Uint8Array(0))
    expect(await store.getFileRange('/empty', 4, 0)).toEqual(new Uint8Array(0))
    expect(await store.getFileRange('/missing', 0, 0)).toBeNull()
    expect(await store.getFileRange('/missing', 4, 0)).toBeNull()
  })

  it('hasFile / delFile', async () => {
    await store.setFile('/x', new Uint8Array([1]))
    expect(await store.hasFile('/x')).toBe(true)
    await store.delFile('/x')
    expect(await store.hasFile('/x')).toBe(false)
  })

  it('listFiles returns sorted keys', async () => {
    await store.setFile('/b', new Uint8Array([1]))
    await store.setFile('/a', new Uint8Array([2]))
    await store.setFile('/c', new Uint8Array([3]))
    expect(await store.listFiles()).toEqual(['/a', '/b', '/c'])
  })

  it('fileLen returns size', async () => {
    await store.setFile('/x', new Uint8Array([1, 2, 3, 4, 5]))
    expect(await store.fileLen('/x')).toBe(5)
  })

  it('addDir / hasDir / removeDir / listDirs', async () => {
    await store.addDir('/')
    await store.addDir('/foo')
    await store.addDir('/foo/bar')
    expect(await store.hasDir('/foo')).toBe(true)
    expect(await store.hasDir('/ghost')).toBe(false)
    const dirs = await store.listDirs()
    expect(dirs.has('/')).toBe(true)
    expect(dirs.has('/foo')).toBe(true)
    expect(dirs.has('/foo/bar')).toBe(true)
    await store.removeDir('/foo/bar')
    expect(await store.hasDir('/foo/bar')).toBe(false)
  })

  it('getModified / setModified / delModified', async () => {
    expect(await store.getModified('/x')).toBeNull()
    await store.setModified('/x', '2026-01-01T00:00:00Z')
    expect(await store.getModified('/x')).toBe('2026-01-01T00:00:00Z')
    await store.delModified('/x')
    expect(await store.getModified('/x')).toBeNull()
  })

  it('clear wipes everything but the root', async () => {
    await store.setFile('/a', new Uint8Array([1]))
    await store.setModified('/a', 'ts')
    await store.addDir('/foo')
    await store.clear()
    expect(await store.listFiles()).toEqual([])
    expect(await store.getModified('/a')).toBeNull()
    expect([...(await store.listDirs())]).toEqual(['/'])
  })

  it('statMany answers what the single getters do', async () => {
    await store.setFile('/a.txt', new TextEncoder().encode('hello'))
    await store.setModified('/a.txt', '2026-01-01T00:00:00+00:00')
    await store.setAttrs('/a.txt', { mode: '420' })
    await store.addDir('/d')
    const paths: [string, boolean][] = [
      ['/a.txt', false],
      ['/d', true],
      ['/gone', false],
    ]
    const singles = []
    for (const [p, isDir] of paths) {
      singles.push([
        await store.getAttrs(p),
        isDir ? null : await store.fileLen(p),
        await store.getModified(p),
      ])
    }
    expect(await store.statMany(paths)).toEqual(singles)
    expect(singles[0]).toEqual([{ mode: '420' }, 5, '2026-01-01T00:00:00+00:00'])
    expect(await store.statMany([])).toEqual([])
  })

  it('infoMemory answers the memory section', async () => {
    const text = await store.infoMemory()
    expect(text).toMatch(/^used_memory:\d+\r?$/m)
    expect(text).toMatch(/^maxmemory:\d+\r?$/m)
  })

  it('clear drops a staging key left by a chunked browser write', async () => {
    const c = await store.client()
    await c.set(`${prefix}tmp:/big:abc`, 'partial')
    await store.clear()
    expect(await c.exists(`${prefix}tmp:/big:abc`)).toBe(0)
  })
})

describe('RedisStore root', () => {
  it('is a directory without a server', async () => {
    const store = new RedisStore({ url: 'redis://127.0.0.1:1/0' })
    expect(await store.hasDir('/')).toBe(true)
    await store.close()
  })
})
