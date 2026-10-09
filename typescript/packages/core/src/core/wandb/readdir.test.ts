import { describe, expect, it, vi } from 'vitest'
import { fileTree, readdir } from './readdir.ts'
import { WandbAccessor } from '../../accessor/wandb.ts'
import { RAMFileCacheStore } from '../../cache/file/ram.ts'
import type { Evicted } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { IndexView } from '../../cache/index/view.ts'
import { normalizeWandbConfig } from './config.ts'
import { stat } from './stat.ts'
import { FileType, PathSpec } from '../../types.ts'
const file = (name: string) => ({ name, url: 'https://example.com', sizeBytes: 1 })
const path = (key: string) => PathSpec.fromStrPath('/wandb/' + key, key)
describe('W&B file tree', () => {
  it.each(['../escape', '/absolute', 'a//b', 'a/./b', 'a\\b'])('refuses unsafe file %s', (name) => {
    expect(() => fileTree([file(name)])).toThrow('unsafe')
  })
  it('refuses file/directory collisions', () => {
    expect(() => fileTree([file('a'), file('a/b')])).toThrow('collision')
  })
  it('reuses nested catalogs and refreshes expired metadata without reviving deleted files', async () => {
    const accessor = new WandbAccessor(normalizeWandbConfig({ entities: ['lab'] }))
    vi.spyOn(accessor.client, 'run').mockResolvedValue({ name: 'run' })
    const files = vi
      .spyOn(accessor.client, 'files')
      .mockResolvedValueOnce([
        { name: 'nested/old.txt', sizeBytes: 3 },
        { name: 'deep/sub/file.txt', sizeBytes: 5 },
      ])
      .mockResolvedValueOnce([{ name: 'nested/new.txt', sizeBytes: 9 }])
    const index = new RAMIndexCacheStore()
    const root = 'lab/project/run/files'
    await readdir(accessor, path('lab/project/run'), index)
    await readdir(accessor, path(root), index)
    expect(await readdir(accessor, path(root + '/deep/sub'), index)).toEqual([
      '/wandb/' + root + '/deep/sub/file.txt',
    ])
    expect((await stat(accessor, path(root), index)).type).toBe(FileType.DIRECTORY)
    expect((await stat(accessor, path(root + '/nested/old.txt'), index)).size).toBe(3)
    expect(files).toHaveBeenCalledTimes(1)
    await index.setDir('/wandb/' + root + '/nested', [], new Date(Date.now() - 1000))
    await expect(stat(accessor, path(root + '/nested/old.txt'), index)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect((await stat(accessor, path(root + '/nested/new.txt'), index)).size).toBe(9)
    expect((await index.get('/wandb/' + root + '/deep/sub/file.txt')).entry).toBeUndefined()
    expect(files).toHaveBeenCalledTimes(2)
  })
  it('does not publish a partial catalog after a collision', async () => {
    const accessor = new WandbAccessor(normalizeWandbConfig({ entities: ['lab'] }))
    vi.spyOn(accessor.client, 'files').mockResolvedValue([
      { name: 'nested/child', sizeBytes: 3 },
      { name: 'nested', sizeBytes: 1 },
    ])
    const index = new RAMIndexCacheStore()
    await expect(readdir(accessor, path('lab/project/run/files'), index)).rejects.toThrow(
      'collision',
    )
    expect((await index.listDir('/wandb/lab/project/run/files')).entries).toBeUndefined()
    expect((await index.get('/wandb/lab/project/run/files/nested')).entry).toBeUndefined()
  })
  it('hands what a file re-list dropped to cleanup', async () => {
    // The catalog is one complete fetch, so a re-list that no longer names
    // a file or a folder is the backend saying it went away.
    const gone: Evicted[] = []
    const accessor = new WandbAccessor(normalizeWandbConfig({ entities: ['lab'] }))
    vi.spyOn(accessor.client, 'run').mockResolvedValue({ name: 'run' })
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
    await readdir(accessor, path(root), index)
    await store.invalidate()
    await readdir(accessor, path(root), index)
    expect(gone.map((child) => child.path).sort()).toEqual([
      '/wandb/' + root + '/deep',
      '/wandb/' + root + '/nested/old.txt',
    ])
  })
})
