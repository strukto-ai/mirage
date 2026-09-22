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
import { specOf } from '../../../../commands/spec/builtins.ts'
import { parseCommand } from '../../../../commands/spec/parser.ts'
import { eexist, enoent, noXattr } from '../../../../utils/errors.ts'
import { GETFATTR_USAGE, attrError, attrOperands, attrUsageRefusal } from './xattr.ts'

describe('attr helpers', () => {
  it('say No such attribute whatever the platform errno', () => {
    expect(attrError(noXattr('/f'))).toBe('No such attribute')
    expect(attrError(eexist('/f'))).toBe('File exists')
    expect(attrError(enoent('/f'))).toBe('No such file or directory')
  })

  it('resolve operands against the cwd and keep the typed word', () => {
    const parsed = parseCommand(specOf('getfattr'), ['-d', 'd/f', '/abs'], '/r', 'getfattr')
    expect(attrOperands(parsed).map((p) => [p.virtual, p.rawPath])).toEqual([
      ['/r/d/f', 'd/f'],
      ['/abs', '/abs'],
    ])
  })

  it("render getopt's line then the usage block, exit 2", () => {
    const refused = parseCommand(specOf('getfattr'), ['-Z', 'f'], '/', 'getfattr')
    const [, io] = attrUsageRefusal('getfattr', refused, GETFATTR_USAGE) ?? []
    expect(io?.exitCode).toBe(2)
    expect(new TextDecoder().decode(io?.stderr as Uint8Array)).toBe(
      "getfattr: invalid option -- 'Z'\n" + GETFATTR_USAGE,
    )
    const fine = parseCommand(specOf('getfattr'), ['-d', 'f'], '/', 'getfattr')
    expect(attrUsageRefusal('getfattr', fine, GETFATTR_USAGE)).toBeNull()
  })
})
