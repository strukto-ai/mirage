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

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./_client.ts', () => ({
  listDatabases: vi.fn(),
  listCollections: vi.fn(),
  databaseExists: vi.fn(),
  entityExists: vi.fn(),
}))

import { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { resolveMongoDBConfig } from '../../resource/mongodb/config.ts'
import { PathSpec } from '../../types.ts'
import * as _client from './_client.ts'
import { stubMongoDriver } from './_test_util.ts'
import { readdir } from './readdir.ts'

const STUB_DRIVER = stubMongoDriver()

function makeAccessor(): MongoDBAccessor {
  return new MongoDBAccessor(STUB_DRIVER, resolveMongoDBConfig({ uri: 'mongodb://h' }))
}

function ps(p: string): PathSpec {
  return new PathSpec({ original: p, directory: p, prefix: '/mongo' })
}

describe('readdir', () => {
  beforeEach(() => {
    vi.mocked(_client.databaseExists).mockResolvedValue(true)
    vi.mocked(_client.entityExists).mockResolvedValue(true)
  })

  it('lists root: databases', async () => {
    vi.mocked(_client.listDatabases).mockResolvedValue(['app', 'analytics'])
    const out = await readdir(makeAccessor(), ps('/mongo/'))
    expect(out).toEqual(['/mongo/app', '/mongo/analytics'])
  })

  it('lists database: fixed [database.json, collections, views]', async () => {
    const out = await readdir(makeAccessor(), ps('/mongo/app'))
    expect(out).toEqual(['/mongo/app/database.json', '/mongo/app/collections', '/mongo/app/views'])
  })

  it('lists kind_dir (collections): collection names', async () => {
    vi.mocked(_client.listCollections).mockResolvedValue(['users', 'orders'])
    const out = await readdir(makeAccessor(), ps('/mongo/app/collections'))
    expect(out).toEqual(['/mongo/app/collections/users', '/mongo/app/collections/orders'])
  })

  it('lists kind_dir (views): view names', async () => {
    vi.mocked(_client.listCollections).mockResolvedValue(['recent'])
    const out = await readdir(makeAccessor(), ps('/mongo/app/views'))
    expect(out).toEqual(['/mongo/app/views/recent'])
  })

  it('lists entity (collection): [schema.json, documents.jsonl]', async () => {
    const out = await readdir(makeAccessor(), ps('/mongo/app/collections/users'))
    expect(out).toEqual([
      '/mongo/app/collections/users/schema.json',
      '/mongo/app/collections/users/documents.jsonl',
    ])
  })

  it('caches root listing in index when provided', async () => {
    vi.mocked(_client.listDatabases).mockResolvedValue(['app'])
    const index = new RAMIndexCacheStore()
    const accessor = makeAccessor()
    await readdir(accessor, ps('/mongo/'), index)
    vi.mocked(_client.listDatabases).mockClear()
    await readdir(accessor, ps('/mongo/'), index)
    expect(_client.listDatabases).not.toHaveBeenCalled()
  })

  it('throws ENOENT for documents-leaf paths', async () => {
    await expect(
      readdir(makeAccessor(), ps('/mongo/app/collections/users/documents.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT when database does not exist', async () => {
    vi.mocked(_client.databaseExists).mockResolvedValue(false)
    await expect(readdir(makeAccessor(), ps('/mongo/ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT when collection does not exist', async () => {
    vi.mocked(_client.entityExists).mockResolvedValue(false)
    await expect(readdir(makeAccessor(), ps('/mongo/app/collections/ghost'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
  })
})
