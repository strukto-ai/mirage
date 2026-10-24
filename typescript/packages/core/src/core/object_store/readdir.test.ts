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
import { DirListing, type FileStat, FileType } from '../../types.ts'
import {
  codeOf,
  FakeAccessor,
  FakeStore,
  makeDriver,
  spec,
} from '../../../tests/core/object_store/fakes.ts'
import { makeReaddir, makeTree } from './readdir.ts'

const accessor = new FakeAccessor()

describe('object_store readdir', () => {
  it('lists files and collapsed dirs', async () => {
    const store = new FakeStore({ 'a.txt': 'hi', 'dir/f.txt': 'x', 'dir/sub/g': 'y' })
    const readdir = makeReaddir(makeDriver(store))
    const rows = (await readdir(accessor, spec('/'))) as FileStat[]
    expect(rows.map((row) => [row.name, row.type, row.size])).toEqual([
      ['a.txt', FileType.FILE, 2],
      ['dir', FileType.DIRECTORY, null],
    ])
  })

  it('lists a name that is a key and a prefix as a directory', async () => {
    const store = new FakeStore({ csv: 'file', 'csv/inner.txt': 'x' })
    const rows = (await makeReaddir(makeDriver(store))(accessor, spec('/'))) as FileStat[]
    expect(rows.map((row) => [row.name, row.type])).toEqual([['csv', FileType.DIRECTORY]])
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
})

// Mirrors the make_tree tests in test_readdir.py.
describe('object_store makeTree', () => {
  it('answers each entry and implied directory', async () => {
    const store = new FakeStore({ 'a.txt': 'hi', 'dir/sub/f.txt': 'x', '/': '' })
    const found = await makeTree(makeDriver(store))(accessor, spec('/'))
    expect([...(found ?? new Map()).keys()].sort()).toEqual([
      '',
      'a.txt',
      'dir',
      'dir/sub',
      'dir/sub/f.txt',
    ])
    expect(found?.get('dir/sub/f.txt')?.size).toBe(1)
    expect(found?.get('dir')?.type).toBe(FileType.DIRECTORY)
    expect(found?.get('')?.type).toBe(FileType.DIRECTORY)
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

  // Twin of test_tree_answers_none_past_a_walks_limit.
  it('answers null past a walk limit', async () => {
    const store = new FakeStore(
      Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`dir/f${String(i)}.txt`, 'x'])),
    )
    const tree = makeTree(makeDriver(store))
    await expect(tree(accessor, spec('/dir'), 3)).resolves.toBeNull()
    expect((await tree(accessor, spec('/dir'), 5))?.size).toBe(6)
  })
})

// Twin of test_readdir_stops_at_a_walks_limit_and_marks_the_listing_partial.
it('stops a listing at a walk limit and marks it partial', async () => {
  const store = new FakeStore(
    Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`f${String(i)}.txt`, 'x'])),
  )
  const pulled: string[] = []
  const driver = makeDriver(store)
  async function* counted(conn: FakeStore, pfx: string) {
    for await (const child of driver.listChildren(conn, pfx)) {
      pulled.push(child.key)
      yield child
    }
  }
  const readdir = makeReaddir({ ...driver, listChildren: counted })
  const out = await readdir(accessor, spec('/'), 2)
  expect(out instanceof DirListing && out.partial).toBe(true)
  expect((out as DirListing).entries.map((row) => row.name)).toEqual(['f0.txt', 'f1.txt'])
  expect(pulled).toEqual(['f0.txt', 'f1.txt', 'f2.txt'])
  expect((await readdir(accessor, spec('/'), 5)) as FileStat[]).toHaveLength(5)
})

// Twin of test_a_walks_limit_counts_a_name_both_key_and_prefix_once.
it('counts a name that is a key and a prefix once toward a walk limit', async () => {
  const keys = ['a', 'a/x', 'b', 'b/x', 'c', 'd']
  const store = new FakeStore(Object.fromEntries(keys.map((k) => [k, 'x'])))
  const out = (await makeReaddir(makeDriver(store))(accessor, spec('/'), 3)) as DirListing
  expect(out.entries.map((row) => row.name)).toEqual(['a', 'b', 'c'])
})

// Twin of test_a_cut_listing_stops_at_a_kept_directorys_next_row.
it("stops a cut listing at a kept directory's next row", async () => {
  const keys = ['a', 'c', ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `b/${String(i)}`)]
  const store = new FakeStore(Object.fromEntries(keys.map((k) => [k, 'x'])))
  const pulled: string[] = []
  const driver = makeDriver(store)
  async function* counted(conn: FakeStore, pfx: string) {
    for await (const child of driver.listChildren(conn, pfx)) {
      pulled.push(child.key)
      yield child
    }
  }
  const out = (await makeReaddir({ ...driver, listChildren: counted })(
    accessor,
    spec('/'),
    2,
  )) as DirListing
  expect(out.entries.map((row) => row.name)).toEqual(['a', 'b'])
  expect(pulled).toEqual(['a', 'b', 'b'])
})

// Twin of test_a_listing_that_skips_a_name_past_its_limit_is_partial.
it('marks a listing that skips a name past its limit partial', async () => {
  const store = new FakeStore(Object.fromEntries(['a', 'b', 'b.conf'].map((k) => [k, 'x'])))
  const out = await makeReaddir(makeDriver(store))(accessor, spec('/'), 2)
  expect(out instanceof DirListing && out.partial).toBe(true)
  expect((out as DirListing).entries.map((row) => row.name)).toEqual(['a', 'b'])
})

// Twin of test_a_cut_listing_reads_on_until_a_kept_file_proves_a_directory.
it('reads a cut listing on until a kept file proves a directory', async () => {
  const store = new FakeStore(Object.fromEntries(['a', 'b', 'b/x', 'c'].map((k) => [k, 'x'])))
  const out = await makeReaddir(makeDriver(store))(accessor, spec('/'), 2)
  expect(out instanceof DirListing && out.partial).toBe(true)
  expect((out as DirListing).entries.map((row) => [row.name, row.type])).toEqual([
    ['a', FileType.FILE],
    ['b', FileType.DIRECTORY],
  ])
})
