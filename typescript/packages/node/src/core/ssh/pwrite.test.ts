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
import { pwrite } from './pwrite.ts'
import { read } from './read.ts'

const ENC = new TextEncoder()

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

function dirs(): Map<string, object> {
  return new Map([
    ['/', {}],
    ['/data', {}],
  ])
}

describe('core/ssh/pwrite', () => {
  it('writes at the offset and keeps the rest', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: ENC.encode('hello') }]]),
      dirs: dirs(),
    })
    await pwrite(accessor, spec('/data/a.txt'), ENC.encode('XY'), 1)
    expect(new TextDecoder().decode(await read(accessor, spec('/data/a.txt')))).toBe('hXYlo')
  })

  it('creates a missing file and fills the gap with zeros', async () => {
    const accessor = makeFakeAccessor({ files: new Map(), dirs: dirs() })
    await pwrite(accessor, spec('/data/a.txt'), ENC.encode('z'), 2)
    expect([...(await read(accessor, spec('/data/a.txt')))]).toEqual([0, 0, 122])
  })
})
