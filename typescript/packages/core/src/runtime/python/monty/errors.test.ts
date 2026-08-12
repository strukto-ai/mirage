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

import { FS_CONDITIONS } from '../../../errors/index.ts'
import { POSIX } from '../../../errors/posix.ts'
import { CrossMountError } from '../../errors.ts'
import { asGuestError, CPYTHON, cpythonError, guestError } from './errors.ts'

describe('the CPython table', () => {
  it('covers the whole vocabulary', () => {
    // A condition cannot be half-added: the dialect table stays total
    // over the vocabulary, keyed on exactly the union.
    expect(Object.keys(CPYTHON).sort()).toEqual([...FS_CONDITIONS].sort())
  })

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
  ] as const)('renders %s as CPython on Linux', (cond, exception, errno) => {
    // A guest interpreter is platform-neutral, so the numbering must
    // not wobble with the host. Mirrors the python
    // tests/runtime/python/monty/test_errors.py pins.
    const row = cpythonError(cond)
    expect([row.exception, row.errno]).toEqual([exception, errno])
  })

  it('speaks one phrase per condition, shared with the posix table', () => {
    // NO_XATTR is exempt: the posix row may resolve to macOS's
    // "Attribute not found" while a guest always speaks Linux.
    for (const cond of FS_CONDITIONS) {
      if (cond === 'NO_XATTR') continue
      expect(CPYTHON[cond].phrase).toBe(POSIX[cond].phrase)
    }
  })
})

describe('guestError', () => {
  it('renders CPython message shape', () => {
    const err = guestError('ENOENT', '/data/x')
    expect(err.name).toBe('FileNotFoundError')
    expect(err.message).toBe("[Errno 2] No such file or directory: '/data/x'")
  })

  it('renders a rename pair', () => {
    const err = guestError('EXDEV', '/a/x', '/b/x')
    expect(err.message).toBe("[Errno 18] Invalid cross-device link: '/a/x' -> '/b/x'")
  })
})

describe('asGuestError', () => {
  it('converts every named condition, not a private six', () => {
    // ENOTEMPTY had no row in the old table, so a non-empty rmdir
    // reached guest code as a raw JS error it could not `except`.
    const raw = Object.assign(new Error('directory not empty: /d'), {
      code: 'ENOTEMPTY',
    })
    const guest = asGuestError(raw, '/d') as Error
    expect(guest.name).toBe('OSError')
    expect(guest.message).toBe("[Errno 39] Directory not empty: '/d'")
  })

  it('converts a symlink loop to ELOOP', () => {
    const raw = Object.assign(new Error('too many levels of symbolic links: /a'), {
      code: 'ELOOP',
    })
    const guest = asGuestError(raw, '/a') as Error
    expect(guest.name).toBe('OSError')
    expect(guest.message).toBe("[Errno 40] Too many levels of symbolic links: '/a'")
  })

  it('speaks pathlib for a cross-mount rename', () => {
    const guest = asGuestError(new CrossMountError('/a/x', '/b/x'), '/a/x') as Error
    expect(guest.name).toBe('OSError')
    expect(guest.message).toBe("[Errno 18] Invalid cross-device link: '/a/x'")
  })

  it('passes an unnamed error through untouched', () => {
    const raw = new Error('transport exploded')
    expect(asGuestError(raw, '/x')).toBe(raw)
  })
})
