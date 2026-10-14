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
import { FileType, PathSpec } from '@struktoai/mirage-core/types'
import { makeFakeAccessor } from './_test_utils.ts'
import { mkdir } from './mkdir.ts'
import { stat } from './stat.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/mkdir', () => {
  it('creates a single directory', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await mkdir(accessor, spec('/d'), false)
    const s = await stat(accessor, spec('/d'))
    expect(s.type).toBe(FileType.DIRECTORY)
  })

  it('creates parents when recursive', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await mkdir(accessor, spec('/a/b/c'), true)
    expect((await stat(accessor, spec('/a'))).type).toBe(FileType.DIRECTORY)
    expect((await stat(accessor, spec('/a/b'))).type).toBe(FileType.DIRECTORY)
    expect((await stat(accessor, spec('/a/b/c'))).type).toBe(FileType.DIRECTORY)
  })

  it('is idempotent on existing directory when recursive', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/d', {}],
      ]),
    })
    await expect(mkdir(accessor, spec('/d'), true)).resolves.toBeUndefined()
  })

  it('fails when parent missing and not recursive', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await expect(mkdir(accessor, spec('/a/b'), false)).rejects.toThrow()
  })
})
