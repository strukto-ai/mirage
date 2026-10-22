import { describe, expect, it, vi } from 'vitest'
import { Accessor } from '../accessor/base.ts'
import { ResponseCache } from '../accessor/responses.ts'
import { RAMFileCacheStore } from '../cache/file/ram.ts'
import { LookupStatus } from '../cache/index/config.ts'
import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import { CacheManager } from '../cache/manager.ts'
import { FileChangeKind, FileEvent, PathSpec, FileStat, FileType } from '../types.ts'
import type { EventMount, EventRegistry } from './base.ts'
import { RAMEventQueue } from './queue/ram.ts'
import { EventHub } from './hub.ts'

const TIMESTAMP = new Date(0)

class RecordingCache implements Pick<CacheManager, 'invalidate'> {
  readonly log: string[] = []

  invalidate(path: string | PathSpec, kind: FileChangeKind): Promise<void> {
    if (!(path instanceof PathSpec)) throw new Error('the hub hands a framed path')
    this.log.push(`${kind}:${path.virtual}:${path.vfsPath}`)
    return Promise.resolve()
  }
}

class FakeRegistry implements EventRegistry {
  readonly mount: EventMount

  constructor(mount: Omit<EventMount, 'accessor'> & { accessor?: Accessor }) {
    this.mount = { accessor: new Accessor(), ...mount }
  }

  mountFor(): EventMount {
    return this.mount
  }
}

function change(kind: FileChangeKind, virtual: string): FileEvent {
  return new FileEvent({ kind, path: PathSpec.fromStrPath(virtual), timestamp: TIMESTAMP })
}

async function begin(hub: EventHub, root: string) {
  const iterator = hub.events(PathSpec.fromStrPath(root))[Symbol.asyncIterator]()
  const next = iterator.next()
  await Promise.resolve()
  return { iterator, next }
}

async function eventFrom(pending: Promise<IteratorResult<FileEvent>>): Promise<FileEvent> {
  const result = await pending
  if (result.done === true) throw new Error('events ended before an event arrived')
  return result.value
}

function realHub(): {
  hub: EventHub
  cache: RAMFileCacheStore
  index: RAMIndexCacheStore
} {
  const cache = new RAMFileCacheStore()
  const index = new RAMIndexCacheStore({ ttl: 600 })
  const manager = new CacheManager(cache, index, '/x/', true)
  const hub = new EventHub(new FakeRegistry({ prefix: '/x/', cacheManager: manager }))
  return { hub, cache, index }
}

function row(name: string, kind = 'file'): FileStat {
  const type = kind === 'folder' ? FileType.DIRECTORY : FileType.FILE
  return new FileStat({ name, type, fingerprint: name })
}

function moved(from: string, to: string): FileEvent {
  return new FileEvent({
    kind: FileChangeKind.MOVE,
    path: PathSpec.fromStrPath(to),
    previousPath: PathSpec.fromStrPath(from),
    timestamp: TIMESTAMP,
  })
}

