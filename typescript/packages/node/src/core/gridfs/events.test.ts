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

import { FileChangeKind, type JsonValue, PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

const counts = new Map<string, number>()

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return {
    ...actual,
    filesColl: () =>
      Promise.resolve({
        countDocuments: (query: { filename: string }, options: { limit: number }) =>
          Promise.resolve(Math.min(counts.get(query.filename) ?? 0, options.limit)),
      }),
  }
})

import { GridFSAccessor } from '../../accessor/gridfs.ts'
import type { GridFSConfig } from '../../vfs/gridfs/config.ts'
import { GridFSEventHook } from './events.ts'

const ROOT = PathSpec.fromStrPath('/g', '')
const NS = { db: 'lib', coll: 'fs.files' }

function event(kind: string, ident: number, body: Record<string, JsonValue> = {}): JsonValue {
  return { operationType: kind, ns: NS, documentKey: { _id: ident }, ...body }
}

// Twin of test_revisions_left_decide_each_change: an insert is a CREATE when
// its revision is the only one and an UPDATE otherwise; a delete leaves a
// DELETE, or an UPDATE when an older revision is served again. A rename
// settles both names, and a delete the hook cannot name leaves the mount
// UNKNOWN.
describe('GridFSEventHook', () => {
  it('decides each change by the revisions left', async () => {
    const hook = new GridFSEventHook(
      new GridFSAccessor({
        uri: 'mongodb://x',
        database: 'lib',
        keyPrefix: 'docs/',
      } as GridFSConfig),
    )
    const steps: [Record<string, number>, string, JsonValue][] = [
      [
        { 'docs/a.txt': 1 },
        'insert',
        event('insert', 1, { fullDocument: { filename: 'docs/a.txt' } }),
      ],
      [
        { 'docs/a.txt': 2 },
        'insert',
        event('insert', 2, { fullDocument: { filename: 'docs/a.txt' } }),
      ],
      [{ 'docs/a.txt': 1 }, 'delete', event('delete', 2)],
      [
        { 'docs/a.txt': 0, 'docs/b.txt': 1 },
        'update',
        event('update', 1, { updateDescription: { updatedFields: { filename: 'docs/b.txt' } } }),
      ],
      [{}, 'insert', event('insert', 3, { fullDocument: { filename: 'other/x' } })],
      [{}, 'insert', event('insert', 4, { fullDocument: { filename: 'docs/dir/' } })],
      [{}, 'delete', event('delete', 9)],
      [{}, 'drop', { operationType: 'drop', ns: NS }],
      [{}, 'insert', { operationType: 'insert', ns: { db: 'lib', coll: 'logs' } }],
    ]
    const pairs: [string, string][] = []
    for (const [revisions, kind, body] of steps) {
      for (const [name, count] of Object.entries(revisions)) counts.set(name, count)
      for (const change of await hook.toEvents(ROOT, kind, body)) {
        pairs.push([change.kind, change.path.virtual])
      }
    }
    expect(pairs).toEqual([
      [FileChangeKind.CREATE, '/g/a.txt'],
      [FileChangeKind.UPDATE, '/g/a.txt'],
      [FileChangeKind.UPDATE, '/g/a.txt'],
      [FileChangeKind.DELETE, '/g/a.txt'],
      [FileChangeKind.CREATE, '/g/b.txt'],
      [FileChangeKind.CREATE, '/g/dir'],
      [FileChangeKind.UNKNOWN, '/g'],
      [FileChangeKind.UNKNOWN, '/g'],
    ])
  })

  // Twin of test_a_rename_into_the_trash_settles_only_the_name_left: rm
  // retags a.txt to /trash/a.txt, so the name left behind reads as deleted
  // and the trash, which no path reaches, raises nothing.
  it('settles only the name a trash rename leaves behind', async () => {
    const hook = new GridFSEventHook(
      new GridFSAccessor({ uri: 'mongodb://x', database: 'lib' } as GridFSConfig),
    )
    counts.set('a.txt', 0)
    counts.set('/trash/a.txt', 2)
    const rename = event('update', 1, {
      fullDocumentBeforeChange: { filename: 'a.txt' },
      updateDescription: { updatedFields: { filename: '/trash/a.txt' } },
    })
    const changes = await hook.toEvents(ROOT, 'update', rename)
    expect(changes.map((c) => [c.kind, c.path.virtual])).toEqual([
      [FileChangeKind.DELETE, '/g/a.txt'],
    ])
    const insert = event('insert', 2, { fullDocument: { filename: '/trash/b.txt' } })
    expect(await hook.toEvents(ROOT, 'insert', insert)).toEqual([])
  })
})
