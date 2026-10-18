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
import { makeMockAccessor, spec } from '../../../tests/test-utils.ts'
import { exists } from './exists.ts'
import { mkdir } from './mkdir.ts'
import { rmdir } from './rmdir.ts'

describe('opfs/rmdir', () => {
  it('removes an empty directory', async () => {
    const accessor = makeMockAccessor()
    await mkdir(accessor, spec('/d'))
    await rmdir(accessor, spec('/d'))
    expect(await exists(accessor, spec('/d'))).toBe(false)
  })
  it('is a no-op on missing', async () => {
    const accessor = makeMockAccessor()
    await expect(rmdir(accessor, spec('/missing'))).resolves.toBeUndefined()
  })
})
