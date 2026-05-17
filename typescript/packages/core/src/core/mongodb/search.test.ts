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
  listCollections: vi.fn(),
  listIndexes: vi.fn(),
  findDocuments: vi.fn(),
}))

import { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { resolveMongoDBConfig } from '../../resource/mongodb/config.ts'
import * as _client from './_client.ts'
import { arrayIter, stubMongoDriver } from './_test_util.ts'
import { formatGrepResults, searchCollection, searchDatabase } from './search.ts'

function accessorWith(iterDocs: readonly Record<string, unknown>[] = []): MongoDBAccessor {
  return new MongoDBAccessor(
    stubMongoDriver({ iterDocuments: arrayIter(iterDocs) }),
    resolveMongoDBConfig({ uri: 'mongodb://h' }),
  )
}

beforeEach(() => {
  vi.mocked(_client.findDocuments).mockReset()
  vi.mocked(_client.listIndexes).mockReset()
  vi.mocked(_client.listCollections).mockReset()
})

describe('searchCollection', () => {
  it('uses $text when a text index exists', async () => {
    vi.mocked(_client.listIndexes).mockResolvedValue([{ name: 'body_text', textIndexVersion: 3 }])
    vi.mocked(_client.findDocuments).mockResolvedValue([{ _id: '1', name: 'a' }])
    const out = await searchCollection(accessorWith(), 'app', 'users', 'foo', 5)
    expect(out).toEqual([{ _id: '1', name: 'a' }])
    const call = vi.mocked(_client.findDocuments).mock.calls[0]
    expect(call?.[3]).toEqual({ $text: { $search: 'foo' } })
  })

  it('falls back to $or of $regex over sampled string fields', async () => {
    vi.mocked(_client.listIndexes).mockResolvedValue([{ name: '_id_', key: { _id: 1 } }])
    vi.mocked(_client.findDocuments).mockResolvedValue([{ _id: '1', name: 'foobar' }])
    const acc = accessorWith([{ _id: '1', name: 'x', email: 'y', age: 7 }])
    const out = await searchCollection(acc, 'app', 'users', 'foo', 5)
    expect(out).toEqual([{ _id: '1', name: 'foobar' }])
    const call = vi.mocked(_client.findDocuments).mock.calls[0]
    expect(call?.[3]).toEqual({
      $or: [
        { email: { $regex: 'foo', $options: 'i' } },
        { name: { $regex: 'foo', $options: 'i' } },
      ],
    })
  })

  it('returns no results when sampled docs have no string fields', async () => {
    vi.mocked(_client.listIndexes).mockResolvedValue([{ name: '_id_', key: { _id: 1 } }])
    const acc = accessorWith([{ _id: '1', i: 0, v: 0 }])
    const out = await searchCollection(acc, 'app', 'numbers', 'foo', 5)
    expect(out).toEqual([])
    expect(_client.findDocuments).not.toHaveBeenCalled()
  })
})

describe('searchDatabase', () => {
  it('walks collections and emits matches', async () => {
    vi.mocked(_client.listCollections).mockResolvedValue(['users', 'orders'])
    vi.mocked(_client.listIndexes).mockResolvedValue([{ name: 'body_text', textIndexVersion: 3 }])
    vi.mocked(_client.findDocuments)
      .mockResolvedValueOnce([{ _id: '1' }])
      .mockResolvedValueOnce([])
    const out = await searchDatabase(accessorWith(), 'app', 'foo', 5)
    expect(out).toEqual([{ database: 'app', collection: 'users', docs: [{ _id: '1' }] }])
  })
})

describe('formatGrepResults', () => {
  it('emits one line per matching doc with nested-path prefix', () => {
    const lines = formatGrepResults([
      { database: 'app', collection: 'users', docs: [{ _id: '1', name: 'a' }] },
    ])
    expect(lines).toEqual(['app/collections/users/documents.jsonl:{"_id":"1","name":"a"}'])
  })
})
