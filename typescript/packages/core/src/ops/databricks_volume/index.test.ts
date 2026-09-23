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
import { DATABRICKS_VOLUME_OPS } from './index.ts'

describe('DATABRICKS_VOLUME_OPS', () => {
  it('exposes the same ten ops as Python', () => {
    const names = DATABRICKS_VOLUME_OPS.map((op) => op.name).sort()
    expect(names).toEqual([
      'append',
      'create',
      'mkdir',
      'read',
      'readdir',
      'rename',
      'rmdir',
      'stat',
      'unlink',
      'write',
    ])
  })

  it('marks mutating ops as writes', () => {
    const writes = new Set(
      DATABRICKS_VOLUME_OPS.filter((op) => (op as { write?: boolean }).write === true).map(
        (op) => op.name,
      ),
    )
    expect(writes).toEqual(
      new Set(['append', 'create', 'mkdir', 'rename', 'rmdir', 'unlink', 'write']),
    )
  })

  it('targets the databricks_volume VFS', () => {
    for (const op of DATABRICKS_VOLUME_OPS) {
      expect(op.vfs).toBe(VFSName.DATABRICKS_VOLUME)
      expect(op.filetype).toBeNull()
    }
  })
})
