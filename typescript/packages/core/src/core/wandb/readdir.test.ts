import { describe, expect, it, vi } from 'vitest'
import { fileTree, readdir } from './readdir.ts'
import { WandbAccessor } from '../../accessor/wandb.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import type { Evicted } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { IndexView } from '../../cache/index/view.ts'
import { normalizeWandbConfig } from './config.ts'
import { type FileStat, PathSpec } from '../../types.ts'
import { WandbVFS } from '../../vfs/wandb/wandb.ts'
import { keepListing } from '../../workspace/mount/listing.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
const file = (name: string) => ({ name, url: 'https://example.com', sizeBytes: 1 })
const path = (key: string) => PathSpec.fromStrPath('/wandb/' + key, key)
describe('W&B file tree', () => {
  it.each(['../escape', '/absolute', 'a//b', 'a/./b', 'a\\b'])('refuses unsafe file %s', (name) => {
    expect(() => fileTree([file(name)])).toThrow('unsafe')
  })
  it('refuses file/directory collisions', () => {
    expect(() => fileTree([file('a'), file('a/b')])).toThrow('collision')
  })
  it('answers every directory below files from one catalog', async () => {
    const accessor = new WandbAccessor(normalizeWandbConfig({ entities: ['lab'] }))
    vi.spyOn(accessor.client, 'run').mockResolvedValue({ name: 'run' })
    const files = vi.spyOn(accessor.client, 'files').mockResolvedValue([
      { name: 'nested/old.txt', sizeBytes: 3 },
      { name: 'deep/sub/file.txt', sizeBytes: 5 },
    ])
    const vfs = Object.assign(new WandbVFS(accessor.config), { accessor })
    const ws = new Workspace({ '/wandb/': vfs })
    const root = '/wandb/lab/project/run/files'
    await ws.dispatch('readdir', root)
    expect(await ws.dispatch('readdir', root + '/deep/sub')).toEqual([root + '/deep/sub/file.txt'])
    expect(((await ws.dispatch('stat', root + '/nested/old.txt')) as FileStat).size).toBe(3)
    expect(files).toHaveBeenCalledTimes(1)
  })
  it('does not publish a partial catalog after a collision', async () => {
    const accessor = new WandbAccessor(normalizeWandbConfig({ entities: ['lab'] }))
    vi.spyOn(accessor.client, 'files').mockResolvedValue([
      { name: 'nested/child', sizeBytes: 3 },
      { name: 'nested', sizeBytes: 1 },
    ])
    await expect(readdir(accessor, path('lab/project/run/files'))).rejects.toThrow('collision')
  })
  it('hands what a file re-list dropped to cleanup', async () => {
    // The catalog is one complete fetch, so a re-list that no longer names
    // a file or a folder is the backend saying it went away.
    const gone: Evicted[] = []
    const accessor = new WandbAccessor(normalizeWandbConfig({ entities: ['lab'] }))
    vi.spyOn(accessor.client, 'files')
      .mockResolvedValueOnce([
        { name: 'nested/old.txt', sizeBytes: 3 },
        { name: 'deep/sub/file.txt', sizeBytes: 5 },
      ])
      .mockResolvedValueOnce([{ name: 'nested/new.txt', sizeBytes: 9 }])
    const store = new RAMIndexCacheStore()
    const index = new IndexView(store, new RAMFileCacheStore(), '/wandb', () => true, {
      onGone: (children) => {
        gone.push(...children)
        return Promise.resolve()
      },
    })
    const root = 'lab/project/run/files'
    const key = '/wandb/' + root
    await keepListing(index, key, await readdir(accessor, path(root)))
    await store.invalidate()
    await keepListing(index, key, await readdir(accessor, path(root)))
    expect(gone.map((child) => child.path).sort()).toEqual([
      '/wandb/' + root + '/deep',
      '/wandb/' + root + '/nested/old.txt',
    ])
  })
})
