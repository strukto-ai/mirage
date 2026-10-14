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

import { S3Accessor } from '../../accessor/s3.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { PathSpec } from '../../types.ts'
import { checksum } from './checksum.ts'

const head = vi.hoisted(() => ({ reply: {} as Record<string, unknown>, sent: [] as unknown[] }))

vi.mock('./client.ts', async (importOriginal) => {
  const real = await importOriginal<typeof ClientModule>()
  class HeadObjectCommand {
    constructor(readonly input: unknown) {}
  }
  return {
    ...real,
    loadS3Module: () => Promise.resolve({ HeadObjectCommand }),
    createS3Client: () =>
      Promise.resolve({
        send: (cmd: { input: unknown }) => {
          head.sent.push(cmd.input)
          return Promise.resolve(head.reply)
        },
      }),
  }
})

const MD5 = '5d41402abc4b2a76b9719d911017c592'
const SCOPE = PathSpec.fromStrPath('/foo.txt', 'foo.txt')
const accessor = new S3Accessor({ bucket: 'b', region: 'us-east-1' } as S3Config)

beforeEach(() => {
  head.sent = []
})

describe('S3 checksum', () => {
  // Mirrors python's test_an_etag_is_the_md5_only_when_nothing_else_can_be.
  it.each([
    [{ ETag: `"${MD5}"` }, false, MD5],
    [{ ETag: `"${MD5}"`, ServerSideEncryption: 'AES256' }, true, MD5],
    [{ ETag: `"${MD5}"`, ServerSideEncryption: 'AES256' }, false, null],
    [{ ETag: `"${MD5}"`, ServerSideEncryption: 'aws:kms' }, true, null],
    [{ ETag: `"${MD5}"`, SSECustomerAlgorithm: 'AES256' }, true, null],
    [{ ETag: `"${MD5}-3"` }, true, null],
    [{ ETag: '"0123"' }, true, null],
    [{}, true, null],
  ])('%j on aws=%s', async (reply, aws, expected) => {
    head.reply = reply
    expect(await checksum(accessor, SCOPE, 'md5', aws)).toBe(expected)
    expect(head.sent).toEqual([{ Bucket: 'b', Key: 'foo.txt' }])
  })

  // Mirrors python's test_another_algorithm_asks_nothing.
  it('asks nothing for another algorithm', async () => {
    head.reply = { ETag: `"${MD5}"` }
    expect(await checksum(accessor, SCOPE, 'sha256', true)).toBeNull()
    expect(head.sent).toEqual([])
  })
})
