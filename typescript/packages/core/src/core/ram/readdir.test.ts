import { expect, it } from 'vitest'
import { RAMAccessor } from '../../accessor/ram.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { RAMStore } from '../../vfs/ram/store.ts'
import { readdir, tree } from './readdir.ts'

it('preserves a cached subdirectory when listing its parent', async () => {
  const store = new RAMStore()
  store.dirs.add('/sub')
  store.files.set('/sub/child', new TextEncoder().encode('data'))
  store.files.set('/file.txt', new TextEncoder().encode('data'))
  const accessor = new RAMAccessor(store)
  const index = new RAMIndexCacheStore({ ttl: 600 })
  const children = await readdir(accessor, PathSpec.fromStrPath('/sub', 'sub'), index)
  await readdir(accessor, PathSpec.fromStrPath('/', ''), index)
  expect((await index.listDir('/sub')).entries).toEqual(children)
  expect((await index.get('/sub')).entry?.resourceType).toBe('folder')
  expect((await index.get('/file.txt')).entry?.resourceType).toBe('file')
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
