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
import { NO_FOLLOW_OPS, STAMP_WRITE_OPS } from './constants.ts'

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
})
