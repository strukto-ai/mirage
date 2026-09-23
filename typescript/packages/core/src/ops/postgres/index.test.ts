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

import { VFSName } from '../../types.ts'
import { describe, expect, it } from 'vitest'
import { POSTGRES_OPS } from './index.ts'

describe('POSTGRES_OPS', () => {
  it('registers exactly read, readdir, and stat for the postgres VFS', () => {
    expect(POSTGRES_OPS.map((o) => o.name).sort()).toEqual(['read', 'readdir', 'stat'])
  })

  it('all ops target VFSName.POSTGRES and are read-only', () => {
    for (const op of POSTGRES_OPS) {
      expect(op.vfs).toBe(VFSName.POSTGRES)
      expect(op.write).toBe(false)
      expect(op.filetype).toBeNull()
    }
  })
})
