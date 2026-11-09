import { describe, expect, it } from 'vitest'
import { PathSpec } from '../../types.ts'
import { ProcessTable } from './table.ts'
import { HISTORY_SECONDS } from '../constants.ts'
import { LineId } from '../types.ts'
import { currentProcessId, runAsProcess } from '../../context/session_context.ts'
import type { ProcessHandle } from './handle.ts'
import { FIRST_PID } from './constants.ts'

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
  const processes = new ProcessTable(undefined, undefined, runAsProcess)
  const release = gate()
  const seen: (string | undefined)[][] = []
  const handles = ['first', 'second'].map((line) =>
    processes.start({
      sessionId: 'same',
      command: 'probe',
      cwd: PathSpec.fromStrPath('/'),
      line: new LineId(line),
      cancel: () => undefined,
      run: async () => {
        const before = currentProcessId()
        await release.promise
        seen.push([before?.toString(), currentProcessId()?.toString()])
        return 0
      },
    }),
  )
  await Promise.resolve()
  release.release()
  await Promise.all(handles.map((handle) => handle.join()))
  const ids = handles.map((handle) => handle.record.id.toString()).sort()
  expect(seen.sort()).toEqual(ids.map((id) => [id, id]))
  expect(handles.map((handle) => handle.record.line?.toString()).sort()).toEqual([
    'first',
    'second',
  ])
  expect(currentProcessId()).toBeNull()
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
    line: new LineId('request'),
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
  expect(child.record.parent).toBeNull()
  root.terminate()
  await root.join()
  expect(child.record.state).toBe('running')
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
  await entered.promise
  expect(process.terminate()).toBe(true)
  expect(process.terminate()).toBe(false)
  await cleaning.promise
  expect(processes.visible('a')).toMatchObject([{ state: 'stopping', exit: null }])
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
    exit: 137,
    signal: 9,
  })
  expect(processes.visible('a')).toEqual([])
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
  const oldGrants = processes.forSession('a')
  expect(oldGrants.probe(a.record.id.pid)).toBe(true)
  expect(Object.isFrozen(a.record)).toBe(true)
  expect(Object.isFrozen(processes.visible('a'))).toBe(true)
  processes.revokeSession('a')
  const newGrants = processes.forSession('a'),
    replacement = start('a')
  expect(oldGrants.probe(replacement.record.id.pid)).toBe(false)
  expect(newGrants.probe(replacement.record.id.pid)).toBe(true)
  expect(newGrants.probe(a.record.id.pid)).toBe(false)
  expect(processes.visible('a')).toEqual([replacement.record])
  expect(new Set([a.record.id.pid, b.record.id.pid, replacement.record.id.pid]).size).toBe(3)
  release.release()
  expect(
    (await Promise.all([a.join(), b.join(), replacement.join()])).map((info) => info.exit),
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
  expect(await process.join()).toMatchObject({ exit: 1, error: 'failed cleanup' })
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
  expect(process.record).toMatchObject({ state: 'stopping', exit: null })
  release.release()
  expect(await process.join()).toMatchObject({
    state: 'exited',
    exit: 0,
    signal: null,
  })
  expect(process.signal).toBe(9)
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
  await Promise.all([a.join(), b.join()])
  expect([a.signal, b.signal]).toEqual([9, 9])
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
  const grants = { list: 'workspace', kill: 'session', max: null } as const
  const scoped = processes.forSession('observer', () => grants)
  expect(processes.visible('observer', grants)).toMatchObject([
    { id: { pid: child.record.id.pid }, command: 'secret argument' },
  ])
  expect(() => scoped.probe(child.record.id.pid)).toThrow(
    expect.objectContaining({ code: 'EPERM' }),
  )
  processes.revokeSession('observer')
  expect(() => {
    scoped.checkSpawn()
  }).toThrow('not permitted')
  expect(scoped.probe(child.record.id.pid)).toBe(false)
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

it('the ceiling holds a lifted or larger limit', async () => {
  const processes = new ProcessTable(),
    release = gate()
  processes.ceiling = 1
  const start = (limit: number | null) =>
    processes.start({
      sessionId: 'a',
      command: 'work',
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => undefined,
      limit,
      run: async () => {
        await release.promise
        return 0
      },
    })
  const held = start(null)
  for (const limit of [null, 128]) {
    expect(() => start(limit)).toThrow(expect.objectContaining({ code: 'EAGAIN' }))
  }
  release.release()
  await held.join()
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
    parent: root.record.id.pid,
    run: () => Promise.resolve(0),
  })
  const leaf = processes.start({ ...init, parent: middle.record.id.pid })
  await middle.join()
  expect(leaf.record.group).toBe(root.record.id.pid)
  root.terminate()
  expect(() => processes.start({ ...init, parent: root.record.id.pid })).toThrow(
    'accepting children',
  )
  await processes.drain()
  await leaf.join()
  expect(leaf.signal).not.toBeNull()
  expect(processes.live()).toEqual([])
})

