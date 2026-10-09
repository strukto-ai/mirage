import { expect, it } from 'vitest'
import { PathSpec } from '../types.ts'
import { ProcessSupervisor } from './supervisor.ts'
import { currentExecutionId } from '../execution/context.ts'
import type { ProcessHandle } from './handle.ts'

function gate() {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    promise,
    release: () => {
      release()
    },
  }
}

it('isolates execution context between concurrent runners', async () => {
  const supervisor = new ProcessSupervisor()
  const release = gate()
  const seen: (string | null)[][] = []
  const handles = ['first', 'second'].map((executionId) =>
    supervisor.start({
      sessionId: 'same',
      command: 'probe',
      cwd: PathSpec.fromStrPath('/'),
      executionId,
      cancel: () => undefined,
      run: async () => {
        const before = currentExecutionId()
        await release.promise
        seen.push([before, currentExecutionId()])
        return 0
      },
    }),
  )
  await Promise.resolve()
  release.release()
  await Promise.all(handles.map((handle) => handle.join()))
  expect(seen.sort()).toEqual([
    ['first', 'first'],
    ['second', 'second'],
  ])
  expect(currentExecutionId()).toBeNull()
})

it('does not give execution ancestry cancellation ownership', async () => {
  const supervisor = new ProcessSupervisor()
  const started = gate(),
    release = gate()
  const abort = new AbortController()
  const children: ProcessHandle[] = []
  const root = supervisor.start({
    sessionId: 'a',
    command: 'parent',
    cwd: PathSpec.fromStrPath('/'),
    executionId: 'request',
    cancel: () => {
      abort.abort()
    },
    run: async () => {
      children.push(
        supervisor.start({
          sessionId: 'a',
          command: 'detached',
          cwd: PathSpec.fromStrPath('/'),
          cancel: () => undefined,
          run: async () => {
            await release.promise
            return 0
          },
        }),
      )
      started.release()
      await new Promise<void>((_resolve, reject) => {
        abort.signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('aborted', 'AbortError'))
          },
          { once: true },
        )
      })
      return 0
    },
  })
  await started.promise
  const child = children[0]
  if (child === undefined) throw new Error('child was not started')
  expect(child.info).toMatchObject({
    parentExecutionId: 'request',
    rootExecutionId: 'request',
    parentPid: null,
  })
  root.terminate()
  await root.join()
  expect(child.info.state).toBe('running')
  release.release()
  await child.join()
})

it('does not claim exit before finally completes', async () => {
  const supervisor = new ProcessSupervisor()
  const entered = gate(),
    cleaning = gate(),
    release = gate()
  const abort = new AbortController()
  const process = supervisor.start({
    sessionId: 'a',
    command: 'work',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => {
      abort.abort()
    },
    run: async () => {
      entered.release()
      try {
        await new Promise<never>((_, reject) => {
          abort.signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'))
            },
            { once: true },
          )
        })
      } finally {
        cleaning.release()
        await release.promise
      }
      return 0
    },
  })
  const view = supervisor.view('a')
  await entered.promise
  expect(process.terminate()).toBe(true)
  expect(process.terminate()).toBe(false)
  await cleaning.promise
  expect(view.get(process.info.pid)).toMatchObject({ state: 'stopping', exitCode: null })
  let joined = false
  const joining = process.join().then((info) => {
    joined = true
    return info
  })
  await Promise.resolve()
  expect(joined).toBe(false)
  expect(supervisor.live()).toEqual([process])
  release.release()
  expect(await joining).toMatchObject({
    state: 'exited',
    exitCode: 137,
    cancellationRequested: true,
  })
  expect(view.get(process.info.pid)).toBeNull()
  expect(process.terminate()).toBe(false)
})

it('scopes immutable views and revokes them when a session ID is reused', async () => {
  const supervisor = new ProcessSupervisor(),
    release = gate()
  const start = (sessionId: string) =>
    supervisor.start({
      sessionId,
      command: sessionId,
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => undefined,
      run: async () => {
        await release.promise
        return 7
      },
    })
  const a = start('a'),
    b = start('b')
  const oldView = supervisor.view('a')
  expect(oldView.list()).toEqual([a.info])
  expect(oldView.get(b.info.pid)).toBeNull()
  expect(oldView.get(9999)).toBeNull()
  expect(Object.isFrozen(a.info)).toBe(true)
  expect(Object.isFrozen(oldView.list())).toBe(true)
  supervisor.revokeSession('a')
  const newView = supervisor.view('a'),
    replacement = start('a')
  expect(oldView.list()).toEqual([])
  expect(newView.list()).toEqual([replacement.info])
  expect(new Set([a.info.pid, b.info.pid, replacement.info.pid]).size).toBe(3)
  release.release()
  expect(
    (await Promise.all([a.join(), b.join(), replacement.join()])).map((info) => info.exitCode),
  ).toEqual([7, 7, 7])
  expect(supervisor.live()).toEqual([])
})

