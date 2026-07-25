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
import {
  eacces,
  eaccesReadOnly,
  enoent,
  enotsup,
  enotdir,
  formatFsError,
  fsStrerror,
  isFsError,
  isMissingPath,
  noMount,
} from './errors.ts'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const DEC = new TextDecoder()

describe('formatFsError', () => {
  it('prefixes a thrown command error with the command name (GNU prog: message)', () => {
    const line = decode(
      formatFsError(
        'slack-add-reaction',
        new Error('Slack API error (reactions.add): message_not_found'),
      ),
    )
    expect(line).toBe('slack-add-reaction: Slack API error (reactions.add): message_not_found\n')
  })

  it('stringifies a non-Error throw', () => {
    expect(decode(formatFsError('slack-add-reaction', 'boom'))).toBe('slack-add-reaction: boom\n')
  })

  it('does not double the prefix when the message already carries cmd:', () => {
    // Generic commands throw a fully GNU-formatted message (uniq: invalid
    // count); the prefix must not be doubled (uniq: uniq: ...).
    expect(decode(formatFsError('uniq', new Error("uniq: invalid count: '2junk'")))).toBe(
      "uniq: invalid count: '2junk'\n",
    )
  })

  it('renders a recognized filesystem error as cmd: path: strerror', () => {
    expect(decode(formatFsError('cat', enoent('/b/missing.txt')))).toBe(
      'cat: /b/missing.txt: No such file or directory\n',
    )
  })

  it('rewrites the resolved path to the as-typed spelling', () => {
    const line = decode(
      formatFsError('diff', enoent('/a/missing.txt'), [
        { virtual: '/a/missing.txt', rawPath: 'missing.txt' },
      ]),
    )
    expect(line).toBe('diff: missing.txt: No such file or directory\n')
  })
})

describe('enotsup', () => {
  it('carries the op and the operand', () => {
    const err = enotsup('email', 'unlink', '/mail/inbox/a.txt')
    expect(err.code).toBe('ENOTSUP')
    expect(err.op).toBe('unlink')
    expect(err.virtualPath).toBe('/mail/inbox/a.txt')
    expect(err.message).toContain('no op registered: unlink')
  })

  it('is a recognized fs error with GNU strerror text', () => {
    const err = enotsup('email', 'unlink', '/mail/a.txt')
    expect(isFsError(err)).toBe(true)
    expect(fsStrerror(err)).toBe('Operation not supported')
  })

  it('formats as a GNU operand line at the chokepoint', () => {
    const line = formatFsError('mv', enotsup('email', 'unlink', '/mail/a.txt'))
    expect(DEC.decode(line)).toBe('mv: /mail/a.txt: Operation not supported\n')
  })
})

describe('eaccesReadOnly', () => {
  it('keeps the read-only message while stamping EACCES and the operand', () => {
    const err = eaccesReadOnly("mount '/mail/' is read-only", '/mail/a.txt')
    expect(err.code).toBe('EACCES')
    expect(err.virtualPath).toBe('/mail/a.txt')
    expect(err.message).toContain('read-only')
    expect(fsStrerror(err)).toBe('Permission denied')
  })
})

describe('noMount', () => {
  it('keeps the Python message text and carries no POSIX code', () => {
    const err = noMount('/nowhere/x')
    expect(err.message).toBe('no mount matches path: /nowhere/x')
    expect(isFsError(err)).toBe(false)
    expect(fsStrerror(err)).toBeNull()
  })
})

describe('isMissingPath', () => {
  it('accepts the two Python swallows: FileNotFoundError and the no-mount ValueError', () => {
    expect(isMissingPath(enoent('/x'))).toBe(true)
    expect(isMissingPath(noMount('/nowhere/x'))).toBe(true)
  })

  it('rejects every other failure, including other fs errors', () => {
    expect(isMissingPath(eacces('/x'))).toBe(false)
    expect(isMissingPath(enotdir('/x'))).toBe(false)
    expect(isMissingPath(enotsup('email', 'stat', '/mail/a.txt'))).toBe(false)
    expect(isMissingPath(new Error('401 Unauthorized'))).toBe(false)
    expect(isMissingPath(undefined)).toBe(false)
  })
})

describe('fsStrerror', () => {
  it('maps recognized codes and returns null otherwise', () => {
    expect(fsStrerror(enoent('/x'))).toBe('No such file or directory')
    expect(fsStrerror(eacces('/x'))).toBe('Permission denied')
    expect(fsStrerror(new Error('nope'))).toBeNull()
  })
})
