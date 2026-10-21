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

import { OpRecord } from '../../observe/record.ts'
import { latestFingerprint } from './io.ts'

function opRecord(op: string, path: string, fingerprint: string | null, nbytes = 0): OpRecord {
  return new OpRecord({
    op,
    path,
    source: 's3',
    bytes: nbytes,
    timestamp: 0,
    durationMs: 0,
    fingerprint,
  })
}

describe('latestFingerprint', () => {
  it('reads only reads', () => {
    // A write's own record labels the bytes it sent; here it would stamp
    // the write's token onto bytes a read produced, and the entry would
    // read as fresh forever.
    const records = [
      opRecord('read', '/s3/f.txt', 'etag-1', 3),
      opRecord('write', '/s3/f.txt', 'etag-2', 3),
      opRecord('readdir', '/s3/f.txt', 'etag-3', 3),
    ]
    expect(latestFingerprint(records, '/s3/f.txt')).toBe('etag-1')
  })

  it('stops at a newer read without a token', () => {
    // One line read the path twice and the backend vouched only for the
    // first: the bytes stored are the second read's.
    const records = [
      opRecord('read', '/m/f.txt', 'token-a', 3),
      opRecord('read', '/m/f.txt', null, 3),
    ]
    expect(latestFingerprint(records, '/m/f.txt')).toBeNull()
  })
})
