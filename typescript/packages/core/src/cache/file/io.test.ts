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
import type { CacheFacts } from '../../types.ts'
import { latestFingerprint, setCached } from './io.ts'
import { RAMFileCacheStore } from './ram.ts'
import { RefusingStore } from '../_test_util.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

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

function facts(ttl = 60, cacheable = true): (path: string) => CacheFacts {
  return () => ({ cacheable, ttl })
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

describe('setCached', () => {
  it('keeps the bytes with their token and the bound', async () => {
    const cache = new RAMFileCacheStore()
    await setCached(cache, '/s3/f.txt', ENC.encode('hello'), 'etag', facts(45))
    expect(DEC.decode((await cache.get('/s3/f.txt')) ?? new Uint8Array())).toBe('hello')
    expect(await cache.isFresh('/s3/f.txt', 'etag')).toBe(true)
  })

  it('keeps nothing for a path its mount does not cache', async () => {
    const cache = new RAMFileCacheStore()
    await setCached(cache, '/s3/f.txt', ENC.encode('hello'), null, facts(60, false))
    expect(await cache.exists('/s3/f.txt')).toBe(false)
  })

  it('keeps no bytes bigger than the cache', async () => {
    // Bytes bigger than the cache would flush it; the stale copy goes too.
    const cache = new RAMFileCacheStore({ limit: 10 })
    await cache.set('/s3/warm', ENC.encode('abc'))
    await cache.set('/s3/big', ENC.encode('old'))
    await setCached(cache, '/s3/big', ENC.encode('x'.repeat(11)), null, facts())
    expect(await cache.exists('/s3/big')).toBe(false)
    expect(DEC.decode((await cache.get('/s3/warm')) ?? new Uint8Array())).toBe('abc')
  })

  it.each([false, true])(
    'never fails the write on a store that refuses (down=%s)',
    async (down) => {
      // The write landed: a refused fill, or a refused drop too, is no
      // failure, and the stale copy goes when it can.
      const cache = new RefusingStore(down)
      await RAMFileCacheStore.prototype.set.call(cache, '/s3/f', ENC.encode('old'))
      await setCached(cache, '/s3/f', ENC.encode('new'), null, facts())
      if (!down) expect(await cache.exists('/s3/f')).toBe(false)
    },
  )
})
