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

import { createHash } from 'node:crypto'
import { ConsistencyPolicy, MountMode } from '@struktoai/mirage-core/types'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { S3Config } from '../vfs/s3/config.ts'
import { installS3Mock, type S3Mock } from '../vfs/s3/mock.ts'
import { S3VFS } from '../vfs/s3/s3.ts'
import { Workspace } from '../workspace.ts'

const BUCKET = 'wf-bucket'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

// Non-empty suffix: the mock's ETag is then NOT md5(content), the way a
// multipart or SSE-KMS upload's is not, so a cache entry carrying the
// backend's token is distinguishable from one carrying the md5 default.
const SUFFIX = '-2'

function etagOf(data: string): string {
  return createHash('md5').update(data).digest('hex') + SUFFIX
}

function makeConfig(): S3Config {
  return {
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
    forcePathStyle: true,
  }
}

function makeWorkspace(consistency: ConsistencyPolicy): Workspace {
  return new Workspace({ '/s3': new S3VFS(makeConfig()) }, { mode: MountMode.WRITE, consistency })
}

describe('object-store write fingerprint (mocked S3)', () => {
  let mock: S3Mock

  beforeAll(() => {
    mock = installS3Mock(undefined, { etagSuffix: SUFFIX })
  })

  afterEach(() => {
    // Only the store and the counters: `reset()` clears the registered
    // command behaviours too, which would leave the mock inert.
    for (const b of mock.store.allBuckets()) mock.store.objects(b).clear()
    mock.calls.clear()
  })

  afterAll(() => {
    mock.restore()
  })

  it('the write record carries the backend token', async () => {
    const ws = makeWorkspace(ConsistencyPolicy.LAZY)
    try {
      await ws.shell('tee /s3/x.txt <<< hello')
      expect(ws.records.map((r) => [r.op, r.path, r.fingerprint])).toEqual([
        ['write', '/s3/x.txt', etagOf('hello\n')],
      ])
    } finally {
      await ws.close()
    }
  })

  it('a written path caches the backend token, not md5', async () => {
    // Holding md5(content) is only right by accident on a simple-PUT
    // object, and never right on a multipart one.
    const ws = makeWorkspace(ConsistencyPolicy.LAZY)
    try {
      await ws.shell('tee /s3/x.txt <<< hello')
      expect(await ws.cache.isFresh('/s3/x.txt', etagOf('hello\n'))).toBe(true)
      expect(
        await ws.cache.isFresh('/s3/x.txt', createHash('md5').update('hello\n').digest('hex')),
      ).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it('ALWAYS reads a written path from cache', async () => {
    // The cost assertion. With the backend's token on the entry the
    // freshness probe matches and the read is served from cache; with the
    // md5 default it never matches a suffixed ETag, so every read evicts
    // and refetches.
    const ws = makeWorkspace(ConsistencyPolicy.ALWAYS)
    try {
      await ws.shell('tee /s3/x.txt <<< hello')
      const read = await ws.shell('cat /s3/x.txt')
      expect(DEC.decode(read.stdout)).toBe('hello\n')
      expect(mock.calls.get('HeadObject') ?? 0).toBeGreaterThanOrEqual(1)
      expect(mock.calls.get('GetObject') ?? 0).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('read-then-write on one line keeps the read token', async () => {
    // `IOResult.merge` unions a line's reads and writes, and applyIo
    // caches the read's bytes. If those bytes were stamped with the
    // write's token the entry would read as fresh forever and the stale
    // bytes would serve; the next read must see the written content.
    mock.store.set(BUCKET, 'f.txt', ENC.encode('old\n'))
    const ws = makeWorkspace(ConsistencyPolicy.ALWAYS)
    try {
      await ws.shell('cat /s3/f.txt && echo new | tee /s3/f.txt')
      const read = await ws.shell('cat /s3/f.txt')
      expect(DEC.decode(mock.store.get(BUCKET, 'f.txt') ?? new Uint8Array())).toBe('new\n')
      expect(DEC.decode(read.stdout)).toBe('new\n')
    } finally {
      await ws.close()
    }
  })

  it('write then truncate on one line does not pin stale bytes', async () => {
    // `truncate` records its own token but hands the cache no bytes, so
    // the entry would otherwise hold tee's content under truncate's
    // token and serve it for the life of the entry.
    const ws = makeWorkspace(ConsistencyPolicy.ALWAYS)
    try {
      await ws.shell('echo hello | tee /s3/f.txt && truncate -s 2 /s3/f.txt')
      const read = await ws.shell('cat /s3/f.txt')
      expect(DEC.decode(mock.store.get(BUCKET, 'f.txt') ?? new Uint8Array())).toBe('he')
      expect(DEC.decode(read.stdout)).toBe('he')
    } finally {
      await ws.close()
    }
  })

  it('write then copy over it does not pin stale bytes', async () => {
    // `cp` replaces the path's entry in IOResult.writes with an empty
    // eviction marker while tee's write record stays the last one, so
    // the token would land on bytes it does not describe.
    mock.store.set(BUCKET, 'a.txt', ENC.encode('x\n'))
    const ws = makeWorkspace(ConsistencyPolicy.ALWAYS)
    try {
      await ws.shell('echo x | tee /s3/f.txt && cp /s3/a.txt /s3/f.txt')
      const read = await ws.shell('cat /s3/f.txt')
      expect(DEC.decode(mock.store.get(BUCKET, 'f.txt') ?? new Uint8Array())).toBe('x\n')
      expect(DEC.decode(read.stdout)).toBe('x\n')
    } finally {
      await ws.close()
    }
  })
})
