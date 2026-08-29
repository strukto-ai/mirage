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
import type * as ClientModule from '../../core/s3/client.ts'

vi.mock('../../core/s3/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../../core/s3/client.ts')
  return { ...actual, loadS3Module: vi.fn(), createS3Client: vi.fn() }
})

import { S3Accessor } from '../../accessor/s3.ts'
import type { IndexEntry, ListResult, LookupResult } from '../../cache/index/config.ts'
import { IndexCacheStore } from '../../cache/index/store.ts'
import * as clientMod from '../../core/s3/client.ts'
import type { S3Config } from '../../resource/s3/config.ts'
import { PathSpec } from '../../types.ts'
import { liveIdentityOp } from './identity.ts'

class HeadCmd {
  constructor(readonly input: Record<string, unknown>) {}
}

class ListCmd {
  constructor(readonly input: Record<string, unknown>) {}
}

/** An index cache that fails loudly if the op ever consults it. */
class PoisonIndex extends IndexCacheStore {
  get(_resourcePath: string): Promise<LookupResult> {
    throw new Error('live_identity must not touch index.get')
  }
  put(_resourcePath: string, _entry: IndexEntry): Promise<void> {
    throw new Error('live_identity must not touch index.put')
  }
  listDir(_resourcePath: string): Promise<ListResult> {
    throw new Error('live_identity must not touch index.listDir')
  }
  setDir(): Promise<void> {
    throw new Error('live_identity must not touch index.setDir')
  }
  invalidateDir(_resourcePath: string): Promise<void> {
    throw new Error('live_identity must not touch index.invalidateDir')
  }
  invalidatePrefix(_resourcePath: string): Promise<void> {
    throw new Error('live_identity must not touch index.invalidatePrefix')
  }
  invalidate(): Promise<void> {
    throw new Error('live_identity must not touch index.invalidate')
  }
  clear(): Promise<void> {
    throw new Error('live_identity must not touch index.clear')
  }
}

function mockBucket(objects: { key: string; etag: string }[]): void {
  vi.mocked(clientMod.loadS3Module).mockResolvedValue({
    ListObjectsV2Command: ListCmd,
    HeadObjectCommand: HeadCmd,
  } as never)
  vi.mocked(clientMod.createS3Client).mockResolvedValue({
    send: (cmd: unknown) => {
      if (cmd instanceof HeadCmd) {
        const key = cmd.input.Key as string
        const found = objects.find((o) => o.key === key)
        if (found === undefined) {
          const err = new Error('NotFound')
          err.name = 'NotFound'
          return Promise.reject(err)
        }
        return Promise.resolve({
          ContentLength: 5,
          LastModified: new Date('2026-01-01T00:00:00.000Z'),
          ETag: `"${found.etag}"`,
        })
      }
      const prefix = (cmd as ListCmd).input.Prefix as string
      return Promise.resolve({
        Contents: objects.filter((o) => o.key.startsWith(prefix)).map((o) => ({ Key: o.key })),
        CommonPrefixes: [],
        IsTruncated: false,
      })
    },
  } as never)
}

function accessor(): S3Accessor {
  return new S3Accessor({ bucket: 'test-bucket', region: 'us-east-1' } as S3Config)
}

function path(p: string): PathSpec {
  return new PathSpec({ virtual: p, directory: p, resourcePath: p.replace(/^\/+|\/+$/g, '') })
}

describe('s3 live_identity op', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ignores a poisoned index', async () => {
    mockBucket([{ key: 'foo.txt', etag: 'etag-a' }])
    const result = (await liveIdentityOp.fn(accessor(), path('/foo.txt'), [], {
      index: new PoisonIndex(),
    })) as { exists: boolean; fingerprint: string | null }
    expect(result.exists).toBe(true)
    expect(result.fingerprint).toBe('etag-a')
  })
})
