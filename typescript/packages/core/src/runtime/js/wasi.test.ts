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

import { FS_CONDITIONS } from '../../errors/index.ts'
import { WASI, wasiErrno } from './wasi.ts'

describe('the preview1 wire table', () => {
  it('covers the whole vocabulary', () => {
    // A condition cannot be half-added: the dialect table stays total
    // over the vocabulary, keyed on exactly the union.
    expect(Object.keys(WASI).sort()).toEqual([...FS_CONDITIONS].sort())
  })

  it('is the wasi-libc numbering, pinned literally', () => {
    // NOT the host's POSIX values: ENOENT is 44 on the wire, and 18
    // here would be EDOM where a POSIX host means EXDEV. Mirrors the
    // python tests/runtime/wasm/test_abi.py pin exactly.
    expect(WASI).toEqual({
      ENOENT: 44,
      ENOTDIR: 54,
      EISDIR: 31,
      EEXIST: 20,
      EACCES: 2,
      EPERM: 63,
      ENOTEMPTY: 55,
      EXDEV: 75,
      CROSS_MOUNT: 44,
      ENOTSUP: 58,
      ELOOP: 32,
      EINVAL: 28,
      EIO: 29,
      EBUSY: 10,
      EROFS: 69,
      NO_XATTR: 58,
    })
  })

  it('keeps the cross-mount rename deliberately ENOENT on this wire', () => {
    // Finding 8: each mount is its own preopen to a WASI guest, so a
    // rename between two of them reads as a destination that is not
    // there. Do not "fix" this to 75.
    expect(wasiErrno('CROSS_MOUNT')).toBe(wasiErrno('ENOENT'))
    expect(wasiErrno('CROSS_MOUNT')).not.toBe(wasiErrno('EXDEV'))
  })
})
