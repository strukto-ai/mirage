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
import { exists } from './exists.ts'
import { makeFakeAccessor } from '../../../tests/core/ssh/_test_utils.ts'
import { rmR } from './rm.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/rm.rmR', () => {
  it('removes a single file', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: new Uint8Array() }]]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await rmR(accessor, spec('/data/a.txt'))
    expect(await exists(accessor, spec('/data/a.txt'))).toBe(false)
  })

  it('recursively removes a directory tree with nested files', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/d/a.txt', { data: new Uint8Array() }],
        ['/d/sub/b.txt', { data: new Uint8Array() }],
        ['/d/sub/deep/c.txt', { data: new Uint8Array() }],
      ]),
      dirs: new Map([
        ['/', {}],
        ['/d', {}],
        ['/d/sub', {}],
        ['/d/sub/deep', {}],
      ]),
    })
    await rmR(accessor, spec('/d'))
    expect(await exists(accessor, spec('/d'))).toBe(false)
    expect(await exists(accessor, spec('/d/a.txt'))).toBe(false)
    expect(await exists(accessor, spec('/d/sub/b.txt'))).toBe(false)
    expect(await exists(accessor, spec('/d/sub/deep/c.txt'))).toBe(false)
  })

  it('throws ENOENT on missing path', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await expect(rmR(accessor, spec('/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