it('cancellation reaches a grandchild past an exited parent below the group leader', async () => {
  const processes = new ProcessTable()
  const init = { sessionId: 'a', command: 'runner', cwd: PathSpec.fromStrPath('/') }
  const held = (parent?: number) => {
    const release = gate()
    return processes.start({
      ...init,
      ...(parent === undefined ? {} : { parent }),
      cancel: () => {
        release.release()
      },
      run: async () => {
        await release.promise
        return 0
      },
    })
  }
  const root = held()
  const job = held(root.record.id.pid)
  const middle = processes.start({
    ...init,
    parent: job.record.id.pid,
    cancel: () => undefined,
    run: () => Promise.resolve(0),
  })
  const leaf = held(middle.record.id.pid)
  await middle.join()
  job.terminate()
  await leaf.join()
  expect(leaf.signal).not.toBeNull()
  expect(root.signal).toBeNull()
  root.terminate()
  await root.join()
})

// A signal the runner's jobs ignore stops the runner alone, under the signal,
// and leaves what it started running.
it('stopping a runner alone leaves its children running', async () => {
  const processes = new ProcessTable()
  const init = { sessionId: 'a', command: 'runner', cwd: PathSpec.fromStrPath('/') }
  const held = (parent?: number) => {
    const release = gate()
    return processes.start({
      ...init,
      ...(parent === undefined ? {} : { parent }),
      cancel: () => {
        release.release()
      },
      run: async () => {
        await release.promise
        return 0
      },
    })
  }
  const parent = held()
  const child = held(parent.record.id.pid)
  expect(parent.terminate(2, false)).toBe(true)
  expect(parent.signal).toBe(2)
  await parent.join()
  expect(parent.signal).not.toBeNull()
  expect(child.signal).toBeNull()
  child.terminate()
  await child.join()
})

