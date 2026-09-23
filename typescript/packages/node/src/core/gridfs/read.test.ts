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

import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, bucket: vi.fn(), latestFile: vi.fn() }
})

import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { GridFSAccessor } from '../../accessor/gridfs.ts'
import type { GridFSConfig } from '../../vfs/gridfs/config.ts'
import * as clientMod from './client.ts'
import { DRIVER } from './driver.ts'
import { read } from './read.ts'

const FILE_ID = '0123456789ab0123456789ab'

function fakeDoc(): unknown {
  return {
    _id: { toString: () => FILE_ID },
    length: 5,
    uploadDate: new Date(0),
    filename: 'a.txt',
  }
}

function fakeBucket(): unknown {
  return {
    openDownloadStream: () => Readable.from([new TextEncoder().encode('hello')]),
  }
}

function accessor(): GridFSAccessor {
  return new GridFSAccessor({
    uri: 'mongodb://localhost:27017',
    database: 'db',
  } as GridFSConfig)
}

describe('gridfs read token', () => {
  it('stamps the token stat stamps', async () => {
    // GridFS is one of two backends claiming READ_REVALIDATABLE. The
    // claim is that its stat and its read stamp a token that can be
    // compared, and both use the file's `_id` today. Nothing failed if
    // one side moved to an md5 or an uploadDate -- which is exactly the
    // gdrive mismatch the flag exists to keep out. Python pins the same
    // invariant in tests/core/gridfs/test_read_fingerprint.py.
    vi.mocked(clientMod.latestFile).mockResolvedValue(fakeDoc() as never)
    vi.mocked(clientMod.bucket).mockResolvedValue(fakeBucket() as never)

    const meta = await DRIVER.head(accessor(), 'a.txt')
    expect(meta?.fingerprint).toBe(FILE_ID)

    const spec = new PathSpec({ vfsPath: 'a.txt', virtual: '/mnt/a.txt', directory: '/mnt/' })
    const [bytes, records] = await runWithRecording(async () => read(accessor(), spec))

    expect(new TextDecoder().decode(bytes)).toBe('hello')
    expect(records.map((r) => r.fingerprint)).toEqual([FILE_ID])
    expect(records[0]?.fingerprint).toBe(meta?.fingerprint)
  })
})
