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

import { PathSpec } from '@struktoai/mirage-core/types'
import { checkMutationContract } from '@struktoai/mirage-core/vfs/testing'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { MinIOVFS } from '../minio/minio.ts'
import { installS3Mock, type S3Mock } from '../../../tests/vfs/s3/mock.ts'
import { s3Vfs } from '../../../tests/test-utils.ts'

const DIRECTORY = new PathSpec({ virtual: '/s3/scratch', directory: '/s3', vfsPath: 'scratch' })

// Expected to fail while a copy of a missing source rejects NoSuchKey, not ENOENT.
describe('the mutation contract on S3', () => {
  let mock: S3Mock

  beforeAll(() => {
    mock = installS3Mock()
  })
  afterAll(() => {
    mock.restore()
  })
  beforeEach(() => {
    for (const bucket of mock.store.allBuckets()) mock.store.objects(bucket).clear()
  })

  it.fails('holds on AWS, every condition declared', async () => {
    await checkMutationContract(s3Vfs(), { directory: DIRECTORY })
  })

  it.fails('holds on a custom endpoint, puts declared only', async () => {
    const vfs = new MinIOVFS({
      bucket: 'b',
      endpoint: 'http://127.0.0.1:9000',
      accessKeyId: 'k',
      secretAccessKey: 's',
    })
    await checkMutationContract(vfs, { directory: DIRECTORY })
  })
})
