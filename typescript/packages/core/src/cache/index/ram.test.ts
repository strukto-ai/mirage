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
import { IndexEntry, LookupStatus, ResourceType } from './config.ts'
import { RAMIndexCacheStore } from './ram.ts'

function mkEntry(id: string, name: string, type: string = ResourceType.FILE): IndexEntry {
  return new IndexEntry({ id, name, resourceType: type })
}

describe('RAMIndexCacheStore', () => {
  it('returns NOT_FOUND for unknown path', async () => {
    const store = new RAMIndexCacheStore()
    const result = await store.get('/foo')
    expect(result.status).toBe(LookupStatus.NOT_FOUND)
    expect(result.entry).toBeUndefined()
  })

  it('put then get returns the entry with indexTime set', async () => {
    const store = new RAMIndexCacheStore()
    await store.put('/a', mkEntry('1', 'a'))
    const result = await store.get('/a')
    expect(result.status).toBeUndefined()
    expect(result.entry?.id).toBe('1')
    expect(result.entry?.indexTime).not.toBe('')
  })

  it('preserves provided indexTime on put', async () => {
    const store = new RAMIndexCacheStore()
    const entry = new IndexEntry({
      id: '1',
      name: 'a',
      resourceType: ResourceType.FILE,
      indexTime: '2024-01-01T00:00:00Z',
    })
    await store.put('/a', entry)
    const result = await store.get('/a')
    expect(result.entry?.indexTime).toBe('2024-01-01T00:00:00Z')
  })

  it('listDir returns NOT_FOUND when not set', async () => {
    const store = new RAMIndexCacheStore()
    const result = await store.listDir('/dir')
    expect(result.status).toBe(LookupStatus.NOT_FOUND)
  })

  it('setDir then listDir preserves insertion (readdir) order', async () => {
    const store = new RAMIndexCacheStore()
    await store.setDir('/dir', [
      ['b.txt', mkEntry('2', 'b.txt')],
      ['a.txt', mkEntry('1', 'a.txt')],
    ])
    const result = await store.listDir('/dir')
    expect(result.entries).toEqual(['/dir/b.txt', '/dir/a.txt'])
  })

  it('setDir populates get lookups for children', async () => {
    const store = new RAMIndexCacheStore()
    await store.setDir('/dir', [['x', mkEntry('1', 'x')]])
    const result = await store.get('/dir/x')
    expect(result.entry?.id).toBe('1')
  })

  it('listDir returns EXPIRED after TTL', async () => {
    const store = new RAMIndexCacheStore({ ttl: 0.001 })
    await store.setDir('/dir', [['a', mkEntry('1', 'a')]])
    await new Promise((r) => setTimeout(r, 10))
    const result = await store.listDir('/dir')
    expect(result.status).toBe(LookupStatus.EXPIRED)
  })

  it('invalidateDir removes children, expiry, and child entries', async () => {
    const store = new RAMIndexCacheStore()
    await store.setDir('/dir', [['a', mkEntry('1', 'a')]])
    await store.invalidateDir('/dir')
    const list = await store.listDir('/dir')
    expect(list.status).toBe(LookupStatus.NOT_FOUND)
    const get = await store.get('/dir/a')
    expect(get.entry ?? null).toBeNull()
  })

  it('clear wipes everything', async () => {
    const store = new RAMIndexCacheStore()
    await store.put('/a', mkEntry('1', 'a'))
    await store.setDir('/dir', [['x', mkEntry('2', 'x')]])
    await store.clear()
    expect((await store.get('/a')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/dir')).status).toBe(LookupStatus.NOT_FOUND)
  })

  it('handles root directory path', async () => {
    const store = new RAMIndexCacheStore()
    await store.setDir('/', [['a', mkEntry('1', 'a')]])
    const result = await store.listDir('/')
    expect(result.entries).toEqual(['/a'])
  })
})
