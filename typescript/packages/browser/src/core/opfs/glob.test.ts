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

import { stripSlash } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { PathSpec } from '@struktoai/mirage-core'
import { makeMockAccessor, spec } from '../../test-utils.ts'
import { resolveGlob } from './glob.ts'
import { writeBytes } from './write.ts'

describe('opfs/glob.resolveGlob', () => {
  it('expands a glob into matching paths', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/a.json'), new Uint8Array())
    await writeBytes(accessor, spec('/b.json'), new Uint8Array())
    await writeBytes(accessor, spec('/c.txt'), new Uint8Array())
    const pattern = new PathSpec({
      resourcePath: stripSlash('/*.json'),
      virtual: '/*.json',
      directory: '/',
      pattern: '*.json',
      resolved: false,
    })
    const out = await resolveGlob(accessor, [pattern])
    const originals = out.map((p) => p.virtual).sort()
    expect(originals).toEqual(['/a.json', '/b.json'])
  })

  it('passes through resolved paths unchanged', async () => {
    const accessor = makeMockAccessor()
    const out = await resolveGlob(accessor, [spec('/x')])
    expect(out.map((p) => p.virtual)).toEqual(['/x'])
  })
})
