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
import { S3Accessor } from '../../accessor/s3.ts'
import { FileChangeKind, PathSpec } from '../../types.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { S3EventHook } from './watch.ts'

const ROOT = PathSpec.fromStrPath('/s3', '')

function record(bucket: string, key: string, versionId?: string) {
  const object = versionId === undefined ? { key } : { key, versionId }
  return { s3: { bucket: { name: bucket }, object } }
}

// Twin of test_records_map_onto_the_mount: a key is URL-encoded with + for a
// space; one the hook has mapped is an UPDATE, a marker removed leaves its
// directory UNKNOWN, a version removed leaves its key UNKNOWN while a delete
// marker deletes it, and a record for another bucket or outside the key prefix
// maps nothing.
describe('S3EventHook', () => {
  it('maps records onto the mount', async () => {
    const hook = new S3EventHook(new S3Accessor({ bucket: 'b', keyPrefix: 'data/' } as S3Config))
    const records: [string, ReturnType<typeof record>][] = [
      ['ObjectCreated:Put', record('b', 'data/a+b%2B.txt')],
      ['ObjectCreated:CompleteMultipartUpload', record('b', 'data/a+b%2B.txt')],
      ['ObjectRemoved:Delete', record('b', 'data/a+b%2B.txt')],
      ['ObjectCreated:Put', record('other', 'data/x')],
      ['ObjectCreated:Put', record('b', 'logs/x')],
      ['ObjectCreated:Put', record('b', 'data/dir/')],
      ['ObjectRemoved:DeleteMarkerCreated', record('b', 'data/dir/')],
      ['ObjectRemoved:Delete', record('b', 'data/v.txt', '3HL4kqtJ')],
      ['LifecycleExpiration:Delete', record('b', 'data/v.txt', 'null')],
      ['ObjectRemoved:DeleteMarkerCreated', record('b', 'data/v.txt', '9xYz')],
    ]
    const pairs: [string, string][] = []
    for (const [name, body] of records) {
      for (const event of await hook.toEvents(ROOT, name, body)) {
        pairs.push([event.kind, event.path.virtual])
      }
    }
    expect(pairs).toEqual([
      [FileChangeKind.CREATE, '/s3/a b+.txt'],
      [FileChangeKind.UPDATE, '/s3/a b+.txt'],
      [FileChangeKind.DELETE, '/s3/a b+.txt'],
      [FileChangeKind.CREATE, '/s3/dir'],
      [FileChangeKind.UNKNOWN, '/s3/dir'],
      [FileChangeKind.UNKNOWN, '/s3/v.txt'],
      [FileChangeKind.UNKNOWN, '/s3/v.txt'],
      [FileChangeKind.DELETE, '/s3/v.txt'],
    ])
  })
})
