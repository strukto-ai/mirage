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

import { GUEST, guestSeat } from './guest.ts'
import { POSIX } from './posix.ts'
import { FS_CONDITIONS } from './types.ts'

describe('the guest seat table', () => {
  it.each([
    ['ENOENT', 'FileNotFoundError', 2],
    ['ENOTDIR', 'NotADirectoryError', 20],
    ['EISDIR', 'IsADirectoryError', 21],
    ['EEXIST', 'FileExistsError', 17],
    ['EACCES', 'PermissionError', 13],
    ['EPERM', 'PermissionError', 1],
    ['EXDEV', 'OSError', 18],
    ['CROSS_MOUNT', 'OSError', 18],
    ['ENOTEMPTY', 'OSError', 39],
    ['ELOOP', 'OSError', 40],
  ] as const)('renders %s as CPython on Linux', (cond, name, errno) => {
    // A guest interpreter is platform-neutral, so the numbering must
    // not wobble with the host. Mirrors python tests/errors/test_guest.
    const seat = guestSeat(cond)
    expect([seat.name, seat.errno]).toEqual([name, errno])
  })

  it('speaks one phrase per condition, shared with the posix table', () => {
    // NO_XATTR is exempt: the posix seat may resolve to macOS's
    // "Attribute not found" while a guest always speaks Linux.
    for (const cond of FS_CONDITIONS) {
      if (cond === 'NO_XATTR') continue
      expect(GUEST[cond].phrase).toBe(POSIX[cond].phrase)
    }
  })
})
