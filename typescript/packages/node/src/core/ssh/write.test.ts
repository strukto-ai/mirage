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
import { PathSpec, ResourceName, runWithRecording } from '@struktoai/mirage-core'
import { makeFakeAccessor } from './_test_utils.ts'
import { read } from './read.ts'
import { writeBytes } from './write.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/write', () => {
  it('writes bytes to a new file', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await writeBytes(accessor, spec('/data/a.txt'), new TextEncoder().encode('hello'))
    const out = await read(accessor, spec('/data/a.txt'))
    expect(new TextDecoder().decode(out)).toBe('hello')
  })

  it('overwrites an existing file', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: new TextEncoder().encode('old') }]]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await writeBytes(accessor, spec('/data/a.txt'), new TextEncoder().encode('new'))
    const out = await read(accessor, spec('/data/a.txt'))
    expect(new TextDecoder().decode(out)).toBe('new')
  })

  it('respects the configured root', async () => {
    const accessor = makeFakeAccessor(
      {
        files: new Map(),
        dirs: new Map([
          ['/srv', {}],
          ['/srv/data', {}],
        ]),
      },
      '/srv',
    )
    await writeBytes(accessor, spec('/data/a.txt'), new TextEncoder().encode('rooted'))
    const out = await read(accessor, spec('/data/a.txt'))
    expect(new TextDecoder().decode(out)).toBe('rooted')
  })

  it('records the write for command history', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    const [, records] = await runWithRecording(async () => {
      await writeBytes(accessor, spec('/data/a.txt'), new TextEncoder().encode('hello'))
    })
    expect(records).toHaveLength(1)
    expect(records[0]?.op).toBe('write')
    expect(records[0]?.source).toBe(ResourceName.SSH)
    expect(records[0]?.bytes).toBe(5)
  })
})
