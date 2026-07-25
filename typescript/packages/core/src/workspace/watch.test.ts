import { describe, expect, it } from 'vitest'
import { RAMResource } from '../resource/ram/ram.ts'
import { FileChangeKind, FileEvent, MountMode, PathSpec } from '../types.ts'
import { RAMWatchQueue } from '../watch/queue/ram.ts'
import { Watcher } from '../watch/watcher.ts'
import { Workspace } from './workspace.ts'

const TIMESTAMP = new Date(0)

function change(virtual: string): FileEvent {
  return new FileEvent({
    kind: FileChangeKind.CREATE,
    path: PathSpec.fromStrPath(virtual),
    timestamp: TIMESTAMP,
  })
}

describe('Workspace watch integration', () => {
  it('lazily attaches, delivers, and detaches the default runtime', async () => {
    const workspace = new Workspace({ '/data': [new RAMResource(), MountMode.WRITE] })
    const iterator = workspace.watch('/data')[Symbol.asyncIterator]()
    const next = iterator.next()
    await Promise.resolve()
    await workspace.notify(change('/data/new.txt'))
    const result = await next
    if (result.done === true) throw new Error('watch ended before delivery')
    expect(result.value.path.virtual).toBe('/data/new.txt')
    await workspace.detachWatchRuntime()
    await workspace.close()
  })

  it('accepts string lists and globs', async () => {
    const workspace = new Workspace({ '/data': new RAMResource() })
    const iterator = workspace.watch(['/data/a', '/data/*.txt'])[Symbol.asyncIterator]()
    const next = iterator.next()
    await Promise.resolve()
    await workspace.notify(change('/data/hit.txt'))
    const result = await next
    if (result.done === true) throw new Error('watch ended before delivery')
    expect(result.value.path.virtual).toBe('/data/hit.txt')
    await workspace.close()
  })

  it('supports a custom queue factory', async () => {
    const workspace = new Workspace({ '/data': new RAMResource() })
    workspace.attachWatchRuntime(
      new Watcher(workspace.registry, (roots) => new RAMWatchQueue(roots, { maxPending: 8 })),
    )
    const iterator = workspace.watch('/data')[Symbol.asyncIterator]()
    const next = iterator.next()
    await Promise.resolve()
    await workspace.notify(change('/data/new.txt'))
    const result = await next
    if (result.done === true) throw new Error('watch ended before delivery')
    expect(result.value.kind).toBe(FileChangeKind.CREATE)
    await workspace.close()
  })

  it('rejects watch operations after close', async () => {
    const workspace = new Workspace({ '/data': new RAMResource() })
    await workspace.close()
    expect(() => workspace.watch('/data')).toThrow('Workspace is closed')
    await expect(workspace.notify(change('/data/a.txt'))).rejects.toThrow('Workspace is closed')
    expect(() => {
      workspace.attachWatchRuntime(new Watcher(workspace.registry))
    }).toThrow('Workspace is closed')
  })

  it('rejects replacing an attached runtime', async () => {
    const workspace = new Workspace({ '/data': new RAMResource() })
    await workspace.notify(change('/data/a.txt'))
    expect(() => {
      workspace.attachWatchRuntime(new Watcher(workspace.registry))
    }).toThrow('watch runtime already attached')
    await workspace.close()
  })
})
