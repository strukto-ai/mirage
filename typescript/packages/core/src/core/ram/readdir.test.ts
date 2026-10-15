import { expect, it } from 'vitest'
import { RAMAccessor } from '../../accessor/ram.ts'
import { PathSpec } from '../../types.ts'
import { RAMStore } from '../../vfs/ram/store.ts'
import { readdir, tree } from './readdir.ts'
import { stat } from './stat.ts'

it('answers each child as stat does, a folder a key implies included', async () => {
  const store = new RAMStore()
  store.dirs.add('/sub')
  store.files.set('/sub/child', new TextEncoder().encode('data'))
  store.files.set('/file.txt', new TextEncoder().encode('data'))
  store.files.set('/implied/x.txt', new TextEncoder().encode('x'))
  const accessor = new RAMAccessor(store)
  const rows = await readdir(accessor, PathSpec.fromStrPath('/', ''))
  expect(rows.map((row) => [row.name, row.type, row.size])).toEqual([
    ['file.txt', 'file', 4],
    ['implied', 'directory', null],
    ['sub', 'directory', null],
  ])
  expect(rows[0]).toEqual(await stat(accessor, PathSpec.fromStrPath('/file.txt', 'file.txt')))
})

// Mirrors the tree tests in test_readdir.py.
it('tree declines a file whose folder is missing', async () => {
  const store = new RAMStore()
  store.dirs.add('/sub')
  store.files.set('/sub/a.txt', new TextEncoder().encode('a'))
  const accessor = new RAMAccessor(store)
  expect([
    ...((await tree(accessor, PathSpec.fromStrPath('/sub', 'sub'))) ?? new Map()).keys(),
  ]).toEqual(['a.txt'])
  store.files.set('/missing/b.txt', new TextEncoder().encode('b'))
  expect(await tree(accessor, PathSpec.fromStrPath('/', ''))).toBeNull()
})
