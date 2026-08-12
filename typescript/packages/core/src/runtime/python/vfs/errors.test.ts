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
import { errnoError, fsError } from './errors.ts'
import type { ErrnoCodes, FSHost } from './types.ts'

class FakeErrnoError extends Error {
  readonly errno: number

  constructor(errno: number) {
    super(`errno ${String(errno)}`)
    this.errno = errno
  }
}

// musl's numbering, which is what pyodide reports and what an errno
// literal copied from Linux would get wrong (EXDEV is 75 here, and 18
// is EDOM rather than the cross-device link everyone remembers).
const CODES: ErrnoCodes = { ENOENT: 44, EPERM: 63, EINVAL: 28, EIO: 29, EXDEV: 75 }

const HOST = { ErrnoError: FakeErrnoError } as unknown as FSHost

describe('fsError', () => {
  it('names the condition rather than numbering it', () => {
    const err = fsError('EIO', 'mount went away')
    expect((err as { code?: string }).code).toBe('EIO')
    expect(err.message).toBe('mount went away')
  })
})

describe('errnoError', () => {
  it('answers in the numbering the interpreter reports', () => {
    expect((errnoError(HOST, CODES, 'ENOENT') as FakeErrnoError).errno).toBe(44)
    expect((errnoError(HOST, CODES, 'EPERM') as FakeErrnoError).errno).toBe(63)
    expect((errnoError(HOST, CODES, 'EINVAL') as FakeErrnoError).errno).toBe(28)
    expect((errnoError(HOST, CODES, 'EIO') as FakeErrnoError).errno).toBe(29)
  })

  it('builds the constructor the kernel recognizes, not a bare Error', () => {
    expect(errnoError(HOST, CODES, 'EIO')).toBeInstanceOf(FakeErrnoError)
  })
})

describe('the shared vocabulary', () => {
  it('keys the lookup on the condition, aliases included', () => {
    // CROSS_MOUNT has no Emscripten name of its own: the interpreter
    // knows the condition as EXDEV, and the alias row says so.
    expect((errnoError(HOST, CODES, 'CROSS_MOUNT') as FakeErrnoError).errno).toBe(75)
  })

  it('falls back to EIO for a key this interpreter does not define', () => {
    // Emscripten builds differ on ENODATA; a missing key must not
    // surface as ErrnoError(undefined).
    expect((errnoError(HOST, CODES, 'NO_XATTR') as FakeErrnoError).errno).toBe(29)
  })
})
