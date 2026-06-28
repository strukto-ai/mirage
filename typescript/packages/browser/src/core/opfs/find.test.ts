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
import { find } from './find.ts'
import { mkdir } from './mkdir.ts'
import { writeBytes } from './write.ts'

describe('opfs/find', () => {
  it('returns all entries when no filters', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/a.json'), new Uint8Array())
    await writeBytes(accessor, spec('/b.txt'), new Uint8Array())
    await mkdir(accessor, spec('/sub'))
    await writeBytes(accessor, spec('/sub/c.json'), new Uint8Array())
    const out = await find(accessor, spec('/'))
    expect(out.sort()).toEqual(['/', '/a.json', '/b.txt', '/sub', '/sub/c.json'])
  })

  it('filters by name pattern', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/a.json'), new Uint8Array())
    await writeBytes(accessor, spec('/b.txt'), new Uint8Array())
    const out = await find(accessor, spec('/'), { name: '*.json' })
    expect(out).toEqual(['/a.json'])
  })
})
