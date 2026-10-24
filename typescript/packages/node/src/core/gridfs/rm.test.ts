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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileStat } from '@struktoai/mirage-core/types'
import type * as ClientModule from './client.ts'
import {
  FakeStore,
  makeAccessor,
  mockedClient,
  spec,
} from '../../../tests/core/gridfs/_test_util.ts'

let store = new FakeStore()

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return mockedClient(actual, () => store)
})

import { readdir } from './readdir.ts'
import { rmR } from './rm.ts'

const X = new TextEncoder().encode('x')

// Twins of tests/core/gridfs/test_rm.py.
describe('gridfs rm -r', () => {
  beforeEach(() => {
    store = new FakeStore()
  })

  it('trashes the subtree and its marker', async () => {
    for (const name of ['d/', 'd/f.txt', 'd/f.txt', 'd/sub/g.txt', 'keep.txt'])
      store.upload(name, X)
    const f = store.ids('d/f.txt')
    const g = store.ids('d/sub/g.txt')
    const accessor = makeAccessor(store)
    await rmR(accessor, spec('d'))
    expect([...store.names()].sort()).toEqual([
      '/trash/d/',
      '/trash/d/f.txt',
      '/trash/d/f.txt',
      '/trash/d/sub/g.txt',
      'keep.txt',
    ])
    expect(store.ids('/trash/d/f.txt')).toEqual(f)
    expect(store.ids('/trash/d/sub/g.txt')).toEqual(g)
    expect(((await readdir(accessor, spec(''))) as FileStat[]).map((row) => row.name)).toEqual([
      'keep.txt',
    ])
  })

  it('prunes the trash under retention', async () => {
    for (const name of ['d/f.txt', 'd/f.txt', 'd/f.txt', 'd/g.txt']) store.upload(name, X)
    const f = store.ids('d/f.txt')
    await rmR(makeAccessor(store, { keepRevisions: 2 }), spec('d'))
    expect(store.ids('/trash/d/f.txt')).toEqual(f.slice(1))
    expect(store.ids('/trash/d/g.txt')).toHaveLength(1)
    expect(store.chunks.has(String(f[0]))).toBe(false)
  })
})
