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

import { VFSName } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { exists } from '../../core/opfs/exists.ts'
import { makeMockAccessor, spec } from '../../test-utils.ts'
import { OPFS_OPS } from './index.ts'

const byName = (name: string): (typeof OPFS_OPS)[number] => {
  const op = OPFS_OPS.find((o) => o.name === name)
  if (op === undefined) throw new Error(`no ${name} op`)
  return op
}

describe('OPFS_OPS', () => {
  it('contains all 11 OPFS op names', () => {
    expect(new Set(OPFS_OPS.map((o) => o.name))).toEqual(
      new Set([
        'append',
        'create',
        'mkdir',
        'read',
        'readdir',
        'rename',
        'rmdir',
        'stat',
        'truncate',
        'unlink',
        'write',
      ]),
    )
  })

  it('every op targets VFSName.OPFS', () => {
    for (const op of OPFS_OPS) expect(op.vfs).toBe(VFSName.OPFS)
  })

  it('write-side ops are flagged write:true', () => {
    expect(new Set(OPFS_OPS.filter((o) => o.write).map((o) => o.name))).toEqual(
      new Set(['append', 'create', 'mkdir', 'rename', 'rmdir', 'truncate', 'unlink', 'write']),
    )
  })

  it('mkdir creates intermediate directories', async () => {
    // Pins the mkdirParents option: without it the factory calls the
    // core mkdir with parents defaulted to false.
    const accessor = makeMockAccessor()
    await byName('mkdir').fn(accessor, spec('/a/b/c'), [], {})
    expect(await exists(accessor, spec('/a/b/c'))).toBe(true)
  })
})
