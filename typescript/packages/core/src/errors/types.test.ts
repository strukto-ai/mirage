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

import { GUEST } from './guest.ts'
import { POSIX } from './posix.ts'
import { FS_CONDITIONS } from './types.ts'
import { WASI } from './wasi.ts'

describe('the condition vocabulary', () => {
  it('is covered by every number table exactly', () => {
    // The gate of R5a: a condition cannot be half-added. Every boundary
    // table keys on exactly the vocabulary, no more, no fewer.
    const conditions = [...FS_CONDITIONS].sort()
    expect(Object.keys(POSIX).sort()).toEqual(conditions)
    expect(Object.keys(WASI).sort()).toEqual(conditions)
    expect(Object.keys(GUEST).sort()).toEqual(conditions)
  })

  it('names the probed conditions', () => {
    expect(new Set(FS_CONDITIONS)).toEqual(
      new Set([
        'ENOENT',
        'ENOTDIR',
        'EISDIR',
        'EEXIST',
        'EACCES',
        'EPERM',
        'ENOTEMPTY',
        'EXDEV',
        'CROSS_MOUNT',
        'ENOTSUP',
        'ELOOP',
        'EINVAL',
        'EIO',
        'EBUSY',
        'EROFS',
        'NO_XATTR',
      ]),
    )
  })
})
