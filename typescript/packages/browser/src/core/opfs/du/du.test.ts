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
import { makeMockAccessor, spec } from '../../../test-utils.ts'
import { size } from './index.ts'
import { mkdir } from '../mkdir.ts'
import { writeBytes } from '../write.ts'

describe('opfs/du', () => {
  it('sums file sizes under a path', async () => {
    const accessor = makeMockAccessor()
    await mkdir(accessor, spec('/d'))
    await writeBytes(accessor, spec('/d/a'), new Uint8Array([1, 2, 3]))
    await writeBytes(accessor, spec('/d/b'), new Uint8Array([4, 5]))
    expect(await size(accessor, spec('/d'))).toBe(5)
  })
  it('returns 0 for missing', async () => {
    const accessor = makeMockAccessor()
    expect(await size(accessor, spec('/missing'))).toBe(0)
  })
})
