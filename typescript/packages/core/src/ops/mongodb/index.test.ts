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
import { VFSName } from '../../types.ts'
import { MONGODB_OPS } from './index.ts'

describe('MONGODB_OPS', () => {
  it('registers exactly read, readdir, and stat for the mongodb VFS', () => {
    expect(MONGODB_OPS.map((o) => o.name).sort()).toEqual(['read', 'readdir', 'stat'])
  })

  it('all ops target VFSName.MONGODB and are read-only', () => {
    for (const op of MONGODB_OPS) {
      expect(op.vfs).toBe(VFSName.MONGODB)
      expect(op.write).toBe(false)
      expect(op.filetype).toBeNull()
    }
  })
})
