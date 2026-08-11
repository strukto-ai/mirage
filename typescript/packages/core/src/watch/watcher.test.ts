import { describe, expect, it } from 'vitest'
import { FileChangeKind, FileEvent, PathSpec } from '../types.ts'
import type { CacheInvalidator, WatchMount, WatchRegistry } from './base.ts'
import { Watcher } from './watcher.ts'

const TIMESTAMP = new Date(0)

class RecordingCache implements CacheInvalidator {
  readonly log: string[] = []

  invalidateAfterWrite(path: PathSpec): Promise<void> {
    this.log.push(`write:${path.virtual}:${path.resourcePath}`)
    return Promise.resolve()
  }

  invalidateAfterUnlink(path: PathSpec): Promise<void> {
    this.log.push(`unlink:${path.virtual}:${path.resourcePath}`)
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

describe('Watcher', () => {
  it('invalidates the path and ancestors before delivery', async () => {
    const cache = new RecordingCache()
    const watcher = new Watcher(new FakeRegistry({ prefix: '/nc/', cacheManager: cache }))
    const pending = await begin(watcher, '/nc')
    await watcher.notify(change(FileChangeKind.CREATE, '/nc/data/sub/x.txt'))
    const delivered = await pending.next
    if (delivered.done === true) throw new Error('watch ended before delivery')
    expect(delivered.value.path.resourcePath).toBe('data/sub/x.txt')
    expect(cache.log).toEqual([
      'write:/nc/data/sub/x.txt:data/sub/x.txt',
      'write:/nc/data/sub:data/sub',
      'write:/nc/data:data',
    ])
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
    expect(cache.log).toContain('unlink:/nc/old/original.txt:old/original.txt')
    expect(cache.log).toContain('write:/nc/old:old')
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
})
