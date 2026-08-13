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

import { CrossMountError } from '../runtime/errors.ts'
import { enoent, enotsup, noMount } from '../utils/errors.ts'
import { CycleError } from '../utils/path.ts'
import { classify } from './classify.ts'

describe('classify', () => {
  it.each([
    ['ENOENT', 'ENOENT'],
    ['ENOTDIR', 'ENOTDIR'],
    ['EISDIR', 'EISDIR'],
    ['EEXIST', 'EEXIST'],
    ['EACCES', 'EACCES'],
    ['EPERM', 'EPERM'],
    ['ENOTEMPTY', 'ENOTEMPTY'],
    ['EXDEV', 'EXDEV'],
    ['ENOTSUP', 'ENOTSUP'],
    ['EOPNOTSUPP', 'ENOTSUP'],
    ['ELOOP', 'ELOOP'],
    ['EINVAL', 'EINVAL'],
    ['EIO', 'EIO'],
    ['EBUSY', 'EBUSY'],
    ['EROFS', 'EROFS'],
    ['ENODATA', 'NO_XATTR'],
    ['ENOATTR', 'NO_XATTR'],
  ])('names a stamped %s code %s', (code, expected) => {
    expect(classify(Object.assign(new Error('x'), { code }))).toBe(expected)
  })

  it('names a symlink loop ELOOP', () => {
    // CycleError is documented as POSIX ELOOP; before the shared
    // vocabulary it carried no code and every boundary degraded it to
    // EIO ("Input/output error" for a loop the message even names).
    expect(classify(new CycleError('/a'))).toBe('ELOOP')
  })

  it('names a cross-mount rename its own condition', () => {
    // The per-boundary number is the table's decision: POSIX says
    // EXDEV, the WASI wire deliberately says ENOENT (finding 8).
    expect(classify(new CrossMountError('/a/x', '/b/x'))).toBe('CROSS_MOUNT')
  })

  it('reads the constructors built by utils/errors', () => {
    expect(classify(enoent('/x'))).toBe('ENOENT')
    expect(classify(enotsup('ram', 'unlink', '/x'))).toBe('ENOTSUP')
  })

  it('names the no-mount refusal a miss', () => {
    expect(classify(noMount('/x'))).toBe('ENOENT')
  })

  it.each([
    [new Error('bare message, no code')],
    [Object.assign(new Error('x'), { code: 'ENAMETOOLONG' })],
    [Object.assign(new Error('x'), { code: 7 })],
    ['not even an error'],
    [null],
  ])('answers null for anything the vocabulary does not name', (err) => {
    expect(classify(err)).toBeNull()
  })
})
