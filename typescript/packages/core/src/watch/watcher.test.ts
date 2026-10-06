import { describe, expect, it, vi } from 'vitest'
import { RAMFileCacheStore } from '../cache/file/ram.ts'
import { IndexEntry, LookupStatus } from '../cache/index/config.ts'
import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import { CacheManager } from '../cache/manager.ts'
import { FileChangeKind, FileEvent, PathSpec } from '../types.ts'
import type { CacheInvalidator, WatchMount, WatchRegistry } from './base.ts'
import { RAMWatchQueue } from './queue/ram.ts'
import { Watcher } from './watcher.ts'

const TIMESTAMP = new Date(0)

class RecordingCache implements CacheInvalidator {
  readonly log: string[] = []

  invalidateAfterWrite(path: PathSpec): Promise<void> {
    this.log.push(`write:${path.virtual}:${path.vfsPath}`)
    return Promise.resolve()
  }

  invalidateAfterRemove(path: PathSpec): Promise<void> {
    this.log.push(`remove:${path.virtual}:${path.vfsPath}`)
    return Promise.resolve()
  }

  invalidateSubtree(path: PathSpec): Promise<void> {
    this.log.push(`subtree:${path.virtual}:${path.vfsPath}`)
    return Promise.resolve()
  }

  invalidateAncestors(path: PathSpec): Promise<void> {
    this.log.push(`ancestors:${path.virtual}:${path.vfsPath}`)
    return Promise.resolve()
  }
}

class FakeRegistry implements WatchRegistry {
  constructor(readonly mount: WatchMount) {}

  mountFor(): WatchMount {
    return this.mount
  }
}

function change(kind: FileChangeKind, virtual: string): FileEvent {
  return new FileEvent({ kind, path: PathSpec.fromStrPath(virtual), timestamp: TIMESTAMP })
}

async function begin(watcher: Watcher, root: string) {
  const iterator = watcher.watch(PathSpec.fromStrPath(root))[Symbol.asyncIterator]()
  const next = iterator.next()
  await Promise.resolve()
  return { iterator, next }
}

async function eventFrom(pending: Promise<IteratorResult<FileEvent>>): Promise<FileEvent> {
  const result = await pending
  if (result.done === true) throw new Error('watch ended before an event arrived')
  return result.value
}

function realWatcher(): {
  watcher: Watcher
  cache: RAMFileCacheStore
  index: RAMIndexCacheStore
} {
  const cache = new RAMFileCacheStore()
  const index = new RAMIndexCacheStore({ ttl: 600 })
  const manager = new CacheManager(cache, index, '/x/', true)
  const watcher = new Watcher(new FakeRegistry({ prefix: '/x/', cacheManager: manager }))
  return { watcher, cache, index }
}

function row(name: string, resourceType = 'file'): IndexEntry {
  return new IndexEntry({ id: name, name, resourceType })
}

function moved(from: string, to: string): FileEvent {
  return new FileEvent({
    kind: FileChangeKind.MOVE,
    path: PathSpec.fromStrPath(to),
    previousPath: PathSpec.fromStrPath(from),
    timestamp: TIMESTAMP,
  })
}

