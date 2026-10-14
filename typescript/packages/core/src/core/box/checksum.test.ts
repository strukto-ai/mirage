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
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, getFileInfo: vi.fn() }
})

import { BoxAccessor } from '../../accessor/box.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import * as api from './api.ts'
import type { BoxTokenManager } from './client.ts'
import { checksum } from './checksum.ts'

const TM = {} as BoxTokenManager
const SCOPE = new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/' })
const accessor = new BoxAccessor({ tokenManager: TM })

async function listed(): Promise<RAMIndexCacheStore> {
  const index = new RAMIndexCacheStore()
  await index.setDir('/', [
    [
      'a.txt',
      new IndexEntry({
        id: '200',
        name: 'a.txt',
        resourceType: 'box/file',
        vfsName: 'a.txt',
        extra: { sha1: '0'.repeat(40) },
      }),
    ],
  ])
  return index
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Box checksum', () => {
  // Mirrors python's test_box_answers_its_live_sha1.
  it('answers its live sha1', async () => {
    vi.mocked(api.getFileInfo).mockResolvedValue({ id: '200', sha1: 'AB'.repeat(20) } as never)
    expect(await checksum(accessor, SCOPE, 'sha1', await listed())).toBe('ab'.repeat(20))
    expect(api.getFileInfo).toHaveBeenCalledWith(TM, '200')
  })

  // Mirrors python's test_box_without_a_sha1_reads.
  it.each([null, ''])('reads a file whose sha1 is %j', async (sha1) => {
    vi.mocked(api.getFileInfo).mockResolvedValue({ id: '200', sha1 } as never)
    expect(await checksum(accessor, SCOPE, 'sha1', await listed())).toBeNull()
  })

  // Mirrors python's test_box_keeps_no_md5.
  it('keeps no md5', async () => {
    expect(await checksum(accessor, SCOPE, 'md5', await listed())).toBeNull()
    expect(api.getFileInfo).not.toHaveBeenCalled()
  })
})
