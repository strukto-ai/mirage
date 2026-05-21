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
import { IndexEntry, LookupStatus } from './config.ts'
import { RedisIndexCacheStore } from './redis.ts'

describe('RedisIndexCacheStore default keyPrefix', () => {
  it('namespaces keys under mirage:index: by default', () => {
    const store = new RedisIndexCacheStore()
    const prefix = (store as unknown as { entryPrefix: string }).entryPrefix
    expect(prefix).toBe('mirage:index:mirage:idx:entry:')
  })
})

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

function entry(id: string, name: string, resourceType = 'file'): IndexEntry {
  return new IndexEntry({ id, name, resourceType })
}

describe.skipIf(skip)('RedisIndexCacheStore', () => {
  let store: RedisIndexCacheStore
  const prefix = `mirage:idx:test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`

  beforeEach(async () => {
    store = new RedisIndexCacheStore(
      REDIS_URL !== undefined
        ? { url: REDIS_URL, keyPrefix: prefix, ttl: 600 }
        : { keyPrefix: prefix, ttl: 600 },
    )
    await store.clear()
  })

  afterEach(async () => {
    await store.clear()
    await store.close()
  })

  it('get returns NOT_FOUND when missing', async () => {
    const r = await store.get('/nope')
    expect(r.status).toBe(LookupStatus.NOT_FOUND)
  })

  it('put + get round-trips entry', async () => {
    await store.put('/a', entry('id-a', 'a'))
    const r = await store.get('/a')
    expect(r.entry?.id).toBe('id-a')
    expect(r.entry?.name).toBe('a')
    expect(r.entry?.indexTime).not.toBe('')
  })

  it('setDir stores entries and listDir returns sorted children', async () => {
    await store.setDir('/', [
      ['b', entry('id-b', 'b')],
      ['a', entry('id-a', 'a')],
    ])
    const list = await store.listDir('/')
    expect(list.entries).toEqual(['/a', '/b'])
  })

  it('listDir NOT_FOUND when unset', async () => {
    const r = await store.listDir('/ghost')
    expect(r.status).toBe(LookupStatus.NOT_FOUND)
  })

  it('invalidateDir removes children entry', async () => {
    await store.setDir('/x', [['f', entry('id-f', 'f')]])
    await store.invalidateDir('/x')
    const r = await store.listDir('/x')
    expect(r.status).toBe(LookupStatus.NOT_FOUND)
  })

  it('setDir sets TTL based on default ttl', async () => {
    const s = new RedisIndexCacheStore(
      REDIS_URL !== undefined
        ? { url: REDIS_URL, keyPrefix: prefix, ttl: 1 }
        : { keyPrefix: prefix, ttl: 1 },
    )
    try {
      await s.setDir('/tmp', [['x', entry('id-x', 'x')]])
      expect((await s.listDir('/tmp')).entries).toEqual(['/tmp/x'])
      await new Promise((r) => setTimeout(r, 1100))
      const r = await s.listDir('/tmp')
      expect(r.status === LookupStatus.NOT_FOUND || r.status === LookupStatus.EXPIRED).toBe(true)
    } finally {
      await s.clear()
      await s.close()
    }
  })

  it('clear wipes everything under prefix', async () => {
    await store.put('/a', entry('id-a', 'a'))
    await store.setDir('/', [['a', entry('id-a', 'a')]])
    await store.clear()
    expect((await store.get('/a')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/')).status).toBe(LookupStatus.NOT_FOUND)
  })
})