describe('Watcher', () => {
  it('invalidates the path and ancestors before delivery', async () => {
    const cache = new RecordingCache()
    const watcher = new Watcher(new FakeRegistry({ prefix: '/nc/', cacheManager: cache }))
    const pending = await begin(watcher, '/nc')
    await watcher.notify(change(FileChangeKind.CREATE, '/nc/data/sub/x.txt'))
    const delivered = await pending.next
    if (delivered.done === true) throw new Error('watch ended before delivery')
    expect(delivered.value.path.vfsPath).toBe('data/sub/x.txt')
    expect(cache.log).toEqual([
      'write:/nc/data/sub/x.txt:data/sub/x.txt',
      'ancestors:/nc/data/sub/x.txt:data/sub/x.txt',
    ])
    await watcher.close()
  })

  it('drops every listing up to the mount root for a nested create', async () => {
    // A nested external create implies intermediate dirs appeared, so every
    // cached listing up to the mount root must go, not just the file's
    // immediate parent. Asserted against a real CacheManager rather than the
    // recorder above, because the walk itself lives there now and a fake would
    // only prove the call was made.
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const levels = ['/nc', '/nc/data', '/nc/data/sub']
    for (const level of levels) {
      await index.setDir(level, [
        ['child', new IndexEntry({ id: '1', name: 'child', resourceType: 'file' })],
      ])
    }
    const manager = new CacheManager(null, index, '/nc/', false)
    const watcher = new Watcher(new FakeRegistry({ prefix: '/nc/', cacheManager: manager }))
    await watcher.notify(change(FileChangeKind.CREATE, '/nc/data/sub/deep.txt'))
    for (const level of levels) {
      const listing = await index.listDir(level)
      expect(listing.entries ?? null).toBeNull()
    }
    await watcher.close()
  })

  it('routes a DELETE through removal', async () => {
    const cache = new RecordingCache()
    const watcher = new Watcher(new FakeRegistry({ prefix: '/nc/', cacheManager: cache }))
    const pending = await begin(watcher, '/nc')
    await watcher.notify(change(FileChangeKind.DELETE, '/nc/data/x.txt'))
    await pending.next
    expect(cache.log).toEqual([
      'remove:/nc/data/x.txt:data/x.txt',
      'ancestors:/nc/data/x.txt:data/x.txt',
    ])
    await watcher.close()
  })

  it('cleans ancestors without delivery after a removal probe fails', async () => {
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const levels = ['/old', '/old/a', '/old/a/b', '/old/a/b/f']
    for (const directory of levels) await index.setDir(directory, [])
    await cache.set('/old/a/b/f', new TextEncoder().encode('old'))
    const old = { prefix: '/old/', cacheManager: new CacheManager(cache, index, '/old/', true) }
    const watcher = new Watcher(new FakeRegistry(old))
    const event = change(FileChangeKind.DELETE, '/old/a/b/f')
    const pending = await begin(watcher, '/old')
    const error = new Error('registry recovery failed')
    const failed = vi.spyOn(index, 'holdsSubtree').mockRejectedValue(error)
    const pushed = vi.spyOn(RAMWatchQueue.prototype, 'push')
    try {
      await expect(watcher.notify(event)).rejects.toBe(error)
      expect(pushed).not.toHaveBeenCalled()
      expect(await cache.exists('/old/a/b/f')).toBe(false)
      for (const directory of levels) {
        expect((await index.listDir(directory)).entries).toBeUndefined()
      }
    } finally {
      failed.mockRestore()
      pushed.mockRestore()
      await watcher.close()
    }
    expect((await pending.next).done).toBe(true)
  })

  it.each([false, true])(
    'preserves ancestor cleanup failures without delivery when removal fails: %s',
    async (removalFails) => {
      const manager = new RecordingCache()
      const watcher = new Watcher(new FakeRegistry({ prefix: '/nc/', cacheManager: manager }))
      const pending = await begin(watcher, '/nc')
      const removal = vi.spyOn(manager, 'invalidateAfterRemove')
      if (removalFails) removal.mockRejectedValue(0)
      const cleanupError = new Error('ancestor cleanup failed')
      const cleanup = vi.spyOn(manager, 'invalidateAncestors').mockRejectedValue(cleanupError)
      const pushed = vi.spyOn(RAMWatchQueue.prototype, 'push')
      try {
        const result = watcher.notify(change(FileChangeKind.DELETE, '/nc/data/f'))
        if (removalFails) {
          await expect(result).rejects.toBeInstanceOf(AggregateError)
          await expect(result).rejects.toHaveProperty('errors', [0, cleanupError])
        } else {
          await expect(result).rejects.toBe(cleanupError)
        }
        expect(cleanup).toHaveBeenCalledTimes(1)
        expect(pushed).not.toHaveBeenCalled()
      } finally {
        pushed.mockRestore()
        await watcher.close()
      }
      expect((await pending.next).done).toBe(true)
    },
  )

  it('takes the subtree for an UNKNOWN change', async () => {
    const cache = new RecordingCache()
    const watcher = new Watcher(new FakeRegistry({ prefix: '/nc/', cacheManager: cache }))
    const pending = await begin(watcher, '/nc')
    await watcher.notify(change(FileChangeKind.UNKNOWN, '/nc/data/day'))
    await pending.next
    expect(cache.log).toEqual(['subtree:/nc/data/day:data/day', 'ancestors:/nc/data/day:data/day'])
    await watcher.close()
  })

  it('does not reach into the subtree for an UPDATE', async () => {
    const cache = new RecordingCache()
    const watcher = new Watcher(new FakeRegistry({ prefix: '/nc/', cacheManager: cache }))
    const pending = await begin(watcher, '/nc')
    await watcher.notify(change(FileChangeKind.UPDATE, '/nc/data/day'))
    await pending.next
    expect(cache.log).toEqual(['write:/nc/data/day:data/day', 'ancestors:/nc/data/day:data/day'])
    await watcher.close()
  })

  it('invalidates both sides of a move', async () => {
    const cache = new RecordingCache()
    const watcher = new Watcher(new FakeRegistry({ prefix: '/nc/', cacheManager: cache }))
    const pending = await begin(watcher, '/nc')
    await watcher.notify(
      new FileEvent({
        kind: FileChangeKind.MOVE,
        path: PathSpec.fromStrPath('/nc/data/new.txt'),
        previousPath: PathSpec.fromStrPath('/nc/old/original.txt'),
        timestamp: TIMESTAMP,
      }),
    )
    await pending.next
    expect(cache.log).toContain('remove:/nc/old/original.txt:old/original.txt')
    expect(cache.log).toContain('ancestors:/nc/old/original.txt:old/original.txt')
    await watcher.close()
  })

  it('fans out to overlapping watches and skips other scopes', async () => {
    const watcher = new Watcher(new FakeRegistry({ prefix: '/nc/', cacheManager: null }))
    const whole = await begin(watcher, '/nc/data')
    const text = await begin(watcher, '/nc/data/*.txt')
    await watcher.notify(change(FileChangeKind.CREATE, '/nc/data/hit.txt'))
    expect((await eventFrom(whole.next)).path.virtual).toBe('/nc/data/hit.txt')
    expect((await eventFrom(text.next)).path.virtual).toBe('/nc/data/hit.txt')
    await watcher.close()
  })

  it('treats slashless globs as shallow and trailing globs as subtrees', async () => {
    const watcher = new Watcher(new FakeRegistry({ prefix: '/nc/', cacheManager: null }))
    const shallow = await begin(watcher, '/nc/data/*')
    const deep = await begin(watcher, '/nc/data/*/')
    await watcher.notify(change(FileChangeKind.CREATE, '/nc/data/top.txt'))
    const shallowResult = await shallow.next
    if (shallowResult.done === true) throw new Error('shallow watch ended before delivery')
    expect(shallowResult.value.path.virtual).toBe('/nc/data/top.txt')
    const deepNext = deep.next
    await watcher.notify(change(FileChangeKind.CREATE, '/nc/data/sub/deep.txt'))
    const deepResult = await deepNext
    if (deepResult.done === true) throw new Error('deep watch ended before delivery')
    expect(deepResult.value.path.virtual).toBe('/nc/data/sub/deep.txt')
    await watcher.close()
  })

  it('ends blocked iterators when closed', async () => {
    const watcher = new Watcher(new FakeRegistry({ prefix: '/nc/', cacheManager: null }))
    const pending = await begin(watcher, '/nc')
    await watcher.close()
    expect(await pending.next).toEqual({ done: true, value: undefined })
  })

  describe('over a real cache manager', () => {
    it.each([FileChangeKind.DELETE, FileChangeKind.MOVE])(
      'drops the cached subtree of a removed folder (%s)',
      async (kind) => {
        const { watcher, cache, index } = realWatcher()
        try {
          await index.setDir('/x/dir/sub', [['f', row('f')]])
          await cache.set('/x/dir/sub/f', new TextEncoder().encode('old\n'))
          await watcher.notify(
            kind === FileChangeKind.MOVE ? moved('/x/dir', '/x/moved') : change(kind, '/x/dir'),
          )
          expect((await index.listDir('/x/dir/sub')).status).toBe(LookupStatus.NOT_FOUND)
          expect(await cache.exists('/x/dir/sub/f')).toBe(false)
        } finally {
          await watcher.close()
        }
      },
    )

    it("still finds the folder's listing after a same-parent rename", async () => {
      // The target is evicted first, which buries /x and pops the folder's
      // row; the folder's own listing must still be found after that.
      const { watcher, cache, index } = realWatcher()
      await index.setDir('/x', [
        ['dir', row('dir', 'folder')],
        ['s', row('s')],
      ])
      await index.setDir('/x/dir', [['f', row('f')]])
      await cache.set('/x/dir/f', new TextEncoder().encode('old\n'))
      await watcher.notify(moved('/x/dir', '/x/renamed'))
      expect(await cache.exists('/x/dir/f')).toBe(false)
      await watcher.close()
    })

    it.each([
      { order: 'children-first', paths: ['/x/t/s1/f', '/x/t/s1', '/x/t'], expected: 0 },
      { order: 'folder-first', paths: ['/x/t', '/x/t/s1', '/x/t/s1/f'], expected: 1 },
    ])('drops only retained subtrees in a $order stream', async ({ paths, expected }) => {
      const { watcher, cache, index } = realWatcher()
      try {
        await index.setDir('/x/t', [['s1', row('s1', 'folder')]])
        await index.setDir('/x/t/s1', [['f', row('f')]])
        await cache.set('/x/t/s1/f', new TextEncoder().encode('f'))
        const evict = vi.spyOn(cache, 'evictPrefix')
        const drop = vi.spyOn(index, 'invalidatePrefix')
        for (const path of paths) await watcher.notify(change(FileChangeKind.DELETE, path))
        expect(evict).toHaveBeenCalledTimes(expected)
        expect(drop).toHaveBeenCalledTimes(expected)
      } finally {
        await watcher.close()
      }
    })
  })
})
