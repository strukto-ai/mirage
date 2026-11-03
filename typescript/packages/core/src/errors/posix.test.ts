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

import { POSIX, errnoName, errnoOf, posixErrno, posixPhrase } from './posix.ts'
import { FS_CONDITIONS } from './types.ts'

describe('the posix table', () => {
  it.each([
    ['EBADF', 'Bad file descriptor'],
    ['ENOENT', 'No such file or directory'],
    ['ENOTDIR', 'Not a directory'],
    ['EISDIR', 'Is a directory'],
    ['EEXIST', 'File exists'],
    ['EACCES', 'Permission denied'],
    ['EPERM', 'Operation not permitted'],
    ['ENOTEMPTY', 'Directory not empty'],
    ['EXDEV', 'Invalid cross-device link'],
    ['ENOTSUP', 'Operation not supported'],
    ['ELOOP', 'Too many levels of symbolic links'],
    ['EINVAL', 'Invalid argument'],
    ['EIO', 'Input/output error'],
    ['EBUSY', 'Device or resource busy'],
    ['EROFS', 'Read-only file system'],
    ['EFBIG', 'File too large'],
    ['EDQUOT', 'Disk quota exceeded'],
    ['STALE_WRITE', 'changed since it was read; read it again before writing'],
  ] as const)('speaks the strerror text for %s', (cond, phrase) => {
    expect(posixPhrase(cond)).toBe(phrase)
  })

  it('numbers EDQUOT as Linux does', () => {
    expect(posixErrno('EDQUOT')).toBe(122)
  })

  it('gives every row a positive number and a phrase', () => {
    for (const cond of FS_CONDITIONS) {
      expect(posixErrno(cond)).toBeGreaterThan(0)
      expect(POSIX[cond].phrase).not.toBe('')
    }
  })
})

describe('errnoOf', () => {
  it.each([
    ['ENOSPC', 28],
    ['ENAMETOOLONG', 36],
    ['ELOOP', 40],
  ] as const)('numbers a raw %s as Linux does', (code, number) => {
    expect(errnoOf(Object.assign(new Error('x'), { code }))).toBe(number)
  })

  it('has nothing for an error without one', () => {
    expect(errnoOf(null)).toBeNull()
    expect(errnoOf(new Error('x'))).toBeNull()
  })
})

describe('errnoName', () => {
  it('gives the canonical name', () => {
    expect(errnoName(28)).toBe('ENOSPC')
    expect(errnoName(95)).toBe('ENOTSUP')
    expect(errnoName(61)).toBe('ENODATA')
    expect(errnoName(999)).toBeNull()
  })
})