// A signal to a process group reaches every runner in it, as killpg(2) does:
// one that ignores it (a shell) hands it to the program it runs right now,
// which ends with it, and goes on; any other stops with it, a child of such a
// shell too. A runner leading a group of its own is not in it.
it("a group signal ends an ignoring shell's program and stops the rest", async () => {
  const processes = new ProcessTable()
  const init = { sessionId: 'a', command: 'sh', cwd: PathSpec.fromStrPath('/') }
  const hung = (parent: number | null, extra: { ownGroup?: boolean } = {}) => {
    const stopped = gate()
    return processes.start({
      ...init,
      ...extra,
      command: 'sleep',
      parent,
      cancel: () => {
        stopped.release()
      },
      run: async () => {
        await stopped.promise
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    })
  }
  const parent = hung(null)
  const started = gate()
  const outcome: [number | null, number | null][] = []
  const child = processes.start({
    ...init,
    parent: parent.record.id.pid,
    ignores: new Set([2]),
    cancel: () => undefined,
    run: async () => {
      outcome.push(
        await child.program(
          (stop) =>
            new Promise<number>((_resolve, reject) => {
              started.release()
              stop.addEventListener('abort', () => {
                reject(stop.reason as Error)
              })
            }),
        ),
      )
      return 0
    },
  })
  const other = hung(parent.record.id.pid)
  const forked = hung(child.record.id.pid)
  const outside = hung(parent.record.id.pid, { ownGroup: true })
  await started.promise
  expect(await processes.signalGroup(parent.record.group, 2)).toBe(true)
  expect((await child.join()).exit).toBe(0)
  expect((await other.join()).exit).toBe(130)
  expect((await forked.join()).exit).toBe(130)
  expect((await parent.join()).exit).toBe(130)
  expect(outcome).toEqual([[null, 2]])
  expect(outside.signal).toBeNull()
  expect(await processes.signalGroup(outside.record.id.pid + 1, 2)).toBe(false)
  outside.terminate()
  await outside.join()
})

// A pid a session's lines take in turn runs each line under it; one a live
// runner holds is not taken twice, and later pids go on past it.
it('takes a given pid while it is free', async () => {
  const processes = new ProcessTable()
  const init = {
    sessionId: 'a',
    command: 'line',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => undefined,
  }
  const first = processes.start({ ...init, pid: FIRST_PID + 6, run: () => Promise.resolve(0) })
  const release = gate()
  const held = processes.start({
    ...init,
    pid: FIRST_PID + 6,
    cancel: () => {
      release.release()
    },
    run: async () => {
      await release.promise
      return 0
    },
  })
  expect([first.record.id.pid, held.record.id.pid]).toEqual([FIRST_PID + 6, FIRST_PID + 7])
  await first.join()
  const again = processes.start({ ...init, pid: FIRST_PID + 6, run: () => Promise.resolve(0) })
  expect(again.record.id.pid).toBe(FIRST_PID + 6)
  await again.join()
  expect(processes.live().map((p) => p.record.id.pid)).toEqual([FIRST_PID + 7])
  held.terminate()
  await held.join()
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
    parent: parent.record.id.pid,
    run: async () => {
      await release.promise
      throw new DOMException('aborted', 'AbortError')
    },
  })
  await parent.join()
  expect(parent.terminate(15)).toBe(false)
  const info = await left.join()
  expect([info.exit, info.signal]).toEqual([143, 15])
})

