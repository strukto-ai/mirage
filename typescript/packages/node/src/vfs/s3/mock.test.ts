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

import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installS3Mock, S3MockStore, type S3Mock } from './mock.ts'

describe('the S3 mount mock tripwire', () => {
  let mock: S3Mock
  let client: S3Client

  beforeEach(() => {
    const store = new S3MockStore()
    store.set('b', 'k', new TextEncoder().encode('k\n'))
    store.set('b', 'd/', new Uint8Array())
    store.set('b', 'd/a', new TextEncoder().encode('a'))
    mock = installS3Mock(store)
    mock.tripwire = true
    client = new S3Client({ region: 'us-east-1' })
  })

  afterEach(() => {
    mock.restore()
  })

  // A no-op tripwire would let every tripwire row in the e2e suite pass.
  it.each([
    ['put', () => client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'attempt\n' }))],
    [
      'batch delete, marker first',
      () =>
        client.send(
          new DeleteObjectsCommand({
            Bucket: 'b',
            Delete: { Objects: [{ Key: 'd/' }, { Key: 'd/a' }] },
          }),
        ),
    ],
  ])('refuses an unconditioned mutation: %s', async (_name, call) => {
    await expect(call()).rejects.toThrow(/unconditioned/)
  })
})
