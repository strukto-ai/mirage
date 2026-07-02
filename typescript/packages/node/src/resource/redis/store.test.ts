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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  it('clear wipes everything including root dir set', async () => {
    await store.setFile('/a', new Uint8Array([1]))
    await store.setModified('/a', 'ts')
    await store.addDir('/foo')
    await store.clear()
    expect(await store.listFiles()).toEqual([])
    expect(await store.getModified('/a')).toBeNull()
    // after clear, dir set is deleted, so / is no longer seeded
    expect((await store.listDirs()).size).toBe(0)
  })
})
