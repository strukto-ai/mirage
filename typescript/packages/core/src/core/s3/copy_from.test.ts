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

// Mirrors python/tests/core/s3/test_copy_from.py.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

import { S3Accessor } from '../../accessor/s3.ts'
import { classify } from '../../errors/classify.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { PathSpec } from '../../types.ts'
import { copyFrom } from './copy.ts'

const copy = vi.hoisted(() => ({ error: null as Error | null, sent: [] as unknown[] }))

vi.mock('./client.ts', async (importOriginal) => {
  const real = await importOriginal<typeof ClientModule>()
  class CopyObjectCommand {
    constructor(readonly input: unknown) {}
  }
  return {
    ...real,
    loadS3Module: () => Promise.resolve({ CopyObjectCommand }),
    createS3Client: () =>
      Promise.resolve({
        send: (cmd: { input: unknown }) => {
          copy.sent.push(cmd.input)
          return copy.error === null ? Promise.resolve({}) : Promise.reject(copy.error)
        },
      }),
  }
})

const SRC = new PathSpec({ vfsPath: 'in/a.txt', virtual: '/x/in/a.txt', directory: '/x/in' })
const DST = new PathSpec({ vfsPath: 'out/a.txt', virtual: '/y/out/a.txt', directory: '/y/out' })

function accessor(bucket: string, extra: Partial<S3Config> = {}): S3Accessor {
  return new S3Accessor({
    bucket,
    region: 'us-east-1',
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
    ...extra,
  } as S3Config)
}

function serviceError(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })
}

beforeEach(() => {
  copy.error = null
  copy.sent = []
})

describe('S3 copyFrom', () => {
  it('copies across buckets under one service', async () => {
    await copyFrom(accessor('b2', { keyPrefix: 'p/' }), accessor('b1'), SRC, DST)
    expect(copy.sent).toEqual([{ Bucket: 'b2', Key: 'p/out/a.txt', CopySource: 'b1/in/a.txt' }])
  })

  it('asks nothing under other credentials', async () => {
    const refused = copyFrom(accessor('b2'), accessor('b1', { accessKeyId: 'other' }), SRC, DST)
    await expect(refused).rejects.toSatisfy((err: unknown) => classify(err) === 'EXDEV')
    expect(copy.sent).toEqual([])
  })

  it.each([
    [serviceError('AccessDenied', 403), 'EXDEV'],
    [serviceError('NoSuchKey', 404), 'ENOENT'],
  ])('answers %s as %s', async (error, condition) => {
    copy.error = error
    const refused = copyFrom(accessor('b2'), accessor('b1'), SRC, DST)
    await expect(refused).rejects.toSatisfy((err: unknown) => classify(err) === condition)
  })
})
