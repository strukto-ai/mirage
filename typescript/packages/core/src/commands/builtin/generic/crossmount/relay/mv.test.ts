import { expect, it } from 'vitest'
import { IOResult } from '../../../../../io/types.ts'
import type { DispatchFn } from '../../../../../runtime/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../../types.ts'
import { enoent, eacces } from '../../../../../utils/errors.ts'
import { guardDispatch } from '../../../../../workspace/abort.ts'
import { runMv } from './mv.ts'

it.each(['read', 'write'])(
  'cancelled move stops dispatch after pending %s settles',
  async (blockedOp) => {
    const controller = new AbortController()
    const calls: [string, string][] = []
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatch: DispatchFn = async (op, path) => {
      calls.push([op, path.virtual])
      if (op === blockedOp) {
        enter()
        await pending
      }
      if (op === 'stat') {
        if (['/a/one', '/a/two'].includes(path.virtual)) {
          return [new FileStat({ name: 'source', type: FileType.FILE }), new IOResult()]
        }
        if (path.virtual === '/b') {
          return [new FileStat({ name: 'b', type: FileType.DIRECTORY }), new IOResult()]
        }
        throw enoent(path)
      }
      return [op === 'read' ? new TextEncoder().encode('payload') : null, new IOResult()]
    }
    const scopes = ['/a/one', '/a/two', '/b'].map((p) => PathSpec.fromStrPath(p))
    const running = runMv(scopes, {}, guardDispatch(dispatch, controller.signal))
    const interrupted = expect(running).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await entered
      controller.abort()
    } finally {
      release()
    }
    await interrupted
    expect(calls.some(([op]) => ['unlink', 'rmdir'].includes(op))).toBe(false)
    expect(calls).not.toContainEqual(['read', '/a/two'])
    expect(calls).not.toContainEqual(['write', '/b/two'])
  },
)

it('failed destination write preserves move source', async () => {
  const calls: [string, string][] = []
  const dispatch: DispatchFn = async (op, path) => {
    await Promise.resolve()
    calls.push([op, path.virtual])
    if (op === 'stat') {
      if (path.virtual === '/a/one') {
        return [new FileStat({ name: 'one', type: FileType.FILE }), new IOResult()]
      }
      if (path.virtual === '/b') {
        return [new FileStat({ name: 'b', type: FileType.DIRECTORY }), new IOResult()]
      }
      throw enoent(path)
    }
    if (op === 'write') throw eacces(path)
    return [op === 'read' ? new TextEncoder().encode('payload') : null, new IOResult()]
  }
  const scopes = ['/a/one', '/b/one'].map((p) => PathSpec.fromStrPath(p))
  const [, io] = await runMv(scopes, {}, dispatch)
  expect(io.exitCode).toBe(1)
  expect(calls).toContainEqual(['write', '/b/one'])
  expect(calls.some(([op]) => ['unlink', 'rmdir'].includes(op))).toBe(false)
})
