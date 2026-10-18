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
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client.ts', () => ({
  listDatabases: vi.fn(),
  listCollections: vi.fn(),
  databaseExists: vi.fn(),
  entityExists: vi.fn(),
}))

import { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { resolveMongoDBConfig } from '../../vfs/mongodb/config.ts'
import { PathSpec, type DirListing, type FileStat } from '../../types.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import * as client from './client.ts'
import { stubMongoDriver } from '../../../tests/core/mongodb/_test_util.ts'
import { readdir } from './readdir.ts'

function names(listed: readonly FileStat[] | DirListing): string[] {
  return rowsOf(listed).map((row) => row.name)
}

const STUB_DRIVER = stubMongoDriver()

function makeAccessor(): MongoDBAccessor {
  return new MongoDBAccessor(STUB_DRIVER, resolveMongoDBConfig({ uri: 'mongodb://h' }))
}

function ps(p: string): PathSpec {
  return new PathSpec({ virtual: p, directory: p, vfsPath: mountKey(p, '/mongo') })
}

describe('readdir', () => {
  beforeEach(() => {
    vi.mocked(client.databaseExists).mockResolvedValue(true)
    vi.mocked(client.entityExists).mockResolvedValue(true)
  })

  it('lists root: databases', async () => {
    vi.mocked(client.listDatabases).mockResolvedValue(['app', 'analytics'])
    const out = await readdir(makeAccessor(), ps('/mongo/'))
    expect(names(out)).toEqual(['app', 'analytics'])
  })

  it('lists database: fixed [database.json, collections, views]', async () => {
    const out = await readdir(makeAccessor(), ps('/mongo/app'))
    expect(names(out)).toEqual(['database.json', 'collections', 'views'])
  })

  it('lists kind_dir (collections): collection names', async () => {
    vi.mocked(client.listCollections).mockResolvedValue(['users', 'orders'])
    const out = await readdir(makeAccessor(), ps('/mongo/app/collections'))
    expect(names(out)).toEqual(['users', 'orders'])
  })

  it('lists kind_dir (views): view names', async () => {
    vi.mocked(client.listCollections).mockResolvedValue(['recent'])
    const out = await readdir(makeAccessor(), ps('/mongo/app/views'))
    expect(names(out)).toEqual(['recent'])
  })

  it('lists entity (collection): [schema.json, documents.jsonl]', async () => {
    const out = await readdir(makeAccessor(), ps('/mongo/app/collections/users'))
    expect(names(out)).toEqual(['schema.json', 'documents.jsonl'])
  })

  it('throws ENOENT for documents-leaf paths', async () => {
    await expect(
      readdir(makeAccessor(), ps('/mongo/app/collections/users/documents.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT when database does not exist', async () => {
    vi.mocked(client.databaseExists).mockResolvedValue(false)
    await expect(readdir(makeAccessor(), ps('/mongo/ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOENT when collection does not exist', async () => {
    vi.mocked(client.entityExists).mockResolvedValue(false)
    await expect(readdir(makeAccessor(), ps('/mongo/app/collections/ghost'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
  })
})
