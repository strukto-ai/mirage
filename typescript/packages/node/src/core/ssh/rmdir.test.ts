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
import { PathSpec } from '@struktoai/mirage-core/types'
import { exists } from './exists.ts'
import { makeFakeAccessor } from '../../../tests/core/ssh/_test_utils.ts'
import { rmdir } from './rmdir.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/rmdir', () => {
  it('removes an empty directory', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/d', {}],
      ]),
    })
    await rmdir(accessor, spec('/d'))
    expect(await exists(accessor, spec('/d'))).toBe(false)
  })

  it('converts the version-3 not-empty refusal to ENOTEMPTY', async () => {
    // SFTP 3 answers a not-empty rmdir with its one generic FAILURE
    // code; the listing probe converts it so the boundary speaks
    // errno, which is what the hidden-remnant guard keys on.
    const accessor = makeFakeAccessor({
      files: new Map([['/d/x', { data: new Uint8Array() }]]),
      dirs: new Map([
        ['/', {}],
        ['/d', {}],
      ]),
    })
    await expect(rmdir(accessor, spec('/d'))).rejects.toMatchObject({ code: 'ENOTEMPTY' })
  })

  it('throws ENOENT when missing', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await expect(rmdir(accessor, spec('/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
