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
import { runWithCacheManager, type CacheInvalidator } from '@struktoai/mirage-core/cache/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { exists } from './exists.ts'
import { makeFakeAccessor } from './_test_utils.ts'
import { read } from './read.ts'
import { rename } from './rename.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/rename', () => {
  it('renames a file', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: new TextEncoder().encode('hi') }]]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    await rename(accessor, spec('/data/a.txt'), spec('/data/b.txt'))
    expect(await exists(accessor, spec('/data/a.txt'))).toBe(false)
    const out = await read(accessor, spec('/data/b.txt'))
    expect(new TextDecoder().decode(out)).toBe('hi')
  })

  it('renames a directory', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/old/x.txt', { data: new Uint8Array() }]]),
      dirs: new Map([
        ['/', {}],
        ['/old', {}],
      ]),
    })
    await rename(accessor, spec('/old'), spec('/new'))
    expect(await exists(accessor, spec('/old'))).toBe(false)
    expect(await exists(accessor, spec('/new'))).toBe(true)
    expect(await exists(accessor, spec('/new/x.txt'))).toBe(true)
  })

  it('throws ENOENT for missing source', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await expect(rename(accessor, spec('/missing'), spec('/dst'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('core/ssh/rename invalidation', () => {
  it('a renamed file still drops both subtrees', async () => {
    // A blind SFTP rename never learns what it moved, and asking costs a
    // round trip, so even a file keeps the subtree on both ends.
    const seen: string[] = []
    const manager = {
      invalidateAfterMove: (path: PathSpec, folder: boolean) => {
        seen.push(`${folder ? 'subtree' : 'unlink'} ${path.virtual}`)
        return Promise.resolve()
      },
      invalidateSubtree: (path: PathSpec) => {
        seen.push(`subtree ${path.virtual}`)
        return Promise.resolve()
      },
    } as unknown as CacheInvalidator
    const accessor = makeFakeAccessor({
      files: new Map([['/a.txt', { data: new TextEncoder().encode('hi') }]]),
      dirs: new Map([['/', {}]]),
    })
    await runWithCacheManager(manager, () => rename(accessor, spec('/a.txt'), spec('/b.txt')))
    expect(seen).toEqual(['subtree /b.txt', 'subtree /a.txt'])
  })
})
