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

import { gnuPhrase, POSIX, posixErrno } from './posix.ts'
import { FS_CONDITIONS } from './types.ts'

describe('the posix table', () => {
  it.each([
    ['ENOENT', 'No such file or directory'],
    ['ENOTDIR', 'Not a directory'],
    ['EISDIR', 'Is a directory'],
    ['EEXIST', 'File exists'],
    ['EACCES', 'Permission denied'],
    ['EPERM', 'Operation not permitted'],
    ['ENOTEMPTY', 'Directory not empty'],
    ['EXDEV', 'Invalid cross-device link'],
    ['CROSS_MOUNT', 'Invalid cross-device link'],
    ['ENOTSUP', 'Operation not supported'],
    ['ELOOP', 'Too many levels of symbolic links'],
    ['EINVAL', 'Invalid argument'],
    ['EIO', 'Input/output error'],
    ['EBUSY', 'Device or resource busy'],
    ['EROFS', 'Read-only file system'],
  ] as const)('speaks GNU strerror for %s', (cond, phrase) => {
    expect(gnuPhrase(cond)).toBe(phrase)
  })

  it('numbers the cross-mount rename as EXDEV', () => {
    expect(posixErrno('CROSS_MOUNT')).toBe(posixErrno('EXDEV'))
  })

  it('gives every row a positive number and a phrase', () => {
    for (const cond of FS_CONDITIONS) {
      expect(POSIX[cond].errno).toBeGreaterThan(0)
      expect(POSIX[cond].phrase).not.toBe('')
    }
  })
})
