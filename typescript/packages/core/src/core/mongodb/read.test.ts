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
import { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { resolveMongoDBConfig } from '../../resource/mongodb/config.ts'
import { PathSpec } from '../../types.ts'
import { read } from './read.ts'
import { arrayIter, stubMongoDriver } from './_test_util.ts'

function ps(p: string): PathSpec {
  return new PathSpec({ original: p, directory: p, prefix: '/mongo' })
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
