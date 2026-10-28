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
import { capped, ramPath, tableBytes } from '../../test-utils.ts'
import { rmR } from './rm.ts'

describe('rmR', () => {
  it('removes the subtree and keeps the rest', async () => {
    const [acc] = capped(100, { '/d/a': '1', '/d/e/b': '2', '/da': '3' })
    acc.store.dirs.add('/d').add('/d/e')
    await rmR(acc, ramPath('/d'))
    expect([[...acc.store.files.keys()], [...acc.store.dirs]]).toEqual([['/da'], ['/']])
  })

  it('takes back every removed file bytes against a capacity', async () => {
    const [acc, usage] = capped(5, { '/d/a': '12345', '/d/e/b': '123', '/x': '1' })
    acc.store.dirs.add('/d').add('/d/e')
    await rmR(acc, ramPath('/d'))
    expect([usage.used, tableBytes(acc)]).toEqual([1, 1])
  })
})
