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
import { RAMAccessor } from '../../accessor/ram.ts'
import { RAMStore } from '../../vfs/ram/store.ts'
import { PathSpec } from '../../types.ts'
import { read } from './read.ts'

describe('read (RAM)', () => {
  it('throws EISDIR for a directory and ENOENT for a missing key', async () => {
    const store = new RAMStore()
    store.dirs.add('/sub')
    const accessor = new RAMAccessor(store)
    await expect(async () => read(accessor, PathSpec.fromStrPath('/sub'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    await expect(async () => read(accessor, PathSpec.fromStrPath('/nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
