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
import { PathSpec } from '../../types.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { makeFind } from './find.ts'
import { makeReaddir } from './readdir.ts'
import { makeDuEntries, makeDuSize } from './du.ts'
import { FakeAccessor, FakeStore, makeDriver, spec } from './fakes.ts'

const accessor = new FakeAccessor()

const STORE = {
  'data/a.txt': '12345',
  'data/sub/b.txt': '123',
  'data-old/c.txt': '1',
}

describe('object_store du', () => {
  it('entries reports sizes and total', async () => {
    const entries = makeDuEntries(makeDriver(new FakeStore(STORE)))
    const [found, total] = await entries(accessor, spec('/data'))
    expect(found).toEqual([
      ['/data/a.txt', 5],
      ['/data/sub/b.txt', 3],
    ])
    expect(total).toBe(8)
  })

  it('size matches the entries total', async () => {
    const driver = makeDriver(new FakeStore(STORE))
    const [, total] = await makeDuEntries(driver)(accessor, spec('/data'))
    await expect(makeDuSize(driver)(accessor, spec('/data'))).resolves.toBe(total)
  })

  it('a single file counts just itself', async () => {
    const size = makeDuSize(makeDriver(new FakeStore(STORE)))
    await expect(size(accessor, spec('/data/a.txt'))).resolves.toBe(5)
  })
})

it('shares complete listings between du, find and readdir, but refreshes expired trees', async () => {
  const store = new FakeStore(STORE)
  const driver = makeDriver(store)
  const index = new RAMIndexCacheStore()
  const entries = makeDuEntries(driver)
  const cold = await entries(accessor, spec('/data'), index)
  store.connects = 0
  expect(await entries(accessor, spec('/data'), index)).toEqual(cold)
  expect(await makeFind(driver)(accessor, spec('/data'), { type: 'f' }, index)).toEqual([
    '/data/a.txt',
    '/data/sub/b.txt',
  ])
  expect(await makeReaddir(driver)(accessor, spec('/data/sub'), index)).toEqual([
    '/mnt/data/sub/b.txt',
  ])
  expect(store.connects).toBe(0)
  await index.invalidate()
  await entries(accessor, spec('/data'), index)
  expect(store.connects).toBe(1)
})

it('requires every child listing before reusing a subtree', async () => {
  const store = new FakeStore(STORE)
  const driver = makeDriver(store)
  const index = new RAMIndexCacheStore()
  await makeReaddir(driver)(accessor, spec('/data'), index)
  store.connects = 0
  expect(await makeDuSize(driver)(accessor, spec('/data'), index)).toBe(8)
  expect(store.connects).toBe(1)
  store.connects = 0
  expect(await makeDuSize(driver)(accessor, spec('/data/a.txt'), index)).toBe(5)
  expect(store.connects).toBe(0)
})

it('never publishes a narrowed find result as a complete listing', async () => {
  const driver = makeDriver(new FakeStore(STORE), true)
  const index = new RAMIndexCacheStore()
  expect(
    await makeFind(driver)(accessor, spec('/data'), { name: 'a.txt', type: 'f' }, index),
  ).toEqual(['/data/a.txt'])
  expect((await index.listDir('/mnt/data')).entries).toBeUndefined()
  expect(await makeDuSize(driver)(accessor, spec('/data'), index)).toBe(8)
})

it.each([
  { 'data/': '' },
  { data: 'root', 'data/sub.txt': 'child' },
  { 'data/a': 'file', 'data/a/b': 'deep' },
])('preserves marker and file/prefix collision behavior: %o', async (objects) => {
  const driver = makeDriver(new FakeStore(objects))
  const index = new RAMIndexCacheStore()
  const entries = makeDuEntries(driver)
  const expected = await entries(accessor, spec('/data'))
  await makeReaddir(driver)(accessor, spec('/'), index)
  await makeReaddir(driver)(accessor, spec('/data'), index)
  expect(await entries(accessor, spec('/data'), index)).toEqual(expected)
  expect(await entries(accessor, spec('/data'), index)).toEqual(expected)
})

it('does not let a cached find hide a coexisting file root', async () => {
  const driver = makeDriver(new FakeStore({ data: 'root', 'data/sub.txt': 'child' }))
  const index = new RAMIndexCacheStore()
  await makeFind(driver)(accessor, spec('/data'), {}, index)
  expect(await makeDuSize(driver)(accessor, spec('/data'), index)).toBe(9)
})

it('keeps backend prefixes out of warm results', async () => {
  const prefixed = new FakeAccessor('team/')
  const driver = makeDriver(new FakeStore({ 'team/data/a.txt': '123' }))
  const index = new RAMIndexCacheStore()
  await makeDuSize(driver)(prefixed, spec('/data'), index)
  expect(await makeFind(driver)(prefixed, spec('/data'), { type: 'f' }, index)).toEqual([
    '/data/a.txt',
  ])
  expect((await index.get('/mnt/data/a.txt')).entry?.size).toBe(3)
})

describe.each(['find', 'du'])('%s warms a root containing a marker', (warmup) => {
  describe.each(['/', '/mnt'])('at %s', (virtual) => {
    it.each([{ '/': '' }, { '/': '', 'a.txt': 'abc' }])(
      'never caches itself: %o',
      async (objects) => {
        const store = new FakeStore(objects)
        const driver = makeDriver(store)
        const index = new RAMIndexCacheStore()
        const root = new PathSpec({ virtual, directory: virtual, vfsPath: '' })
        const find = makeFind(driver)
        const size = makeDuSize(driver)
        const expected = await find(accessor, root)
        if (warmup === 'find') await find(accessor, root, {}, index)
        else await size(accessor, root, index)
        const children = (await index.listDir(virtual)).entries
        expect(children).toBeDefined()
        expect(
          children?.every((child) => child.replace(/\/$/, '') !== virtual.replace(/\/$/, '')),
        ).toBe(true)
        store.connects = 0
        expect(await size(accessor, root, index)).toBe(Object.values(objects).join('').length)
        expect(await find(accessor, root, {}, index)).toEqual(expected)
        expect(store.connects).toBe(0)
      },
    )
  })
})

describe.each(['', 'team/'])('find warms du under prefix %s', (prefix) => {
  it.each([STORE, { 'data/': '' }])('does not relist: %o', async (objects) => {
    const accessor = new FakeAccessor(prefix)
    const store = new FakeStore(
      Object.fromEntries(Object.entries(objects).map(([key, value]) => [prefix + key, value])),
    )
    const driver = makeDriver(store)
    const index = new RAMIndexCacheStore()
    const path = spec('/data')
    const entries = makeDuEntries(driver)
    const expected = await entries(accessor, path)
    await makeFind(driver)(accessor, path, {}, index)
    store.connects = 0
    expect(await entries(accessor, path, index)).toEqual(expected)
    expect(await entries(accessor, path, index)).toEqual(expected)
    expect(store.connects).toBe(0)
  })
})
