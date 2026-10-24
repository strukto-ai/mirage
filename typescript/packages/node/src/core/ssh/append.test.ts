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
import { append } from './append.ts'
import { makeFakeAccessor } from '../../../tests/core/ssh/_test_utils.ts'
import { read } from './read.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/append', () => {
  it('creates a new file when missing', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await append(accessor, spec('/data/a.txt'), new TextEncoder().encode('hi'))
    const out = await read(accessor, spec('/data/a.txt'))
    expect(new TextDecoder().decode(out)).toBe('hi')
  })

  it('appends to an existing file', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: new TextEncoder().encode('hello ') }]]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await append(accessor, spec('/data/a.txt'), new TextEncoder().encode('world'))
    const out = await read(accessor, spec('/data/a.txt'))
    expect(new TextDecoder().decode(out)).toBe('hello world')
  })
})
