import { describe, expect, it } from 'vitest'
import { FileChangeKind, FileEvent, OverflowPolicy, PathSpec } from '../../types.ts'
import { QueueOverflowError } from '../errors.ts'
import { RAMWatchQueue } from './ram.ts'

const TIMESTAMP = new Date(0)

function change(kind: FileChangeKind, virtual: string): FileEvent {
  return new FileEvent({ kind, path: PathSpec.fromStrPath(virtual), timestamp: TIMESTAMP })
}

describe('RAMWatchQueue', () => {
  it('pushes and pops a change', async () => {
    const queue = new RAMWatchQueue(PathSpec.fromStrPath('/nc'))
    await queue.push(change(FileChangeKind.CREATE, '/nc/a.txt'))
    expect((await queue.pop()).kind).toBe(FileChangeKind.CREATE)
    expect(await queue.pending()).toBe(0)
  })

  it('coalesces changes with level-triggered semantics', async () => {
    const queue = new RAMWatchQueue(PathSpec.fromStrPath('/nc'))
    await queue.push(change(FileChangeKind.CREATE, '/nc/a.txt'))
    await queue.push(change(FileChangeKind.UPDATE, '/nc/a.txt'))
    expect((await queue.pop()).kind).toBe(FileChangeKind.CREATE)
    await queue.push(change(FileChangeKind.CREATE, '/nc/a.txt'))
    await queue.push(change(FileChangeKind.DELETE, '/nc/a.txt'))
    expect(await queue.pending()).toBe(0)
    await queue.push(change(FileChangeKind.DELETE, '/nc/a.txt'))
    await queue.push(change(FileChangeKind.CREATE, '/nc/a.txt'))
    expect((await queue.pop()).kind).toBe(FileChangeKind.UPDATE)
  })

  it('collapses overflow to one unknown event per root', async () => {
    const roots = [PathSpec.fromStrPath('/nc/docs'), PathSpec.fromStrPath('/s3/exports')]
    const queue = new RAMWatchQueue(roots, { maxPending: 2 })
    for (let index = 0; index < 3; index += 1) {
      await queue.push(change(FileChangeKind.CREATE, `/nc/docs/f${String(index)}.txt`))
    }
    const events = [await queue.pop(), await queue.pop()]
    expect(events.map((event) => event.kind)).toEqual([
      FileChangeKind.UNKNOWN,
      FileChangeKind.UNKNOWN,
    ])
    expect(new Set(events.map((event) => event.path.virtual))).toEqual(
      new Set(['/nc/docs', '/s3/exports']),
    )
  })

  it('drops the oldest change under drop_oldest', async () => {
    const queue = new RAMWatchQueue(PathSpec.fromStrPath('/nc'), {
      maxPending: 2,
      onOverflow: OverflowPolicy.DROP_OLDEST,
    })
    for (let index = 0; index < 4; index += 1) {
      await queue.push(change(FileChangeKind.CREATE, `/nc/f${String(index)}.txt`))
    }
    expect(await queue.pending()).toBe(2)
    expect((await queue.pop()).path.virtual).toBe('/nc/f2.txt')
  })

  it('raises after overflow under error', async () => {
    const queue = new RAMWatchQueue(PathSpec.fromStrPath('/nc'), {
      maxPending: 1,
      onOverflow: OverflowPolicy.ERROR,
    })
    await queue.push(change(FileChangeKind.CREATE, '/nc/a.txt'))
    await queue.push(change(FileChangeKind.CREATE, '/nc/b.txt'))
    await expect(queue.pop()).rejects.toBeInstanceOf(QueueOverflowError)
  })

  it('keeps a blocked consumer wakeable after clear', async () => {
    const queue = new RAMWatchQueue(PathSpec.fromStrPath('/nc'))
    const pending = queue.pop()
    await queue.clear()
    await queue.push(change(FileChangeKind.CREATE, '/nc/a.txt'))
    expect((await pending).path.virtual).toBe('/nc/a.txt')
  })
})
