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

import {
  IndexType,
  type IndexConfig,
  type RedisIndexConfig,
} from '@struktoai/mirage-core/cache/index/config'
import { ConsistencyPolicy, MountMode } from '@struktoai/mirage-core/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace.ts'
import type { S3Config } from './config.ts'
import { installS3Mock, type S3Mock } from './mock.ts'
import { S3VFS } from './s3.ts'

const BUCKET = 'cons-bucket'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function makeConfig(): S3Config {
  return {
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
    forcePathStyle: true,
  }
}

describe('S3 cache consistency (mocked)', () => {
  let mock: S3Mock

  beforeAll(() => {
    mock = installS3Mock()
  })

  beforeEach(() => {
    mock.store.set(BUCKET, 'c.txt', ENC.encode('v1'))
  })

  afterEach(() => {
    for (const b of mock.store.allBuckets()) mock.store.objects(b).clear()
  })

  afterAll(() => {
    mock.restore()
  })

  for (const type of [IndexType.RAM, IndexType.REDIS]) {
    it
      .skipIf(type === IndexType.REDIS && process.env.REDIS_URL === undefined)
      .each(['shell', 'fs'])(`ALWAYS checks a warm ${type} index via %s`, async (surface) => {
      const index: IndexConfig | RedisIndexConfig =
        type === IndexType.REDIS
          ? {
              type,
              ...(process.env.REDIS_URL === undefined ? {} : { url: process.env.REDIS_URL }),
              keyPrefix: `consistency:${crypto.randomUUID()}:`,
            }
          : { type }
      const ws = new Workspace(
        { '/s3/': new S3VFS(makeConfig()) },
        {
          mode: MountMode.WRITE,
          consistency: ConsistencyPolicy.ALWAYS,
          index,
        },
      )
      const store = ws.mount('/s3/').indexStore
      try {
        expect((await ws.shell('ls /s3/')).exitCode).toBe(0)
        expect((await store.get('/s3/c.txt')).entry).toBeDefined()
        expect(DEC.decode((await ws.shell('cat /s3/c.txt')).stdout)).toBe('v1')
        expect(await ws.cache.exists('/s3/c.txt')).toBe(true)
        mock.store.set(BUCKET, 'c.txt', ENC.encode('v2'))
        if (surface === 'shell') {
          expect(DEC.decode((await ws.shell('cat /s3/c.txt')).stdout)).toBe('v2')
        } else {
          expect(DEC.decode(await ws.vfs.readFile('/s3/c.txt'))).toBe('v2')
        }
        mock.store.objects(BUCKET).delete('c.txt')
        if (surface === 'shell') {
          const result = await ws.shell('cat /s3/c.txt')
          expect(result.exitCode).toBe(1)
          expect(result.stdout.byteLength).toBe(0)
        } else {
          await expect(ws.vfs.readFile('/s3/c.txt')).rejects.toMatchObject({ code: 'ENOENT' })
        }
      } finally {
        await store.clear()
        await ws.close()
      }
    })
  }

  it('LAZY keeps serving the cached bytes after an out-of-band change', async () => {
    const ws = new Workspace(
      { '/s3/': new S3VFS(makeConfig()) },
      { mode: MountMode.WRITE, consistency: ConsistencyPolicy.LAZY },
    )
    const first = await ws.shell('cat /s3/c.txt')
    expect(DEC.decode(first.stdout)).toBe('v1')
    mock.store.set(BUCKET, 'c.txt', ENC.encode('v2'))
    const second = await ws.shell('cat /s3/c.txt')
    expect(DEC.decode(second.stdout)).toBe('v1')
    await ws.close()
  })
  it('keeps stat type=text after tee and touch', async () => {
    const ws = new Workspace({ '/s3': new S3VFS(makeConfig()) }, { mode: MountMode.WRITE })
    try {
      const result = await ws.shell('tee /s3/c.txt <<< x; touch /s3/c.txt; stat /s3/c.txt')
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toContain('name=c.txt size=2')
      expect(DEC.decode(result.stdout)).toContain('type=text')
    } finally {
      await ws.close()
    }
  })
})
