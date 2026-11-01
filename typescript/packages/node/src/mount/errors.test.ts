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

import { PolicyDenied } from '@struktoai/mirage-core/policy/errors'
import { unnamedFsError } from '@struktoai/mirage-core/errors/fs'
import { describe, expect, it, vi } from 'vitest'
import { classifyErrno, classifyError } from './errors.ts'

describe('classifyErrno', () => {
  it.each([
    ['ENOTEMPTY', osConstants.errno.ENOTEMPTY],
    ['ENOTDIR', osConstants.errno.ENOTDIR],
    ['EACCES', osConstants.errno.EACCES],
    ['EEXIST', osConstants.errno.EEXIST],
    ['ENOENT', osConstants.errno.ENOENT],
    ['EINVAL', osConstants.errno.EINVAL],
    ['EROFS', osConstants.errno.EROFS],
    // A cross-mount rename refusal: the kernel reads EXDEV as "not one
    // filesystem" and mv falls back to copy+unlink, so this may not
    // degrade to EIO on the way out of the mount.
    ['EXDEV', osConstants.errno.EXDEV],
    ['EDQUOT', osConstants.errno.EDQUOT],
  ] as const)('maps the %s code property', (code, expected) => {
    expect(classifyErrno(unnamedFsError(code, 'boom'))).toBe(expected)
  })

  it.each([
    ['directory not empty: /d', osConstants.errno.ENOTEMPTY],
    ['not a directory', osConstants.errno.ENOTDIR],
    ['is a directory', osConstants.errno.EISDIR],
    ['permission denied', osConstants.errno.EACCES],
    ['file exists', osConstants.errno.EEXIST],
    ['no such file or directory', osConstants.errno.ENOENT],
  ])('falls back to the message for %s', (message, expected) => {
    expect(classifyErrno(new Error(message))).toBe(expected)
  })

  it('is case insensitive on messages', () => {
    expect(classifyErrno(new Error('Permission Denied'))).toBe(osConstants.errno.EACCES)
  })

  it('returns EIO for anything unrecognised', () => {
    expect(classifyErrno(new Error('something else entirely'))).toBe(osConstants.errno.EIO)
  })

  it('logs only an error nothing names', () => {
    // A bug in the core would otherwise read only as "I/O error"; an error
    // with a code of its own is an I/O error already.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(classifyErrno(new Error('boom'))).toBe(osConstants.errno.EIO)
      expect(classifyErrno(Object.assign(new Error('bare'), { code: 'EWHATEVER' }))).toBe(
        osConstants.errno.EIO,
      )
      expect(warn.mock.calls).toEqual([['unclassified mount error: Error: boom']])
    } finally {
      warn.mockRestore()
    }
  })

  it('prefers the code property over the message', () => {
    const err = unnamedFsError('ENOTEMPTY', 'no such file or directory')
    expect(classifyErrno(err)).toBe(osConstants.errno.ENOTEMPTY)
  })
})

describe('classifyError', () => {
  it('negates the errno for fuse-native callbacks', () => {
    expect(classifyError(new Error('no such file'))).toBe(-osConstants.errno.ENOENT)
    expect(classifyError(new Error('directory not empty'))).toBe(-osConstants.errno.ENOTEMPTY)
  })

  it('stays in sync with classifyErrno', () => {
    const err = new Error('permission denied')
    expect(classifyError(err)).toBe(-classifyErrno(err))
  })
})

describe('the shared vocabulary', () => {
  // The stamps below are what CycleError and exdev() carry
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
      code: 'EXDEV',
    })
    expect(classifyErrno(cross)).toBe(osConstants.errno.EXDEV)
  })

  it('passes a stamped code outside the vocabulary through', () => {
    // Python's twin forwards a raw OSError errno untouched; the node
    // adapter reads the host's own numbering for the same passthrough.
    const err = Object.assign(new Error('x'), { code: 'ENAMETOOLONG' })
    expect(classifyErrno(err)).toBe(osConstants.errno.ENAMETOOLONG)
  })

  it('logs a policy reason the kernel cannot carry', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      const refused = new PolicyDenied('Permission denied', '/data/x', {
        kind: 'deny',
        reason: 'sealed',
        policy: 'RulePolicy',
        askId: null,
      })
      expect(classifyErrno(refused)).toBe(osConstants.errno.EACCES)
      expect(info).toHaveBeenCalledWith('policy RulePolicy refused /data/x: sealed')
    } finally {
      info.mockRestore()
    }
  })
})
