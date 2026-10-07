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

import { describe, expect, it, vi } from 'vitest'

vi.mock('./_schema_json.ts', () => ({
  buildCollectionSchemaJson: vi.fn(() => Promise.resolve({ fields: { year: 'int' } })),
  buildDatabaseJson: vi.fn(() => Promise.resolve({ database: 'app' })),
}))

import { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { resolveMongoDBConfig } from '../../vfs/mongodb/config.ts'
import type { GrepSearchOptions } from '../../commands/builtin/types.ts'
import { arrayIter, stubMongoDriver } from './_test_util.ts'
import { detectScope } from './scope.ts'
import { SEARCHERS } from './search.ts'
import { EntityKind } from './types.ts'

const DOCS: Record<string, Record<string, unknown>[]> = {
  books: [
    { _id: 1, title: 'Ada', year: 2020 },
    { _id: 2, title: 'ada', year: 2021 },
  ],
  recent: [{ _id: 3, title: 'Ada live', year: 2022 }],
}

function accessor(docs: Record<string, Record<string, unknown>[]> = DOCS): MongoDBAccessor {
  const driver = stubMongoDriver({
    listDatabases: () => Promise.resolve(['app']),
    listCollections: (_database, kind) =>
      Promise.resolve(
        kind === EntityKind.VIEW
          ? ['recent']
          : kind === EntityKind.COLLECTION
            ? ['books']
            : ['books', 'recent'],
      ),
    iterDocuments: <T>(_database: string, collection: string) =>
      arrayIter(docs[collection] ?? [])<T>(),
  })
  return new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
}

async function search(
  path: string,
  pattern: string,
  flags: Partial<GrepSearchOptions> = {},
  acc: MongoDBAccessor = accessor(),
): Promise<string[]> {
  const match = detectScope(path)
  const searcher = SEARCHERS[match.kind]
  if (searcher === undefined) throw new Error(`no searcher for ${match.kind}`)
  const results = await searcher(acc, match, {
    query: pattern,
    options: {
      grep: {
        ignore_case: flags.ignoreCase ?? false,
        fixed_string: flags.fixedString ?? false,
        whole_word: flags.wholeWord ?? false,
        syntax: flags.syntax ?? 'basic',
      },
    },
  })
  return results.map(([, text]) => text)
}

describe('mongodb directory search', () => {
  // The $regex ran only over string fields sampled from 100 documents, so a
  // number (or an ObjectId, a date, a key) never matched, while grep over
  // documents.jsonl found it.
  it('matches a number as the line spells it', async () => {
    expect(await search('/app/collections/books', '2020')).toEqual([
      'app/collections/books/documents.jsonl:{"_id": 1, "title": "Ada", "year": 2020}',
    ])
  })

  // `$options: "i"` folded case whatever -i said.
  it('folds case only under -i', async () => {
    expect(await search('/app/collections/books', 'Ada')).toHaveLength(1)
    expect(await search('/app/collections/books', 'Ada', { ignoreCase: true })).toHaveLength(2)
  })

  it('covers views and the metadata files of a database', async () => {
    const lines = await search('/app', 'year')
    expect(lines.map((line) => line.split(':')[0])).toEqual([
      'app/collections/books/documents.jsonl',
      'app/collections/books/documents.jsonl',
      'app/collections/books/schema.json',
      'app/views/recent/documents.jsonl',
      'app/views/recent/schema.json',
    ])
    expect(await search('/app', '"database": "app"')).toEqual([
      'app/database.json:{"database": "app"}',
    ])
  })

  // It stopped at `defaultSearchLimit` documents per collection.
  it('has no result cap', async () => {
    const many = { books: Array.from({ length: 150 }, (_, i) => ({ _id: i, n: 'x' })) }
    expect(await search('/app/collections/books', '"x"', {}, accessor(many))).toHaveLength(150)
  })

  it.each(['/app', '/'])(
    'aggregates large results at %s',
    async (path) => {
      const many = { books: Array.from({ length: 200_000 }, (_, i) => ({ _id: i, n: 'x' })) }
      const lines = await search(path, '"x"', {}, accessor(many))
      expect(lines).toHaveLength(200_000)
      expect(lines[0]).toContain('"_id": 0,')
      expect(lines.at(-1)).toContain('"_id": 199999,')
    },
    20_000,
  )
})