it('observes runner failures and retires them', async () => {
  const supervisor = new ProcessSupervisor()
  const process = supervisor.start({
    sessionId: 'a',
    command: 'work',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => undefined,
    run: () => Promise.reject(new Error('failed cleanup')),
  })
  expect(await process.join()).toMatchObject({ exitCode: 1, failure: 'failed cleanup' })
  expect(supervisor.live()).toEqual([])
})

it('keeps natural exit distinct from a cancellation request that was ignored', async () => {
  const supervisor = new ProcessSupervisor(),
    release = gate()
  const process = supervisor.start({
    sessionId: 'a',
    command: 'work',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => undefined,
    run: async () => {
      await release.promise
      return 0
    },
  })
  expect(process.terminate()).toBe(true)
  expect(process.info).toMatchObject({ state: 'stopping', exitCode: null })
  release.release()
  expect(await process.join()).toMatchObject({
    state: 'exited',
    exitCode: 0,
    cancellationRequested: true,
  })
})

it('closes admission and requests cancellation of every live runner', async () => {
  const supervisor = new ProcessSupervisor(),
    release = gate()
  const cancelled: string[] = []
  const init = (sessionId: string) => ({
    sessionId,
    command: sessionId,
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => {
      cancelled.push(sessionId)
    },
    run: async () => {
      await release.promise
      return 0
    },
  })
  const a = supervisor.start(init('a')),
    b = supervisor.start(init('b'))
  supervisor.stop()
  supervisor.stop()
  expect(cancelled).toEqual(['a', 'b'])
  expect(() => supervisor.start(init('a'))).toThrow('stopped')
  release.release()
  expect(
    (await Promise.all([a.join(), b.join()])).every((info) => info.cancellationRequested),
  ).toBe(true)
  expect(supervisor.live()).toEqual([])
})

it('a workspace list grants no kill', async () => {
  const supervisor = new ProcessSupervisor(),
    release = gate()
  const child = supervisor.start({
    sessionId: 'other',
    command: 'secret argument',
    cwd: PathSpec.fromStrPath('/private'),
    cancel: () => undefined,
    run: async () => {
      await release.promise
      return 0
    },
  })
  const view = supervisor.view('observer', () => ({
    list: 'workspace',
    kill: 'session',
    max: null,
  }))
  expect(view.get(child.info.pid)).toMatchObject({ command: 'secret argument' })
  expect(() => view.terminate(child.info.pid)).toThrow(expect.objectContaining({ code: 'EPERM' }))
  const waiter = view.wait(child.info.pid)
  supervisor.revokeSession('observer')
  expect(() => {
    view.checkSpawn()
  }).toThrow('not permitted')
  release.release()
  expect(await waiter).toBeNull()
  await child.join()
})

it('start refuses a session at its limit', async () => {
  const supervisor = new ProcessSupervisor(),
    release = gate()
  const start = (sessionId: string) =>
    supervisor.start({
      sessionId,
      command: 'work',
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => undefined,
      limit: 2,
      run: async () => {
        await release.promise
        return 0
      },
    })
  const held = [start('a'), start('a')]
  expect(() => start('a')).toThrow(expect.objectContaining({ code: 'EAGAIN' }))
  held.push(start('b'))
  held[0]?.terminate()
  expect(() => start('a')).toThrow(expect.objectContaining({ code: 'EAGAIN' }))
  release.release()
  await Promise.all(held.map((process) => process.join()))
  await start('a').join()
})

it('group cancellation reaches grandchildren after an intermediate exits', async () => {
  const supervisor = new ProcessSupervisor(),
    release = gate()
  const init = {
    sessionId: 'a',
    command: 'runner',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => {
      release.release()
    },
    run: async () => {
      await release.promise
      return 0
    },
  }
  const root = supervisor.start(init)
  const middle = supervisor.start({
    ...init,
    parentPid: root.info.pid,
    run: () => Promise.resolve(0),
  })
  const leaf = supervisor.start({ ...init, parentPid: middle.info.pid })
  await middle.join()
  expect(leaf.info.groupId).toBe(root.info.pid)
  root.terminate()
  expect(() => supervisor.start({ ...init, parentPid: root.info.pid })).toThrow(
    'accepting children',
  )
  await supervisor.drain()
  expect((await leaf.join()).cancellationRequested).toBe(true)
  expect(supervisor.live()).toEqual([])
})
