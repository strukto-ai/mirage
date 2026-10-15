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
import { FileChangeKind, PathSpec } from '../../types.ts'
import { resolveMongoDBConfig } from '../../vfs/mongodb/config.ts'
import { stubMongoDriver } from './_test_util.ts'
import type { MongoDriver } from './_driver.ts'
import { CHANGE_STREAM_UNSUPPORTED, HISTORY_LOST } from './types.ts'
import { buildDeltaHook } from './watch.ts'

const ROOT = PathSpec.fromStrPath('/m', '')
const TOKEN = { _data: '8201' }
const NEXT = { _data: '8202' }

function hook(overrides: Partial<MongoDriver>, databases?: string[]) {
  const driver = stubMongoDriver(overrides)
  return buildDeltaHook(
    new MongoDBAccessor(
      driver,
      resolveMongoDBConfig({
        uri: 'mongodb://h',
        ...(databases === undefined ? {} : { databases }),
      }),
    ),
  )
}

function event(kind: string, coll = 'books', db = 'lib', extra: Record<string, unknown> = {}) {
  return { operationType: kind, ns: { db, coll }, ...extra }
}

function failure(code: number): Error {
  return Object.assign(new Error('failed'), { code })
}

describe('MongoDBDeltaHook', () => {
  // Twin of test_a_baseline_marks_the_stream_and_reports_nothing.
  it('marks the stream on a baseline and reports nothing', async () => {
    const calls: unknown[][] = []
    const delta = await hook({
      drainChanges: (...args) => {
        calls.push(args)
        return Promise.resolve([[], TOKEN])
      },
    }).pull(ROOT, null)
    expect(delta.changes).toEqual([])
    expect(JSON.parse(delta.checkpoint ?? '')).toEqual({ mongodb: TOKEN })
    expect(calls[0]?.slice(0, 2)).toEqual([null, null])
  })

  // Twin of test_events_name_the_files_they_change.
  it('names the files events change', async () => {
    const events = [
      event('create', 'books'),
      event('insert', 'books'),
      event('update', 'books'),
      event('create', 'recent', 'lib', { operationDescription: { viewOn: 'books' } }),
      event('createIndexes', 'books'),
      event('modify', 'recent', 'lib', { operationDescription: { viewOn: 'books', pipeline: [] } }),
      event('insert', 'old'),
      event('rename', 'old', 'lib', { to: { db: 'lib', coll: 'new' } }),
      event('insert', 'hidden', 'admin'),
      event('insert', 'logs', 'other'),
    ]
    const delta = await hook(
      {
        drainChanges: () => Promise.resolve([events, NEXT]),
        listCollections: () => Promise.resolve(['recent']),
      },
      ['lib'],
    ).pull(ROOT, JSON.stringify({ mongodb: TOKEN }))
    // A write also rewrites the schema.json sampled from the documents, and a
    // collection created, dropped or renamed the database.json listing it.
    expect(delta.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      [FileChangeKind.CREATE, '/m/lib/collections/books'],
      [FileChangeKind.UPDATE, '/m/lib/database.json'],
      [FileChangeKind.UPDATE, '/m/lib/collections/books/documents.jsonl'],
      [FileChangeKind.UPDATE, '/m/lib/collections/books/schema.json'],
      [FileChangeKind.CREATE, '/m/lib/views/recent'],
      [FileChangeKind.UPDATE, '/m/lib/views/recent/schema.json'],
      [FileChangeKind.UPDATE, '/m/lib/views/recent/documents.jsonl'],
      [FileChangeKind.DELETE, '/m/lib/collections/old'],
      [FileChangeKind.CREATE, '/m/lib/collections/new'],
    ])
    expect(JSON.parse(delta.checkpoint ?? '')).toEqual({ mongodb: NEXT })
  })

  // Twin of test_a_watch_below_a_dropped_collection_sees_its_root_go.
  it('tells a watch below a dropped collection its root went', async () => {
    const root = PathSpec.fromStrPath(
      '/m/lib/collections/books/documents.jsonl',
      'lib/collections/books/documents.jsonl',
    )
    const delta = await hook({
      drainChanges: () => Promise.resolve([[event('drop', 'books')], NEXT]),
    }).pull(root, JSON.stringify({ mongodb: TOKEN }))
    expect(delta.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      [FileChangeKind.DELETE, '/m/lib/collections/books/documents.jsonl'],
    ])
  })

  // Twin of test_a_lost_position_reinventories_the_root.
  it('reinventories the root when its position is lost', async () => {
    let first = true
    const delta = await hook({
      drainChanges: () => {
        if (first) {
          first = false
          return Promise.reject(failure(HISTORY_LOST))
        }
        return Promise.resolve([[], NEXT])
      },
    }).pull(ROOT, JSON.stringify({ mongodb: TOKEN }))
    expect(delta.changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      [FileChangeKind.UNKNOWN, '/m'],
    ])
    expect(JSON.parse(delta.checkpoint ?? '')).toEqual({ mongodb: NEXT })
  })

  // Twin of test_a_server_outside_a_replica_set_refuses_the_watch.
  it('refuses the watch on a server outside a replica set', async () => {
    await expect(
      hook({ drainChanges: () => Promise.reject(failure(CHANGE_STREAM_UNSUPPORTED)) }).pull(
        ROOT,
        null,
      ),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
  })
})
