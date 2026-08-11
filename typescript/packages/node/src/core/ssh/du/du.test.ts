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
import { PathSpec } from '@struktoai/mirage-core'
import { makeFakeAccessor } from '../_test_utils.ts'
import { size, entries } from './index.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/du', () => {
  it('returns total bytes under a directory', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/d/a', { data: new Uint8Array([1, 2, 3]) }],
        ['/d/b', { data: new Uint8Array([4, 5]) }],
      ]),
      dirs: new Map([
        ['/', {}],
        ['/d', {}],
      ]),
    })
    expect(await size(accessor, spec('/d'))).toBe(5)
  })

  it('recurses into subdirectories', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/d/a', { data: new Uint8Array([1, 2, 3]) }],
        ['/d/sub/b', { data: new Uint8Array([4, 5, 6, 7]) }],
      ]),
      dirs: new Map([
        ['/', {}],
        ['/d', {}],
        ['/d/sub', {}],
      ]),
    })
    expect(await size(accessor, spec('/d'))).toBe(7)
  })

  it('returns 0 for missing path', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    expect(await size(accessor, spec('/missing'))).toBe(0)
  })
})

describe('core/ssh/du.duEntries', () => {
  it('returns sorted entries with sizes and total', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/b', { data: new Uint8Array([1, 2]) }],
        ['/a', { data: new Uint8Array([3]) }],
      ]),
      dirs: new Map([['/', {}]]),
    })
    const [found, total] = await entries(accessor, spec('/'))
    expect(found.map((e: [string, number]) => e[0])).toEqual(['/a', '/b'])
    expect(total).toBe(3)
  })
})
