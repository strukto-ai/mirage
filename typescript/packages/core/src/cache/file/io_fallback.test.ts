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

import { describe, expect, it, vi } from 'vitest'
import { IOResult } from '../../io/types.ts'
import { OpRecord } from '../../observe/record.ts'
import { applyIo } from './io.ts'
import { RAMFileCacheStore } from './ram.ts'
import type * as asyncContextModule from '../../utils/async_context.ts'

// The browser-runtime branch under node's test runner: one shared frame
// stack, so a command's record list can hold a sibling stage's write and the
// mark can be trusted neither way. The size check and the write's token still
// hold, as they did before the mark existed.
vi.mock('../../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return { ...real, asyncContextIsolatesTasks: false }
})

const ENC = new TextEncoder()

describe('applyIo on storage that does not isolate tasks', () => {
  it('keeps written bytes whose newest write looks unclaimed, with the token', async () => {
    const cache = new RAMFileCacheStore()
    const io = new IOResult({ writes: { '/s3/f.txt': ENC.encode('new') }, cache: ['/s3/f.txt'] })
    const unclaimed = new OpRecord({
      op: 'write',
      path: '/s3/f.txt',
      source: 's3',
      bytes: 3,
      timestamp: 0,
      durationMs: 0,
      fingerprint: 'etag-put-2',
    })
    await applyIo(cache, io, undefined, [unclaimed])
    expect(await cache.get('/s3/f.txt')).toEqual(ENC.encode('new'))
    expect(await cache.isFresh('/s3/f.txt', 'etag-put-2')).toBe(true)
  })
})
