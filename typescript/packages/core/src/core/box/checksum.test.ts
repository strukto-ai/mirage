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
import { runWithRecording } from '../../observe/context.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import * as api from './api.ts'
import type { BoxTokenManager } from './client.ts'
import { checksum } from './checksum.ts'

const TM = {} as BoxTokenManager
const SCOPE = new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/' })
const accessor = new BoxAccessor({ tokenManager: TM })

function listed(sha1 = '0'.repeat(40)): FileStat {
  return new FileStat({
    name: 'a.txt',
    type: FileType.FILE,
    extra: { box_id: '200', resource_type: 'box/file', sha1 },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Box checksum', () => {
  // Mirrors python's test_box_answers_its_live_sha1.
  it('answers its live sha1', async () => {
    vi.mocked(api.getFileInfo).mockResolvedValue({ id: '200', sha1: 'AB'.repeat(20) } as never)
    expect(await checksum(accessor, SCOPE, 'sha1', listed())).toBe('ab'.repeat(20))
    expect(api.getFileInfo).toHaveBeenCalledWith(TM, '200')
  })

  // Mirrors python's test_box_without_a_sha1_reads.
  it.each([null, ''])('reads a file whose sha1 is %j', async (sha1) => {
    vi.mocked(api.getFileInfo).mockResolvedValue({ id: '200', sha1 } as never)
    expect(await checksum(accessor, SCOPE, 'sha1', listed())).toBeNull()
  })

  // Mirrors python's test_box_keeps_no_md5.
  it('keeps no md5', async () => {
    expect(await checksum(accessor, SCOPE, 'md5', listed())).toBeNull()
    expect(api.getFileInfo).not.toHaveBeenCalled()
  })

  // Mirrors python's test_box_records_the_token_a_read_would.
  it.each([
    ['ab'.repeat(20), 'ab'.repeat(20)],
    ['0'.repeat(40), null],
  ])('records the token a read would, listed %s', async (sha1, token) => {
    vi.mocked(api.getFileInfo).mockResolvedValue({ id: '200', sha1: 'AB'.repeat(20) } as never)
    const row = listed(sha1)
    const [, records] = await runWithRecording(() => checksum(accessor, SCOPE, 'sha1', row))
    expect(records.map((r) => [r.op, r.path, r.fingerprint])).toEqual([['read', '/a.txt', token]])
  })
})
