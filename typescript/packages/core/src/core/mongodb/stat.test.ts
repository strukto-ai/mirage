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
import { FileType, PathSpec } from '../../types.ts'
import { stat } from './stat.ts'
import { stubMongoDriver } from './_test_util.ts'

function ps(p: string): PathSpec {
  return new PathSpec({ original: p, directory: p, prefix: '/mongo' })
}

function accessor(overrides: Partial<Parameters<typeof stubMongoDriver>[0]> = {}) {
  return new MongoDBAccessor(
    stubMongoDriver({
      listDatabases: () => Promise.resolve(['app']),
      listCollections: (_db, kind) => Promise.resolve(kind === 'view' ? ['recent'] : ['users']),
      ...overrides,
    }),
    resolveMongoDBConfig({ uri: 'mongodb://h' }),
  )
}

describe('stat', () => {
  it('marks root as DIRECTORY', async () => {
    const r = await stat(accessor(), ps('/mongo/'))
    expect(r.name).toBe('/')
    expect(r.type).toBe(FileType.DIRECTORY)
  })

  it('marks database level as DIRECTORY with extras', async () => {
    const r = await stat(accessor(), ps('/mongo/app'))
    expect(r.type).toBe(FileType.DIRECTORY)
    expect(r.extra).toEqual({ database: 'app' })
  })

  it('marks kind_dir as DIRECTORY with kind extra', async () => {
    const r = await stat(accessor(), ps('/mongo/app/collections'))
    expect(r.type).toBe(FileType.DIRECTORY)
    expect(r.name).toBe('collections')
    expect(r.extra).toMatchObject({ database: 'app', kind: 'collection' })
  })

  it('marks entity (collection dir) as DIRECTORY with document_count', async () => {
    const r = await stat(
      accessor({ countDocuments: () => Promise.resolve(42) }),
      ps('/mongo/app/collections/users'),
    )
    expect(r.type).toBe(FileType.DIRECTORY)
    expect(r.name).toBe('users')
    expect(r.extra).toMatchObject({
      database: 'app',
      kind: 'collection',
      name: 'users',
      document_count: 42,
    })
  })

  it('marks documents.jsonl as TEXT with indexes for a collection', async () => {
    const r = await stat(
      accessor({
        countDocuments: () => Promise.resolve(42),
        listCollectionsDetailed: () => Promise.resolve([{ name: 'users', type: 'collection' }]),
        listIndexes: () => Promise.resolve([{ name: '_id_', key: { _id: 1 } }]),
      }),
      ps('/mongo/app/collections/users/documents.jsonl'),
    )
    expect(r.type).toBe(FileType.TEXT)
    expect(r.size).toBeNull()
    expect(r.extra.document_count).toBe(42)
    expect(r.extra.indexes).toEqual([{ name: '_id_', keys: { _id: 1 } }])
  })

  it('marks documents.jsonl as TEXT but with no indexes for a view', async () => {
    const r = await stat(
      accessor({
        countDocuments: () => Promise.resolve(10),
        listCollectionsDetailed: () => Promise.resolve([{ name: 'recent', type: 'view' }]),
      }),
      ps('/mongo/app/views/recent/documents.jsonl'),
    )
    expect(r.type).toBe(FileType.TEXT)
    expect(r.extra.indexes).toEqual([])
    expect(r.extra.kind).toBe('view')
  })

  it('marks schema.json as TEXT', async () => {
    const r = await stat(accessor(), ps('/mongo/app/collections/users/schema.json'))
    expect(r.type).toBe(FileType.TEXT)
    expect(r.name).toBe('schema.json')
  })

  it('marks database.json as TEXT', async () => {
    const r = await stat(accessor(), ps('/mongo/app/database.json'))
    expect(r.type).toBe(FileType.TEXT)
    expect(r.name).toBe('database.json')
  })

  it('throws ENOENT for unrecognized paths', async () => {
    await expect(stat(accessor(), ps('/mongo/app/foo'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT for a nonexistent database', async () => {
    await expect(stat(accessor(), ps('/mongo/ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT for a nonexistent collection under a real database', async () => {
    await expect(stat(accessor(), ps('/mongo/app/collections/ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT for documents.jsonl under a nonexistent collection', async () => {
    await expect(
      stat(accessor(), ps('/mongo/app/collections/ghost/documents.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