// A kill reaches the whole group with the signal it named, so a native
// program a child runner started receives that signal too.
it('a group stopped with a signal passes it to every child', async () => {
  const processes = new ProcessTable()
  const start = (parent: number | null): ProcessHandle => {
    const abort = new AbortController()
    return processes.start({
      sessionId: 'a',
      command: 'runner',
      cwd: PathSpec.fromStrPath('/'),
      parent,
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
  const child = start(root.record.id.pid)
  expect(root.terminate(15)).toBe(true)
  expect([(await root.join()).exit, child.signal]).toEqual([143, 15])
  expect((await child.join()).exit).toBe(143)
})

// A caller's setup from the new process (the session's $$) runs before the
// runner does, with the process already live, so a runner that starts at
// once sees both.
it('runs started before the runner with the process live', async () => {
  const processes = new ProcessTable()
  const order: string[] = []
  const handle = processes.start({
    sessionId: 's',
    command: 'probe',
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => undefined,
    started: (process) => {
      order.push(`started ${String(process.record.id.pid)}`)
    },
    run: () => {
      order.push(`run ${JSON.stringify(processes.live().map((p) => p.record.id.pid))}`)
      return Promise.resolve(0)
    },
  })
  await handle.join()
  expect(order).toEqual([`started ${String(FIRST_PID)}`, `run [${String(FIRST_PID)}]`])
})

// A table that publishes the live runners learns each one that started,
// once it is live, so the next publish lists it.
it('tells the publisher of each runner it started', async () => {
  const live: number[] = []
  const processes: ProcessTable = new ProcessTable(undefined, undefined, undefined, () => {
    live.push(processes.live().length)
  })
  for (let i = 0; i < 2; i++) {
    const handle = processes.start({
      sessionId: 's',
      command: 'true',
      cwd: PathSpec.fromStrPath('/'),
      run: () => Promise.resolve(0),
      cancel: () => undefined,
    })
    await handle.join()
  }
  expect(live).toEqual([1, 1])
})

// The table keeps an ended process's record beside the live ones, until it
// is older than the history keeps.
it('keeps an ended process listed until its history lapses', async () => {
  let clock = 100
  const processes = new ProcessTable(undefined, undefined, undefined, undefined, () => clock)
  const start = (command: string, run: () => Promise<number>) =>
    processes.start({
      sessionId: 'a',
      command,
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => undefined,
      run,
    })
  await start('done', () => Promise.resolve(3)).join()
  const release = gate()
  const live = start('held', async () => {
    await release.promise
    return 0
  })
  try {
    expect(processes.records().map((r) => [r.command, r.state, r.exit])).toEqual([
      ['done', 'exited', 3],
      ['held', 'running', null],
    ])
    clock += HISTORY_SECONDS + 1
    expect(processes.records().map((r) => r.command)).toEqual(['held'])
  } finally {
    release.release()
    await live.join()
  }
})

// A process stays in its ancestor's tree after the process between them has
// ended and its record lapsed, and a process outside it never joins.
it('keeps a live grandchild in the tree once its parent has lapsed', async () => {
  let clock = 100
  const processes = new ProcessTable(undefined, undefined, undefined, undefined, () => clock)
  const start = (command: string, run: () => Promise<number>, parent: number | null) =>
    processes.start({
      sessionId: 'a',
      command,
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => undefined,
      run,
      parent,
    })
  const release = gate()
  const middle = gate()
  const held = async (): Promise<number> => {
    await release.promise
    return 0
  }
  const root = start('root', held, null)
  const child = start(
    'child',
    async () => {
      await middle.promise
      return 0
    },
    root.record.id.pid,
  )
  const grandchild = start('grandchild', held, child.record.id.pid)
  const other = start('other', held, null)
  try {
    middle.release()
    await child.join()
    clock += HISTORY_SECONDS + 1
    expect(processes.records().map((r) => r.id.pid)).not.toContain(child.record.id.pid)
    expect([...processes.tree(root.record.id.pid)].sort()).toEqual(
      [root.record.id.pid, grandchild.record.id.pid].sort(),
    )
  } finally {
    release.release()
    await Promise.all([root.join(), grandchild.join(), other.join()])
  }
})

function parked(processes: ProcessTable, ownGroup = false) {
  return processes.start({
    sessionId: 'a',
    command: 'work',
    cwd: PathSpec.fromStrPath('/'),
    ownGroup,
    cancel: () => undefined,
    run: () => new Promise<number>(() => undefined),
  })
}

describe('signal', () => {
  it.each([false, true])('holds what a stopped process is sent (group %s)', async (group) => {
    const processes = new ProcessTable()
    const cancelled: number[] = []
    const process: ProcessHandle = processes.start({
      sessionId: 'a',
      command: 'work',
      cwd: PathSpec.fromStrPath('/'),
      ownGroup: group,
      cancel: () => cancelled.push(process.signal ?? 0),
      run: () => new Promise<number>(() => undefined),
    })
    const send = (number: number) =>
      group
        ? processes.signalGroup(process.record.group, number)
        : processes.signal(process, number)
    expect(await send(19)).toBe(true)
    expect(process.record.shownState).toBe('T')
    expect(await send(15)).toBe(true)
    expect(process.record.state).toBe('running')
    expect(await send(18)).toBe(true)
    expect(process.record.state).toBe('stopping')
    expect(cancelled).toEqual([15])
    expect(process.paused).toBe(false)
  })

  it('lets KILL end a stopped process', async () => {
    const processes = new ProcessTable()
    const process = parked(processes)
    await processes.signal(process, 19)
    expect(await processes.signal(process, 9)).toBe(true)
    expect(process.signal).toBe(9)
    expect(process.paused).toBe(false)
  })

  it('lets a program that takes CONT itself go on', async () => {
    const processes = new ProcessTable()
    const process = parked(processes)
    await processes.signal(process, 19)
    process.oneCommand = true
    const taken: number[] = []
    process.onSignal((number) => taken.push(number))
    expect(await processes.signal(process, 18)).toBe(true)
    expect(taken).toEqual([18])
    expect(process.paused).toBe(false)
  })

  it('leaves a process as it is for a kept signal', async () => {
    const processes = new ProcessTable()
    const process = parked(processes)
    for (const number of [0, 17, 18, 20, 23, 28])
      expect(await processes.signal(process, number)).toBe(true)
    expect(process.record.state).toBe('running')
    expect(process.record.shownState ?? null).toBeNull()
  })
})
