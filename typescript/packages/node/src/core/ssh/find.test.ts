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
import { makeFakeAccessor } from './_test_utils.ts'
import { find } from './find.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/find', () => {
  it('returns all entries when no filters', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/a.json', { data: new Uint8Array() }],
        ['/b.txt', { data: new Uint8Array() }],
        ['/sub/c.json', { data: new Uint8Array() }],
      ]),
      dirs: new Map([
        ['/', {}],
        ['/sub', {}],
      ]),
    })
    const out = await find(accessor, spec('/'))
    expect(out).toEqual(['/', '/a.json', '/b.txt', '/sub', '/sub/c.json'])
  })

  it('filters by name pattern (*.json)', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/a.json', { data: new Uint8Array() }],
        ['/b.txt', { data: new Uint8Array() }],
        ['/sub/c.json', { data: new Uint8Array() }],
      ]),
      dirs: new Map([
        ['/', {}],
        ['/sub', {}],
      ]),
    })
    const out = await find(accessor, spec('/'), { name: '*.json' })
    expect(out).toEqual(['/a.json', '/sub/c.json'])
  })

  it('respects type filter "d"', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/a.json', { data: new Uint8Array() }],
        ['/sub/c.json', { data: new Uint8Array() }],
      ]),
      dirs: new Map([
        ['/', {}],
        ['/sub', {}],
      ]),
    })
    const out = await find(accessor, spec('/'), { type: 'd' })
    expect(out).toEqual(['/', '/sub'])
  })

  it('respects maxDepth', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/a.json', { data: new Uint8Array() }],
        ['/b.txt', { data: new Uint8Array() }],
        ['/sub/c.json', { data: new Uint8Array() }],
      ]),
      dirs: new Map([
        ['/', {}],
        ['/sub', {}],
      ]),
    })
    const out = await find(accessor, spec('/'), { maxDepth: 1, type: 'f' })
    expect(out).toEqual(['/a.json', '/b.txt'])
    expect(await find(accessor, spec('/'), { maxDepth: 0, type: 'f' })).toEqual([])
  })

  it('size filters apply to files only, directories pass', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/one.txt', { data: new Uint8Array(1) }],
        ['/big.txt', { data: new Uint8Array(100) }],
        ['/sub/f.txt', { data: new Uint8Array(100) }],
      ]),
      dirs: new Map([
        ['/', {}],
        ['/sub', { size: 4096 }],
      ]),
    })
    const out = await find(accessor, spec('/'), { maxSize: 5 })
    expect(out).toEqual(['/', '/one.txt', '/sub'])
  })

  it('does not emit the start directory under -type f', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/sub/c.json', { data: new Uint8Array() }],
        ['/sub/deep/d.json', { data: new Uint8Array() }],
      ]),
      dirs: new Map([
        ['/', {}],
        ['/sub', {}],
        ['/sub/deep', {}],
      ]),
    })
    const files = await find(accessor, spec('/sub'), { type: 'f' })
    expect(files).toEqual(['/sub/c.json', '/sub/deep/d.json'])
    expect(files).not.toContain('/sub')
    const dirs = await find(accessor, spec('/sub'), { type: 'd' })
    expect(dirs).toContain('/sub')
  })

  it('returns empty for missing root', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    expect(await find(accessor, spec('/missing'))).toEqual([])
  })
})
