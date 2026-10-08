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
  DISPATCH_READ_OPS,
  DISPATCH_WRITE_OPS,
  ENTRY_CREATE_OPS,
  FILE_CREATE_OPS,
  HIDDEN_CREATE_OPS,
  NAMESPACE_TABLE_OPS,
  NO_FOLLOW_OPS,
  POLICY_WRITE_OPS,
  SERIAL_WRITE_OPS,
  STAMP_WRITE_OPS,
} from './constants.ts'

const sorted = (names: ReadonlySet<string>): string[] => [...names].sort()

describe('dispatcher op sets', () => {
  it('never follows a link-entry op', () => {
    // lstat semantics: the operand names the link itself, so no stat
    // surface may rewrite it through the table.
    expect([...NO_FOLLOW_OPS].sort()).toEqual(
      ['readlink', 'rename', 'rmdir', 'symlink', 'unlink'].sort(),
    )
  })

  it('does not stamp an mtime for a removal', () => {
    expect(STAMP_WRITE_OPS.has('unlink')).toBe(false)
    expect(STAMP_WRITE_OPS.has('rmdir')).toBe(false)
    expect(STAMP_WRITE_OPS.has('write')).toBe(true)
  })

  it('follows the declarations', () => {
    // Every class is read off what the functions declare; this pins the
    // result so a declaration that moves an op between classes is seen.
    const writes = ['append', 'create', 'pwrite', 'truncate', 'write']
    expect(sorted(DISPATCH_READ_OPS)).toEqual(['read'])
    expect(sorted(DISPATCH_WRITE_OPS)).toEqual(
      [...writes, 'mkdir', 'rename', 'rmdir', 'unlink'].sort(),
    )
    expect(sorted(POLICY_WRITE_OPS)).toEqual(
      [...DISPATCH_WRITE_OPS, 'removexattr', 'setattr', 'setxattr', 'symlink'].sort(),
    )
    expect(sorted(NAMESPACE_TABLE_OPS)).toEqual(['readlink', 'symlink'])
    expect(sorted(SERIAL_WRITE_OPS)).toEqual([...writes, 'rename', 'unlink'].sort())
    expect(sorted(FILE_CREATE_OPS)).toEqual(writes)
    expect(sorted(ENTRY_CREATE_OPS)).toEqual(['mkdir', 'symlink'])
    expect(sorted(HIDDEN_CREATE_OPS)).toEqual([...writes, 'mkdir', 'symlink'].sort())
    expect(sorted(STAMP_WRITE_OPS)).toEqual([...writes, 'mkdir'].sort())
  })
})
