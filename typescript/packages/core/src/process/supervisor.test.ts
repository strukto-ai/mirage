import { expect, it } from 'vitest'
import { abortable } from '../workspace/abort.ts'
import { PathSpec } from '../types.ts'
import { ProcessSupervisor } from './supervisor.ts'

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

it('workspace metadata grants neither foreign details nor control', async () => {
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
    metadata: 'workspace',
    details: 'session',
    control: 'session',
    spawn: false,
  }))
  expect(view.get(child.info.pid)).toMatchObject({ command: null, cwd: null })
  expect(view.terminate(child.info.pid)).toBe(false)
  expect(() => {
    view.checkSpawn()
  }).toThrow('not permitted')
  const waiter = view.wait(child.info.pid)
  supervisor.revokeSession('observer')
  release.release()
  expect(await waiter).toBeNull()
  await child.join()
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

it('retains aborted operations until their actual completion', async () => {
  const supervisor = new ProcessSupervisor(),
    release = gate(),
    entered = gate()
  const abort = new AbortController()
  const child = supervisor.start({
    sessionId: 'a',
    command: 'runner',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => {
      abort.abort()
    },
    run: async () => {
      entered.release()
      await abortable(release.promise, abort.signal)
      return 0
    },
  })
  await entered.promise
  child.terminate()
  let joined = false
  const joining = child.join().then(() => {
    joined = true
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(joined).toBe(false)
  expect(child.info.state).toBe('stopping')
  release.release()
  await joining
  expect(child.info.exitCode).toBe(137)
})
