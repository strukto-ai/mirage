import { expect, it } from 'vitest'
import { PathSpec } from '../types.ts'
import { ProcessTable } from './table.ts'
import { currentExecutionId, runWithExecution } from '../context/session_context.ts'
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
  const processes = new ProcessTable(runWithExecution)
  const release = gate()
  const seen: (string | null)[][] = []
  const handles = ['first', 'second'].map((executionId) =>
    processes.start({
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
  const processes = new ProcessTable()
  const started = gate(),
    release = gate()
  const abort = new AbortController()
  const children: ProcessHandle[] = []
  const root = processes.start({
    sessionId: 'a',
    command: 'parent',
    cwd: PathSpec.fromStrPath('/'),
    executionId: 'request',
    cancel: () => {
      abort.abort()
    },
    run: async () => {
      children.push(
        processes.start({
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
  expect(child.info.parentPid).toBeNull()
  root.terminate()
  await root.join()
  expect(child.info.state).toBe('running')
  release.release()
  await child.join()
})

it('does not claim exit before finally completes', async () => {
  const processes = new ProcessTable()
  const entered = gate(),
    cleaning = gate(),
    release = gate()
  const abort = new AbortController()
  const process = processes.start({
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
  const view = processes.view('a')
  await entered.promise
  expect(process.terminate()).toBe(true)
  expect(process.terminate()).toBe(false)
  await cleaning.promise
  expect(view.list()).toMatchObject([{ state: 'stopping', exitCode: null }])
  let joined = false
  const joining = process.join().then((info) => {
    joined = true
    return info
  })
  await Promise.resolve()
  expect(joined).toBe(false)
  expect(processes.live()).toEqual([process])
  release.release()
  expect(await joining).toMatchObject({
    state: 'exited',
    exitCode: 137,
    cancellationRequested: true,
  })
  expect(view.list()).toEqual([])
  expect(process.terminate()).toBe(false)
})

it('scopes immutable views and revokes them when a session ID is reused', async () => {
  const processes = new ProcessTable(),
    release = gate()
  const start = (sessionId: string) =>
    processes.start({
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
  const oldView = processes.view('a')
  expect(oldView.list()).toEqual([a.info])
  expect(Object.isFrozen(a.info)).toBe(true)
  expect(Object.isFrozen(oldView.list())).toBe(true)
  processes.revokeSession('a')
  const newView = processes.view('a'),
    replacement = start('a')
  expect(oldView.list()).toEqual([])
  expect(newView.list()).toEqual([replacement.info])
  expect(new Set([a.info.pid, b.info.pid, replacement.info.pid]).size).toBe(3)
  release.release()
  expect(
    (await Promise.all([a.join(), b.join(), replacement.join()])).map((info) => info.exitCode),
  ).toEqual([7, 7, 7])
  expect(processes.live()).toEqual([])
})

it('observes runner failures and retires them', async () => {
  const processes = new ProcessTable()
  const process = processes.start({
    sessionId: 'a',
    command: 'work',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => undefined,
    run: () => Promise.reject(new Error('failed cleanup')),
  })
  expect(await process.join()).toMatchObject({ exitCode: 1, failure: 'failed cleanup' })
  expect(processes.live()).toEqual([])
})

it('keeps natural exit distinct from a cancellation request that was ignored', async () => {
  const processes = new ProcessTable(),
    release = gate()
  const process = processes.start({
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
  const processes = new ProcessTable(),
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
  const a = processes.start(init('a')),
    b = processes.start(init('b'))
  processes.stop()
  processes.stop()
  expect(cancelled).toEqual(['a', 'b'])
  expect(() => processes.start(init('a'))).toThrow('stopped')
  release.release()
  expect(
    (await Promise.all([a.join(), b.join()])).every((info) => info.cancellationRequested),
  ).toBe(true)
  expect(processes.live()).toEqual([])
})

it('a workspace list grants no kill', async () => {
  const processes = new ProcessTable(),
    release = gate()
  const child = processes.start({
    sessionId: 'other',
    command: 'secret argument',
    cwd: PathSpec.fromStrPath('/private'),
    cancel: () => undefined,
    run: async () => {
      await release.promise
      return 0
    },
  })
  const view = processes.view('observer', () => ({
    list: 'workspace',
    kill: 'session',
    max: null,
  }))
  expect(view.list()).toMatchObject([{ pid: child.info.pid, command: 'secret argument' }])
  expect(() => view.terminate(child.info.pid, 15)).toThrow(
    expect.objectContaining({ code: 'EPERM' }),
  )
  processes.revokeSession('observer')
  expect(() => {
    view.checkSpawn()
  }).toThrow('not permitted')
  expect(view.list()).toEqual([])
  release.release()
  await child.join()
})

it('start refuses a session at its limit', async () => {
  const processes = new ProcessTable(),
    release = gate()
  const start = (sessionId: string) =>
    processes.start({
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
  const processes = new ProcessTable(),
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
  const root = processes.start(init)
  const middle = processes.start({
    ...init,
    parentPid: root.info.pid,
    run: () => Promise.resolve(0),
  })
  const leaf = processes.start({ ...init, parentPid: middle.info.pid })
  await middle.join()
  expect(leaf.info.groupId).toBe(root.info.pid)
  root.terminate()
  expect(() => processes.start({ ...init, parentPid: root.info.pid })).toThrow('accepting children')
  await processes.drain()
  expect((await leaf.join()).cancellationRequested).toBe(true)
  expect(processes.live()).toEqual([])
})

// A runner that already exited has nothing left to cancel, but stopping it
// still stops what it left running (`sh -c 'sleep 100 &'`).
it('stopping an exited runner stops what it left running', async () => {
  const processes = new ProcessTable(),
    release = gate()
  const init = {
    sessionId: 'a',
    command: 'sh',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => {
      release.release()
    },
    run: () => Promise.resolve(0),
  }
  const parent = processes.start(init)
  const left = processes.start({
    ...init,
    command: 'sleep',
    parentPid: parent.info.pid,
    run: async () => {
      await release.promise
      throw new DOMException('aborted', 'AbortError')
    },
  })
  await parent.join()
  expect(parent.terminate(15)).toBe(false)
  const info = await left.join()
  expect([info.exitCode, info.cancellationRequested]).toEqual([143, true])
})

// A kill reaches the whole group with the signal it named, so a native
// program a child runner started receives that signal too.
it('a group stopped with a signal passes it to every child', async () => {
  const processes = new ProcessTable()
  const start = (parentPid: number | null): ProcessHandle => {
    const abort = new AbortController()
    return processes.start({
      sessionId: 'a',
      command: 'runner',
      cwd: PathSpec.fromStrPath('/'),
      parentPid,
      cancel: () => {
        abort.abort()
      },
      run: () =>
        new Promise((_resolve, reject) => {
          const stop = (): void => {
            reject(new DOMException('aborted', 'AbortError'))
          }
          if (abort.signal.aborted) stop()
          else abort.signal.addEventListener('abort', stop)
        }),
    })
  }
  const root = start(null)
  const child = start(root.info.pid)
  expect(root.terminate(15)).toBe(true)
  expect([(await root.join()).exitCode, child.signal]).toEqual([143, 15])
  expect((await child.join()).exitCode).toBe(143)
})

// A caller's setup from the new process's identity (the session's
// $BASHPID) runs before the runner does, with the process already live,
// so a runner that starts at once sees both.
it('runs started before the runner with the process live', async () => {
  const processes = new ProcessTable()
  const order: string[] = []
  const handle = processes.start({
    sessionId: 's',
    command: 'probe',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => undefined,
    started: (info) => {
      order.push(`started ${String(info.pid)}`)
    },
    run: () => {
      order.push(`run ${JSON.stringify(processes.live().map((p) => p.info.pid))}`)
      return Promise.resolve(0)
    },
  })
  await handle.join()
  expect(order).toEqual(['started 1', 'run [1]'])
})
