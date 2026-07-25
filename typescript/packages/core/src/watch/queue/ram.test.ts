import { describe, expect, it } from 'vitest'
import { FileChangeKind, FileEvent, OverflowPolicy, PathSpec } from '../../types.ts'
import { QueueOverflowError } from '../errors.ts'
import { RAMWatchQueue } from './ram.ts'

const TIMESTAMP = new Date(0)

function change(kind: FileChangeKind, virtual: string): FileEvent {
  return new FileEvent({ kind, path: PathSpec.fromStrPath(virtual), timestamp: TIMESTAMP })
}

function move(from: string, to: string): FileEvent {
  return new FileEvent({
    kind: FileChangeKind.MOVE,
    path: PathSpec.fromStrPath(to),
    previousPath: PathSpec.fromStrPath(from),
    timestamp: TIMESTAMP,
  })
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

  it('coalesces a move across both of its paths', async () => {
    const queue = new RAMWatchQueue(PathSpec.fromStrPath('/nc'))
    await queue.push(change(FileChangeKind.CREATE, '/nc/a.txt'))
    await queue.push(move('/nc/a.txt', '/nc/b.txt'))
    expect(await queue.pending()).toBe(1)
    const created = await queue.pop()
    expect(created.kind).toBe(FileChangeKind.CREATE)
    expect(created.path.virtual).toBe('/nc/b.txt')

    await queue.push(change(FileChangeKind.UPDATE, '/nc/a.txt'))
    await queue.push(move('/nc/a.txt', '/nc/b.txt'))
    expect(await queue.pending()).toBe(1)
    const moved = await queue.pop()
    expect(moved.kind).toBe(FileChangeKind.MOVE)
    expect(moved.previousPath?.virtual).toBe('/nc/a.txt')

    await queue.push(move('/nc/a.txt', '/nc/b.txt'))
    await queue.push(move('/nc/b.txt', '/nc/c.txt'))
    expect(await queue.pending()).toBe(1)
    const chained = await queue.pop()
    expect(chained.path.virtual).toBe('/nc/c.txt')
    expect(chained.previousPath?.virtual).toBe('/nc/a.txt')
  })

  it('keeps the source disappearance when a moved destination is deleted', async () => {
    const queue = new RAMWatchQueue(PathSpec.fromStrPath('/nc'))
    await queue.push(move('/nc/a.txt', '/nc/b.txt'))
    await queue.push(change(FileChangeKind.DELETE, '/nc/b.txt'))
    expect(await queue.pending()).toBe(1)
    const deleted = await queue.pop()
    expect(deleted.kind).toBe(FileChangeKind.DELETE)
    expect(deleted.path.virtual).toBe('/nc/a.txt')
  })

  it('keeps a pending move across later updates of the destination', async () => {
    const queue = new RAMWatchQueue(PathSpec.fromStrPath('/nc'))
    await queue.push(move('/nc/a.txt', '/nc/b.txt'))
    await queue.push(change(FileChangeKind.UPDATE, '/nc/b.txt'))
    const merged = await queue.pop()
    expect(merged.kind).toBe(FileChangeKind.MOVE)
    expect(merged.previousPath?.virtual).toBe('/nc/a.txt')
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

  it('keeps the overflow marker until a consumer pops it', async () => {
    const queue = new RAMWatchQueue(PathSpec.fromStrPath('/nc'), { maxPending: 2 })
    for (let index = 0; index < 3; index += 1) {
      await queue.push(change(FileChangeKind.CREATE, `/nc/f${String(index)}.txt`))
    }
    await queue.push(change(FileChangeKind.UPDATE, '/nc'))
    expect(await queue.pending()).toBe(1)
    await queue.push(move('/nc', '/nc/moved.txt'))
    expect(await queue.pending()).toBe(2)
    const marker = await queue.pop()
    expect(marker.kind).toBe(FileChangeKind.UNKNOWN)
    expect(marker.path.virtual).toBe('/nc')
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