describe('EventHub', () => {
  it('invalidates the path before delivery', async () => {
    const cache = new RecordingCache()
    const hub = new EventHub(new FakeRegistry({ prefix: '/nc/', cacheManager: cache }))
    const pending = await begin(hub, '/nc')
    await hub.notify(change(FileChangeKind.CREATE, '/nc/data/sub/x.txt'))
    const delivered = await pending.next
    if (delivered.done === true) throw new Error('events ended before delivery')
    expect(delivered.value.path.vfsPath).toBe('data/sub/x.txt')
    expect(cache.log).toEqual(['create:/nc/data/sub/x.txt:data/sub/x.txt'])
    await hub.close()
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
        ['child', new FileStat({ name: 'child', type: FileType.FILE, fingerprint: '1' })],
      ])
    }
    const manager = new CacheManager(null, index, '/nc/', false)
    const hub = new EventHub(new FakeRegistry({ prefix: '/nc/', cacheManager: manager }))
    await hub.notify(change(FileChangeKind.CREATE, '/nc/data/sub/deep.txt'))
    for (const level of levels) {
      const listing = await index.listDir(level)
      expect(listing.entries ?? null).toBeNull()
    }
    await hub.close()
  })

  it.each([FileChangeKind.DELETE, FileChangeKind.UNKNOWN, FileChangeKind.UPDATE])(
    'hands a %s to the manager',
    async (kind) => {
      const cache = new RecordingCache()
      const hub = new EventHub(new FakeRegistry({ prefix: '/nc/', cacheManager: cache }))
      const pending = await begin(hub, '/nc')
      await hub.notify(change(kind, '/nc/data/day'))
      await pending.next
      expect(cache.log).toEqual([`${kind}:/nc/data/day:data/day`])
      await hub.close()
    },
  )

  it('cleans ancestors without delivery after a removal probe fails', async () => {
    const cache = new RAMFileCacheStore()
    const index = new RAMIndexCacheStore({ ttl: 600 })
    const levels = ['/old', '/old/a', '/old/a/b', '/old/a/b/f']
    for (const directory of levels) await index.setDir(directory, [])
    await cache.set('/old/a/b/f', new TextEncoder().encode('old'))
    const old = { prefix: '/old/', cacheManager: new CacheManager(cache, index, '/old/', true) }
    const hub = new EventHub(new FakeRegistry(old))
    const event = change(FileChangeKind.DELETE, '/old/a/b/f')
    const pending = await begin(hub, '/old')
    const error = new Error('registry recovery failed')
    const failed = vi.spyOn(index, 'holdsSubtree').mockRejectedValue(error)
    const pushed = vi.spyOn(RAMEventQueue.prototype, 'push')
    try {
      await expect(hub.notify(event)).rejects.toBe(error)
      expect(pushed).not.toHaveBeenCalled()
      expect(await cache.exists('/old/a/b/f')).toBe(false)
      for (const directory of levels) {
        expect((await index.listDir(directory)).entries).toBeUndefined()
      }
    } finally {
      failed.mockRestore()
      pushed.mockRestore()
      await hub.close()
    }
    expect((await pending.next).done).toBe(true)
  })

  it('delivers nothing when invalidation fails', async () => {
    const manager = new RecordingCache()
    const hub = new EventHub(new FakeRegistry({ prefix: '/nc/', cacheManager: manager }))
    const pending = await begin(hub, '/nc')
    const error = new Error('invalidation failed')
    vi.spyOn(manager, 'invalidate').mockRejectedValue(error)
    const pushed = vi.spyOn(RAMEventQueue.prototype, 'push')
    try {
      await expect(hub.notify(change(FileChangeKind.DELETE, '/nc/data/f'))).rejects.toBe(error)
      expect(pushed).not.toHaveBeenCalled()
    } finally {
      pushed.mockRestore()
      await hub.close()
    }
    expect((await pending.next).done).toBe(true)
  })

  it('invalidates both sides of a move', async () => {
    const cache = new RecordingCache()
    const hub = new EventHub(new FakeRegistry({ prefix: '/nc/', cacheManager: cache }))
    const pending = await begin(hub, '/nc')
    await hub.notify(
      new FileEvent({
        kind: FileChangeKind.MOVE,
        path: PathSpec.fromStrPath('/nc/data/new.txt'),
        previousPath: PathSpec.fromStrPath('/nc/old/original.txt'),
        timestamp: TIMESTAMP,
      }),
    )
    await pending.next
    expect(cache.log).toEqual([
      'move:/nc/data/new.txt:data/new.txt',
      'delete:/nc/old/original.txt:old/original.txt',
    ])
    await hub.close()
  })

  it("drops the answers the mount's client keeps of its own", async () => {
    // An event is often the only word that the service changed, and no path
    // names a client's own answers (a repository's tree, a database's
    // names), so they answered the old service until the mount dropped its
    // caches for some other reason.
    const answers = new ResponseCache<string, string>()
    class Keeping extends Accessor {
      override caches(): readonly ResponseCache<unknown, unknown>[] {
        return [answers as ResponseCache<unknown, unknown>]
      }
    }
    const hub = new EventHub(
      new FakeRegistry({ prefix: '/nc/', cacheManager: null, accessor: new Keeping() }),
    )
    await answers.get('names', () => Promise.resolve('before'))
    await hub.notify(change(FileChangeKind.CREATE, '/nc/data/new.txt'))
    expect(await answers.get('names', () => Promise.resolve('after'))).toBe('after')
    await hub.close()
  })

  it('fans out to overlapping subscriptions and skips other scopes', async () => {
    const hub = new EventHub(new FakeRegistry({ prefix: '/nc/', cacheManager: null }))
    const whole = await begin(hub, '/nc/data')
    const text = await begin(hub, '/nc/data/*.txt')
    await hub.notify(change(FileChangeKind.CREATE, '/nc/data/hit.txt'))
    expect((await eventFrom(whole.next)).path.virtual).toBe('/nc/data/hit.txt')
    expect((await eventFrom(text.next)).path.virtual).toBe('/nc/data/hit.txt')
    await hub.close()
  })

  it('treats slashless globs as shallow and trailing globs as subtrees', async () => {
    const hub = new EventHub(new FakeRegistry({ prefix: '/nc/', cacheManager: null }))
    const shallow = await begin(hub, '/nc/data/*')
    const deep = await begin(hub, '/nc/data/*/')
    await hub.notify(change(FileChangeKind.CREATE, '/nc/data/top.txt'))
    const shallowResult = await shallow.next
    if (shallowResult.done === true) throw new Error('shallow subscription ended before delivery')
    expect(shallowResult.value.path.virtual).toBe('/nc/data/top.txt')
    const deepNext = deep.next
    await hub.notify(change(FileChangeKind.CREATE, '/nc/data/sub/deep.txt'))
    const deepResult = await deepNext
    if (deepResult.done === true) throw new Error('deep subscription ended before delivery')
    expect(deepResult.value.path.virtual).toBe('/nc/data/sub/deep.txt')
    await hub.close()
  })

  it('ends blocked iterators when closed', async () => {
    const hub = new EventHub(new FakeRegistry({ prefix: '/nc/', cacheManager: null }))
    const pending = await begin(hub, '/nc')
    await hub.close()
    expect(await pending.next).toEqual({ done: true, value: undefined })
  })

  describe('over a real cache manager', () => {
    it.each([FileChangeKind.DELETE, FileChangeKind.MOVE])(
      'drops the cached subtree of a removed folder (%s)',
      async (kind) => {
        const { hub, cache, index } = realHub()
        try {
          await index.setDir('/x/dir/sub', [['f', row('f')]])
          await cache.set('/x/dir/sub/f', new TextEncoder().encode('old\n'))
          await hub.notify(
            kind === FileChangeKind.MOVE ? moved('/x/dir', '/x/moved') : change(kind, '/x/dir'),
          )
          expect((await index.listDir('/x/dir/sub')).status).toBe(LookupStatus.NOT_FOUND)
          expect(await cache.exists('/x/dir/sub/f')).toBe(false)
        } finally {
          await hub.close()
        }
      },
    )

    it("still finds the folder's listing after a same-parent rename", async () => {
      // The target is evicted first, which buries /x and pops the folder's
      // row; the folder's own listing must still be found after that.
      const { hub, cache, index } = realHub()
      await index.setDir('/x', [
        ['dir', row('dir', 'folder')],
        ['s', row('s')],
      ])
      await index.setDir('/x/dir', [['f', row('f')]])
      await cache.set('/x/dir/f', new TextEncoder().encode('old\n'))
      await hub.notify(moved('/x/dir', '/x/renamed'))
      expect(await cache.exists('/x/dir/f')).toBe(false)
      await hub.close()
    })

    it.each([
      { order: 'children-first', paths: ['/x/t/s1/f', '/x/t/s1', '/x/t'], expected: 2 },
      { order: 'folder-first', paths: ['/x/t', '/x/t/s1', '/x/t/s1/f'], expected: 1 },
    ])('drops only retained subtrees in a $order stream', async ({ paths, expected }) => {
      const { hub, cache, index } = realHub()
      try {
        await index.setDir('/x/t', [['s1', row('s1', 'folder')]])
        await index.setDir('/x/t/s1', [['f', row('f')]])
        await cache.set('/x/t/s1/f', new TextEncoder().encode('f'))
        const evict = vi.spyOn(cache, 'remove')
        const drop = vi.spyOn(index, 'invalidatePrefix')
        for (const path of paths) await hub.notify(change(FileChangeKind.DELETE, path))
        expect(evict.mock.calls.filter(([, options]) => options?.subtree === true)).toHaveLength(
          expected,
        )
        expect(drop).toHaveBeenCalledTimes(expected)
        expect((await index.listDir('/x/t')).status).toBe(LookupStatus.NOT_FOUND)
        expect((await index.listDir('/x/t/s1')).status).toBe(LookupStatus.NOT_FOUND)
        expect(await index.holdsSubtree('/x/t')).toBe(false)
        expect(await cache.exists('/x/t/s1/f')).toBe(false)
      } finally {
        await hub.close()
      }
    })
  })
})
