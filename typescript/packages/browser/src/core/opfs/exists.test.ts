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
import { makeMockAccessor, spec } from '../../test-utils.ts'
import { exists } from './exists.ts'
import { write } from './write.ts'

describe('opfs/exists', () => {
  it('true for existing file', async () => {
    const accessor = makeMockAccessor()
    await write(accessor, spec('/x'), new Uint8Array())
    expect(await exists(accessor, spec('/x'))).toBe(true)
  })
  it('false for missing', async () => {
    const accessor = makeMockAccessor()
    expect(await exists(accessor, spec('/nope'))).toBe(false)
  })
})
