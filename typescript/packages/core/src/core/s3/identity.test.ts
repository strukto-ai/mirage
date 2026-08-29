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
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, loadS3Module: vi.fn(), createS3Client: vi.fn() }
})

import { S3Accessor } from '../../accessor/s3.ts'
import type { S3Config } from '../../resource/s3/config.ts'
import { PathSpec } from '../../types.ts'
import * as clientMod from './client.ts'
import { liveIdentity } from './identity.ts'

class HeadCmd {
  constructor(readonly input: Record<string, unknown>) {}
}

class ListCmd {
  constructor(readonly input: Record<string, unknown>) {}
}

interface StoredObject {
  key: string
  etag: string
  versionId?: string
}

function notFound(): Error {
  const err = new Error('NotFound')
  err.name = 'NotFound'
  return err
}

function mockBucket(objects: StoredObject[]): void {
  vi.mocked(clientMod.loadS3Module).mockResolvedValue({
    ListObjectsV2Command: ListCmd,
    HeadObjectCommand: HeadCmd,
  } as never)
  vi.mocked(clientMod.createS3Client).mockResolvedValue({
    send: (cmd: unknown) => {
      if (cmd instanceof HeadCmd) {
        const key = cmd.input.Key as string
        const found = objects.find((o) => o.key === key)
        if (found === undefined) return Promise.reject(notFound())
        return Promise.resolve({
          ContentLength: 5,
          LastModified: new Date('2026-01-01T00:00:00.000Z'),
          ETag: `"${found.etag}"`,
          ...(found.versionId !== undefined ? { VersionId: found.versionId } : {}),
        })
      }
      const prefix = (cmd as ListCmd).input.Prefix as string
      const contents = objects.filter((o) => o.key.startsWith(prefix)).map((o) => ({ Key: o.key }))
      return Promise.resolve({ Contents: contents, CommonPrefixes: [], IsTruncated: false })
    },
  } as never)
}

function accessor(keyPrefix?: string): S3Accessor {
  return new S3Accessor({ bucket: 'test-bucket', region: 'us-east-1', keyPrefix } as S3Config)
}

function path(p: string): PathSpec {
  return new PathSpec({ virtual: p, directory: p, resourcePath: p.replace(/^\/+|\/+$/g, '') })
}

describe('s3 identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the ETag fingerprint with no revision on a non-versioned bucket', async () => {
    mockBucket([{ key: 'foo.txt', etag: 'etag-a' }])
    const result = await liveIdentity(accessor(), path('/foo.txt'))
    expect(result.exists).toBe(true)
    expect(result.fingerprint).toBe('etag-a')
    expect(result.revision).toBeNull()
  })

  it('returns a revision on a versioned bucket', async () => {
    mockBucket([{ key: 'foo.txt', etag: 'etag-a', versionId: 'v1' }])
    const result = await liveIdentity(accessor(), path('/foo.txt'))
    expect(result.exists).toBe(true)
    expect(result.revision).toBe('v1')
  })

  it('reports exists false for a missing key', async () => {
    mockBucket([])
    const result = await liveIdentity(accessor(), path('/never.txt'))
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })

  it('raises EISDIR for a directory', async () => {
    mockBucket([{ key: 'dir/f.txt', etag: 'etag-f' }])
    await expect(liveIdentity(accessor(), path('/dir'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('lifts the path through a key prefix', async () => {
    mockBucket([{ key: 'users/abc/a.txt', etag: 'etag-a' }])
    const result = await liveIdentity(accessor('users/abc/'), path('/a.txt'))
    expect(result.exists).toBe(true)
    expect(result.fingerprint).toBe('etag-a')
  })
})
