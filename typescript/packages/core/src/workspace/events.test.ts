import { describe, expect, it } from 'vitest'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { FileChangeKind, FileEvent, MountMode, PathSpec } from '../types.ts'
import { RAMEventQueue } from '../events/queue/ram.ts'
import { EventHub } from '../events/hub.ts'
import { Workspace } from './workspace/workspace.ts'

const TIMESTAMP = new Date(0)

function change(virtual: string): FileEvent {
  return new FileEvent({
    kind: FileChangeKind.CREATE,
    path: PathSpec.fromStrPath(virtual),
    timestamp: TIMESTAMP,
  })
}

describe('Workspace events integration', () => {
  it('lazily attaches, delivers, and detaches the default runtime', async () => {
    const workspace = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] })
    const iterator = workspace.events('/data')[Symbol.asyncIterator]()
    const next = iterator.next()
    await Promise.resolve()
    await workspace.notify(change('/data/new.txt'))
    const result = await next
    if (result.done === true) throw new Error('events ended before delivery')
    expect(result.value.path.virtual).toBe('/data/new.txt')
    await workspace.detachEventRuntime()
    await workspace.close()
  })

  it('accepts string lists and globs', async () => {
    const workspace = new Workspace({ '/data': new RAMVFS() })
    const iterator = workspace.events(['/data/a', '/data/*.txt'])[Symbol.asyncIterator]()
    const next = iterator.next()
    await Promise.resolve()
    await workspace.notify(change('/data/hit.txt'))
    const result = await next
    if (result.done === true) throw new Error('events ended before delivery')
    expect(result.value.path.virtual).toBe('/data/hit.txt')
    await workspace.close()
  })

  it('supports a custom queue factory', async () => {
    const workspace = new Workspace({ '/data': new RAMVFS() })
    workspace.attachEventRuntime(
      new EventHub(workspace.registry, (roots) => new RAMEventQueue(roots, { maxPending: 8 })),
    )
    const iterator = workspace.events('/data')[Symbol.asyncIterator]()
    const next = iterator.next()
    await Promise.resolve()
    await workspace.notify(change('/data/new.txt'))
    const result = await next
    if (result.done === true) throw new Error('events ended before delivery')
    expect(result.value.kind).toBe(FileChangeKind.CREATE)
    await workspace.close()
  })

  it('rejects event operations after close', async () => {
    const workspace = new Workspace({ '/data': new RAMVFS() })
    await workspace.close()
    expect(() => workspace.events('/data')).toThrow('Workspace is closed')
    await expect(workspace.notify(change('/data/a.txt'))).rejects.toThrow('Workspace is closed')
    expect(() => {
      workspace.attachEventRuntime(new EventHub(workspace.registry))
    }).toThrow('Workspace is closed')
  })

  it('rejects replacing an attached runtime', async () => {
    const workspace = new Workspace({ '/data': new RAMVFS() })
    await workspace.notify(change('/data/a.txt'))
    expect(() => {
      workspace.attachEventRuntime(new EventHub(workspace.registry))
    }).toThrow('event runtime already attached')
    await workspace.close()
  })
})
