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
import { FileChangeKind, type JsonValue, PathSpec } from '../../types.ts'
import { resolveMongoDBConfig } from '../../vfs/mongodb/config.ts'
import { stubMongoDriver } from './_test_util.ts'
import { MongoDBEventHook } from './watch.ts'

const ROOT = PathSpec.fromStrPath('/m', '')
const U = FileChangeKind.UPDATE
const C = FileChangeKind.CREATE
const D = FileChangeKind.DELETE

function hook(listed: string[][], databases?: string[]): MongoDBEventHook {
  const driver = stubMongoDriver({
    listCollections: () => {
      listed.push([])
      return Promise.resolve(['recent'])
    },
  })
  return new MongoDBEventHook(
    new MongoDBAccessor(
      driver,
      resolveMongoDBConfig({
        uri: 'mongodb://h',
        ...(databases === undefined ? {} : { databases }),
      }),
    ),
  )
}

function event(kind: string, coll = 'books', db = 'lib', extra: Record<string, JsonValue> = {}) {
  return { operationType: kind, ns: { db, coll }, ...extra }
}

async function pairs(
  target: MongoDBEventHook,
  kind: string,
  body: JsonValue,
): Promise<[string, string][]> {
  return (await target.toEvents(ROOT, kind, body)).map((e) => [e.kind, e.path.virtual])
}

describe('MongoDBEventHook', () => {
  // Twin of test_events_name_the_files_they_change: a write rewrites the
  // documents and the schema sampled from them, and both files of each view;
  // a collection created, renamed or dropped is its directory and its
  // database's database.json. The views are listed once, and again after an
  // event that changes them.
  it('names the files each event changes', async () => {
    const listed: string[][] = []
    const target = hook(listed, ['lib'])
    const steps = [
      event('insert', 'books'),
      event('update', 'books'),
      event('create', 'recent', 'lib', { operationDescription: { viewOn: 'books' } }),
      event('modify', 'recent', 'lib', { operationDescription: { viewOn: 'books', pipeline: [] } }),
      event('createIndexes', 'books'),
      event('rename', 'old', 'lib', { to: { db: 'lib', coll: 'new' } }),
      event('delete', 'books'),
      event('insert', 'hidden', 'admin'),
      event('insert', 'logs', 'other'),
    ]
    const got: [string, string][][] = []
    for (const step of steps) got.push(await pairs(target, step.operationType, step))
    const written = [
      [U, '/m/lib/collections/books/documents.jsonl'],
      [U, '/m/lib/collections/books/schema.json'],
      [U, '/m/lib/views/recent/documents.jsonl'],
      [U, '/m/lib/views/recent/schema.json'],
    ]
    expect(got).toEqual([
      written,
      written,
      [
        [C, '/m/lib/views/recent'],
        [U, '/m/lib/database.json'],
      ],
      [
        [U, '/m/lib/views/recent/schema.json'],
        [U, '/m/lib/views/recent/documents.jsonl'],
      ],
      [[U, '/m/lib/collections/books/schema.json']],
      [
        [D, '/m/lib/collections/old'],
        [U, '/m/lib/database.json'],
        [C, '/m/lib/collections/new'],
      ],
      written,
      [],
      [],
    ])
    expect(listed).toHaveLength(2)
  })

  // Twin of test_a_dropped_database_leaves_and_an_invalidated_stream_is_unknown.
  it('drops a database and calls an invalidated stream unknown', async () => {
    const target = hook([])
    expect([
      ...(await pairs(target, 'dropDatabase', { ns: { db: 'lib' } })),
      ...(await pairs(target, 'invalidate', {})),
    ]).toEqual([
      [D, '/m/lib'],
      [FileChangeKind.UNKNOWN, '/m'],
    ])
  })
})
