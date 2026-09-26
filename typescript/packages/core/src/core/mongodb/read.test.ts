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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it, vi } from 'vitest'
import { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { resolveMongoDBConfig } from '../../vfs/mongodb/config.ts'
import { PathSpec } from '../../types.ts'
import { MONGODB_IO } from '../../commands/builtin/mongodb/io.ts'
import { read } from './read.ts'
import { arrayIter, stubMongoDriver } from './_test_util.ts'

function ps(p: string): PathSpec {
  return new PathSpec({ virtual: p, directory: p, vfsPath: mountKey(p, '/mongo') })
}

function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

describe('read', () => {
  it('streams documents.jsonl as one JSON line per doc', async () => {
    const driver = stubMongoDriver({
      listDatabases: () => Promise.resolve(['app']),
      listCollections: () => Promise.resolve(['users']),
      iterDocuments: arrayIter([
        { _id: 'a', x: 1 },
        { _id: 'b', x: 2 },
      ]),
    })
    const accessor = new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
    const out = await read(accessor, ps('/mongo/app/collections/users/documents.jsonl'))
    const lines = decode(out).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '')).toEqual({ _id: 'a', x: 1 })
  })

  it('throws ENOENT for an unknown path', async () => {
    const driver = stubMongoDriver()
    const accessor = new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
    await expect(read(accessor, ps('/mongo/app/something'))).rejects.toThrow()
  })

  it('returns database.json payload at database_json scope', async () => {
    const driver = stubMongoDriver({
      listDatabases: () => Promise.resolve(['app']),
      listCollections: () => Promise.resolve(['users', 'orders']),
      listCollectionsDetailed: (_db, filter = {}) =>
        Promise.resolve([{ name: filter.name ?? 'users', type: 'collection' }]),
      countDocuments: () => Promise.resolve(7),
    })
    const accessor = new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
    const out = await read(accessor, ps('/mongo/app/database.json'))
    const parsed = JSON.parse(decode(out)) as { database: string; collections: unknown[] }
    expect(parsed.database).toBe('app')
    expect(parsed.collections).toHaveLength(2)
  })

  it('throws ENOENT when DOCUMENTS path references a missing collection', async () => {
    const driver = stubMongoDriver({
      listDatabases: () => Promise.resolve(['app']),
      listCollections: () => Promise.resolve([]),
    })
    const accessor = new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
    await expect(
      read(accessor, ps('/mongo/app/collections/ghost/documents.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT when DATABASE_JSON path references a missing database', async () => {
    const driver = stubMongoDriver({ listDatabases: () => Promise.resolve([]) })
    const accessor = new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
    await expect(read(accessor, ps('/mongo/ghost/database.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('registered read stream contract', () => {
  it.each(['database.json', 'collections/users/schema.json', 'collections/users/documents.jsonl'])(
    'matches read bytes for %s and renders metadata deterministically',
    async (leaf) => {
      const countDocuments = vi.fn(() => {
        throw new Error('full count scan')
      })
      const getIndexStats = vi.fn(() => {
        throw new Error('volatile counters')
      })
      const driver = stubMongoDriver({
        listDatabases: () => Promise.resolve(['app']),
        listCollections: (_db, kind) => Promise.resolve(kind === 'view' ? [] : ['users']),
        findDocuments: <T>() => Promise.resolve([{ _id: 1, value: 'café' }] as T[]),
        iterDocuments: arrayIter([{ _id: 1, value: 'café' }]),
        listIndexes: () => Promise.resolve([{ name: '_id_', key: { _id: 1 } }]),
        countDocuments,
        getIndexStats,
      })
      const accessor = new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
      const path = ps(`/mongo/app/${leaf}`)
      const expected = decode(await read(accessor, path))
      let actual = ''
      for await (const chunk of MONGODB_IO.readStream(accessor, path)) actual += decode(chunk)
      expect(actual).toBe(expected)
      expect(countDocuments).not.toHaveBeenCalled()
      expect(getIndexStats).not.toHaveBeenCalled()
    },
  )

  it('does not prefetch the collection when a consumer stops after one document', async () => {
    let consumed = 0
    let closed = false
    const driver = stubMongoDriver({
      listDatabases: () => Promise.resolve(['app']),
      listCollections: () => Promise.resolve(['users']),
      async *iterDocuments<T>() {
        try {
          for (let i = 0; i < 1_000_000; i++) {
            consumed++
            yield await Promise.resolve({ _id: i, value: 'x'.repeat(1024) } as T)
          }
        } finally {
          closed = true
        }
      },
    })
    const accessor = new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
    for await (const chunk of MONGODB_IO.readStream(
      accessor,
      ps('/mongo/app/collections/users/documents.jsonl'),
    )) {
      expect(JSON.parse(decode(chunk)) as { _id: number }).toMatchObject({ _id: 0 })
      break
    }
    expect(consumed).toBe(1)
    expect(closed).toBe(true)
  })
})

it('builds a database manifest with two catalog requests regardless of collection count', async () => {
  const names = Array.from({ length: 5000 }, (_, i) => `collection_${String(i)}`)
  const listCollections = vi.fn((_db: string, kind: string | null = null) =>
    Promise.resolve(kind === 'view' ? ['view'] : names),
  )
  const accessor = new MongoDBAccessor(
    stubMongoDriver({
      listDatabases: () => Promise.resolve(['app']),
      listCollections,
    }),
    resolveMongoDBConfig({ uri: 'mongodb://h' }),
  )
  const result = JSON.parse(decode(await read(accessor, ps('/mongo/app/database.json')))) as {
    collections: unknown[]
    views: { name: string }[]
  }
  expect(result.collections).toHaveLength(5000)
  expect(result.views).toEqual([{ name: 'view' }])
  expect(listCollections).toHaveBeenCalledTimes(2)
})
