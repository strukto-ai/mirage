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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { FileType } from '../../types.ts'
import { codeOf, FakeAccessor, FakeStore, makeDriver, spec } from './fakes.ts'
import { makeReaddir, makeTree } from './readdir.ts'

const accessor = new FakeAccessor()

describe('object_store readdir', () => {
  it('lists files and collapsed dirs', async () => {
    const store = new FakeStore({ 'a.txt': 'hi', 'dir/f.txt': 'x', 'dir/sub/g': 'y' })
    const readdir = makeReaddir(makeDriver(store))
    await expect(readdir(accessor, spec('/'))).resolves.toEqual(['/mnt/a.txt', '/mnt/dir'])
  })

  it('reads a marker-only directory as empty, not missing', async () => {
    const store = new FakeStore({ 'empty/': '' })
    const readdir = makeReaddir(makeDriver(store))
    await expect(readdir(accessor, spec('/empty'))).resolves.toEqual([])
  })

  it('reports ENOENT for a missing path', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const readdir = makeReaddir(makeDriver(store))
    await expect(codeOf(readdir(accessor, spec('/never')))).resolves.toBe('ENOENT')
  })

  it('reports ENOTDIR on a file', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const readdir = makeReaddir(makeDriver(store))
    await expect(codeOf(readdir(accessor, spec('/a.txt')))).resolves.toBe('ENOTDIR')
  })

  it('does not raise on the root of an empty store', async () => {
    const readdir = makeReaddir(makeDriver(new FakeStore()))
    await expect(readdir(accessor, spec('/'))).resolves.toEqual([])
  })

  it('populates the index', async () => {
    const store = new FakeStore({ 'a.txt': 'hi', 'dir/f.txt': 'x' })
    const readdir = makeReaddir(makeDriver(store))
    const index = new RAMIndexCacheStore()
    await readdir(accessor, spec('/'), index)
    const lookup = await index.get('/mnt/a.txt')
    expect(lookup.entry).not.toBeNull()
    expect(lookup.entry?.size).toBe(2)
    const folder = await index.get('/mnt/dir')
    expect(folder.entry).not.toBeNull()
    expect(folder.entry?.size).toBeNull()
  })

  it('serves a cached listing without connecting', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const readdir = makeReaddir(makeDriver(store))
    const index = new RAMIndexCacheStore()
    const first = await readdir(accessor, spec('/'), index)
    const connects = store.connects
    const second = await readdir(accessor, spec('/'), index)
    expect(second).toEqual(first)
    expect(store.connects).toBe(connects)
  })
})

// Mirrors the make_tree tests in test_readdir.py.
describe('object_store makeTree', () => {
  it('answers each entry and implied directory', async () => {
    const store = new FakeStore({ 'a.txt': 'hi', 'dir/sub/f.txt': 'x', '/': '' })
    const found = await makeTree(makeDriver(store))(accessor, spec('/'))
    expect([...(found ?? new Map()).keys()].sort()).toEqual([
      'a.txt',
      'dir',
      'dir/sub',
      'dir/sub/f.txt',
    ])
    expect(found?.get('dir/sub/f.txt')?.size).toBe(1)
    expect(found?.get('dir')?.type).toBe(FileType.DIRECTORY)
  })

  it.each([
    ['file-and-prefix', { 'dir/a': 'f', 'dir/a/b.txt': 'x' }],
    ['empty-segment', { 'dir/a//b.txt': 'x' }],
  ])('declines what readdir lists its own way: %s', async (_label, objects) => {
    const tree = makeTree(makeDriver(new FakeStore(objects)))
    await expect(tree(accessor, spec('/dir'))).resolves.toBeNull()
  })

  it('declines a row without a size', async () => {
    const driver = {
      ...makeDriver(new FakeStore({ 'dir/a.txt': 'x' })),
      // eslint-disable-next-line @typescript-eslint/require-await
      listSubtree: async function* () {
        yield { key: 'dir/a.txt' }
      },
    }
    await expect(makeTree(driver)(accessor, spec('/dir'))).resolves.toBeNull()
  })
})
