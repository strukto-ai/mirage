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
  formatFsError,
  fsStrerror,
  isFsError,
} from './errors.ts'

const DEC = new TextDecoder()

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

describe('fsStrerror', () => {
  it('maps recognized codes and returns null otherwise', () => {
    expect(fsStrerror(enoent('/x'))).toBe('No such file or directory')
    expect(fsStrerror(eacces('/x'))).toBe('Permission denied')
    expect(fsStrerror(new Error('nope'))).toBeNull()
  })
})
