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
import { makeFakeAccessor } from '../../../tests/core/ssh/_test_utils.ts'
import { read } from './read.ts'
import { truncate } from './truncate.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/truncate', () => {
  it('shrinks a file to a smaller length', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: new TextEncoder().encode('hello world') }]]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await truncate(accessor, spec('/data/a.txt'), 5)
    const out = await read(accessor, spec('/data/a.txt'))
    expect(new TextDecoder().decode(out)).toBe('hello')
  })

  it('extends a file with zero bytes', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: new TextEncoder().encode('ab') }]]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await truncate(accessor, spec('/data/a.txt'), 5)
    const out = await read(accessor, spec('/data/a.txt'))
    expect(out.byteLength).toBe(5)
    expect(out[0]).toBe('a'.charCodeAt(0))
    expect(out[1]).toBe('b'.charCodeAt(0))
    expect(out[2]).toBe(0)
    expect(out[3]).toBe(0)
    expect(out[4]).toBe(0)
  })
})
