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

import { constants as osConstants } from 'node:os'

import { describe, expect, it } from 'vitest'
import {
  classifyErrno,
  classifyError,
  EACCES,
  EEXIST,
  EINVAL,
  EIO,
  EISDIR,
  ENOENT,
  ENOTDIR,
  ENOTEMPTY,
  EROFS,
  errnoError,
  EXDEV,
} from './errors.ts'

describe('classifyErrno', () => {
  it.each([
    ['ENOTEMPTY', ENOTEMPTY],
    ['ENOTDIR', ENOTDIR],
    ['EACCES', EACCES],
    ['EEXIST', EEXIST],
    ['ENOENT', ENOENT],
    ['EINVAL', EINVAL],
    ['EROFS', EROFS],
    // A cross-mount rename refusal: the kernel reads EXDEV as "not one
    // filesystem" and mv falls back to copy+unlink, so this may not
    // degrade to EIO on the way out of the mount.
    ['EXDEV', EXDEV],
  ] as const)('maps the %s code property', (code, expected) => {
    expect(classifyErrno(errnoError(code, 'boom'))).toBe(expected)
  })

  it.each([
    ['directory not empty: /d', ENOTEMPTY],
    ['not a directory', ENOTDIR],
    ['is a directory', EISDIR],
    ['permission denied', EACCES],
    ['read-only mount', EACCES],
    ['not allowed to access mount /x', EACCES],
    ['file exists', EEXIST],
    ['no such file or directory', ENOENT],
    ['no mount at /x', ENOENT],
  ])('falls back to the message for %s', (message, expected) => {
    expect(classifyErrno(new Error(message))).toBe(expected)
  })

  it('is case insensitive on messages', () => {
    expect(classifyErrno(new Error('Permission Denied'))).toBe(EACCES)
  })

  it('returns EIO for anything unrecognised', () => {
    expect(classifyErrno(new Error('something else entirely'))).toBe(EIO)
  })

  it('prefers the code property over the message', () => {
    const err = errnoError('ENOTEMPTY', 'no such file or directory')
    expect(classifyErrno(err)).toBe(ENOTEMPTY)
  })
})

describe('classifyError', () => {
  it('negates the errno for fuse-native callbacks', () => {
    expect(classifyError(new Error('no such file'))).toBe(-ENOENT)
    expect(classifyError(new Error('directory not empty'))).toBe(-ENOTEMPTY)
  })

  it('stays in sync with classifyErrno', () => {
    const err = new Error('permission denied')
    expect(classifyError(err)).toBe(-classifyErrno(err))
  })
})

describe('the shared vocabulary', () => {
  // The stamps below are what CycleError and CrossMountError carry
  // (pinned by core's errors/classify.test.ts); the adapter's contract
  // is the code, so the tests construct stamped errors rather than
  // reaching into core's unexported classes.
  it('maps a symlink loop to ELOOP, not EIO', () => {
    // Before the shared vocabulary CycleError carried no code, no
    // needle matched its message, and a loop reached the kernel as
    // "Input/output error".
    const loop = Object.assign(new Error('too many levels of symbolic links: /a'), {
      code: 'ELOOP',
    })
    expect(classifyErrno(loop)).toBe(process.platform === 'darwin' ? 62 : 40)
  })

  it('maps a cross-mount rename to EXDEV', () => {
    const cross = Object.assign(new Error('cross-mount rename: /a/x -> /b/x'), {
      code: 'CROSS_MOUNT',
    })
    expect(classifyErrno(cross)).toBe(EXDEV)
  })

  it('passes a stamped code outside the vocabulary through', () => {
    // Python's twin forwards a raw OSError errno untouched; the node
    // adapter reads the host's own numbering for the same passthrough.
    const err = Object.assign(new Error('x'), { code: 'ENAMETOOLONG' })
    expect(classifyErrno(err)).toBe(osConstants.errno.ENAMETOOLONG)
  })
})
