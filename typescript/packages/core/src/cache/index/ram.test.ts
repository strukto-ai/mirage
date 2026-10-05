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
import { ListingCheckStore, RAMIndexCacheStore } from './ram.ts'

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

  // The distinction the whole github invalidation rests on: `clear` leaves
  // a store that reads exactly like one that was never filled, so a backend
  // whose index *is* its listing reports an empty repository. `invalidate`
  // keeps the rows and only expires them, so the lookup says EXPIRED and
  // the backend knows to refetch.
  it('invalidate expires every directory without discarding it', async () => {
    const store = new RAMIndexCacheStore()
    await store.setDir('/a', [['x', mkEntry('1', 'x')]])
    await store.setDir('/b', [['y', mkEntry('2', 'y')]])
    await store.invalidate()
    expect((await store.listDir('/a')).status).toBe(LookupStatus.EXPIRED)
    expect((await store.listDir('/b')).status).toBe(LookupStatus.EXPIRED)
    await store.clear()
    expect((await store.listDir('/a')).status).toBe(LookupStatus.NOT_FOUND)
  })

  // An empty store has nothing to expire, and must not grow a row that
  // makes a never-listed directory answer EXPIRED instead of NOT_FOUND.
  it('invalidate leaves an unlisted directory absent', async () => {
    const store = new RAMIndexCacheStore()
    await store.invalidate()
    expect((await store.listDir('/dir')).status).toBe(LookupStatus.NOT_FOUND)
  })

  it('clear wipes everything', async () => {
    const store = new RAMIndexCacheStore()
    await store.put('/a', mkEntry('1', 'a'))
    await store.setDir('/dir', [['x', mkEntry('2', 'x')]])
    await store.clear()
    expect((await store.get('/a')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/dir')).status).toBe(LookupStatus.NOT_FOUND)
  })

  it('invalidatePrefix drops nested listings', async () => {
    const store = new RAMIndexCacheStore()
    await store.setDir('/chan/day', [['chat.jsonl', mkEntry('1', 'chat.jsonl')]])
    await store.setDir('/chan/day/files', [['a.png', mkEntry('2', 'a.png')]])
    await store.invalidatePrefix('/chan/day')
    expect((await store.listDir('/chan/day')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/chan/day/files')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.get('/chan/day/files/a.png')).status).toBe(LookupStatus.NOT_FOUND)
  })

  it('invalidateDir leaves the nested listing', async () => {
    const store = new RAMIndexCacheStore()
    await store.setDir('/chan/day', [['chat.jsonl', mkEntry('1', 'chat.jsonl')]])
    await store.setDir('/chan/day/files', [['a.png', mkEntry('2', 'a.png')]])
    await store.invalidateDir('/chan/day')
    expect((await store.listDir('/chan/day/files')).entries).toEqual(['/chan/day/files/a.png'])
  })

  it('invalidatePrefix respects the path boundary', async () => {
    const store = new RAMIndexCacheStore()
    await store.setDir('/chan/day', [['a', mkEntry('1', 'a')]])
    await store.setDir('/chan/daytime', [['b', mkEntry('2', 'b')]])
    await store.invalidatePrefix('/chan/day')
    expect((await store.listDir('/chan/day')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/chan/daytime')).entries).toEqual(['/chan/daytime/b'])
  })

  it('handles root directory path', async () => {
    const store = new RAMIndexCacheStore()
    await store.setDir('/', [['a', mkEntry('1', 'a')]])
    const result = await store.listDir('/')
    expect(result.entries).toEqual(['/a'])
  })

  it('a scratch store hints the row its source holds', async () => {
    const src = new RAMIndexCacheStore()
    await src.setDir('/m/a', [['c.txt', mkEntry('F1', 'c.txt', 'box/file')]])
    const scratch = new ListingCheckStore({ hints: src })
    const row = (await src.get('/m/a/c.txt')).entry
    expect(row).toBeDefined()
    expect(await scratch.hint('/m/a/c.txt')).toBe(row)
    expect(await scratch.hint('/m/a/missing.txt')).toBeNull()
  })

  // Seeding the scratch store with the mount's rows would hand every
  // backend cached metadata as truth -- the #1040 bug.
  it('a hint is never an answer', async () => {
    const src = new RAMIndexCacheStore()
    await src.setDir('/m/a', [['c.txt', mkEntry('F1', 'c.txt', 'box/file')]])
    const scratch = new ListingCheckStore({ hints: src })
    expect((await scratch.get('/m/a/c.txt')).entry).toBeUndefined()
    expect((await scratch.listDir('/m/a')).entries).toBeUndefined()
    expect(await scratch.hint('/m/a/c.txt')).not.toBeNull()
  })

  // The id is confirmed by the backend before anything trusts it, so an
  // expired listing is still a usable address.
  it('an expired row still hints', async () => {
    const src = new RAMIndexCacheStore({ ttl: 60 })
    await src.setDir(
      '/m/a',
      [['c.txt', mkEntry('F1', 'c.txt', 'box/file')]],
      new Date('2000-01-01T00:00:00Z'),
    )
    expect((await src.listDir('/m/a')).status).toBe(LookupStatus.EXPIRED)
    const scratch = new ListingCheckStore({ hints: src })
    expect(await scratch.hint('/m/a/c.txt')).not.toBeNull()
  })
})
