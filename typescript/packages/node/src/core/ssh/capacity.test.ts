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

import { describe, expect, it } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { CapacityState, type CapacityResult } from '@struktoai/mirage-core/types'
import { capacity } from './capacity.ts'
import { RunAccessor } from '../../../tests/core/ssh/_test_utils.ts'

function remote(answer: Error | Record<string, number | bigint>): [RunAccessor, string[]] {
  const asked: string[] = []
  const sftp = {
    ext_openssh_statvfs: (path: string, cb: (err: Error | undefined, info: unknown) => void) => {
      asked.push(path)
      if (answer instanceof Error) cb(answer, undefined)
      else cb(undefined, answer)
    },
  } as unknown as SFTPWrapper
  return [new RunAccessor('/srv', [0, new Uint8Array(), new Uint8Array()], sftp), asked]
}

describe('core/ssh/capacity', () => {
  it.each<[Error | Record<string, number | bigint>, CapacityResult]>([
    [
      {
        f_bsize: 4096,
        f_frsize: 1024,
        f_blocks: 100n,
        f_bfree: 40,
        f_bavail: 30,
        f_files: 50,
        f_ffree: 20,
        f_favail: 10,
      },
      {
        state: CapacityState.QUOTA,
        total: 102400,
        used: 61440,
        available: 30720,
        inodes: 50,
        inodesUsed: 30,
        inodesFree: 10,
      },
    ],
    [new Error('Server does not support this extended request'), { state: CapacityState.UNKNOWN }],
  ])('counts statvfs the way df counts a disk (%#)', async (answer, expected) => {
    const [accessor, asked] = remote(answer)
    expect(await capacity(accessor)).toEqual(expected)
    expect(asked).toEqual(['/srv'])
  })
})
