// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it } from 'vitest'
import { PathSpec } from '../../types.ts'
import { stopSignal } from '../../utils/abort.ts'
import { newPauseGate, ProcessHandle } from './handle.ts'
import type { Process } from './types.ts'
import { LOCAL_MACHINE } from '../constants.ts'
import { MachineId, ProcessId } from '../types.ts'

describe('a program that stops or takes signals itself', () => {
  const ignored = () => undefined
  const running = () =>
    new ProcessHandle(info(), () => new Promise<number>(ignored), ignored, ignored)

  it('hears when it is held and let go', () => {
    const handle = running()
    const heard: boolean[] = []
    const forget = handle.onHold((held) => heard.push(held))
    expect(heard).toEqual([])
    handle.pauses.set(7, newPauseGate())
    handle.tellHeld()
    handle.tellHeld()
    expect(heard).toEqual([true])
    handle.pauses.clear()
    handle.tellHeld()
    expect(heard).toEqual([true, false])
    handle.pauses.set(7, newPauseGate())
    handle.tellHeld()
    forget()
    expect(heard).toEqual([true, false, true, false])
    const late: boolean[] = []
    handle.onHold((held) => late.push(held))
    expect(late).toEqual([true])
  })

  it('takes what is sent to a runner started for it, never KILL or STOP', () => {
    const handle = running()
    const taken: number[] = []
    expect(handle.onSignal((signal) => taken.push(signal))).toBeTypeOf('function')
    expect(handle.takeSignal(15)).toBe(false)
    handle.oneCommand = true
    const forget = handle.onSignal((signal) => taken.push(signal))
    expect(handle.takeSignal(15)).toBe(true)
    for (const signal of [9, 19]) expect(handle.takeSignal(signal)).toBe(false)
    expect(handle.takeSignal(18)).toBe(true)
    expect(taken).toEqual([15, 18])
    forget()
    expect(handle.takeSignal(15)).toBe(false)
  })
})

function info(): Process {
  return {
    id: new ProcessId('w', 7),
    sessionId: 'a',
    line: null,
    parent: null,
    group: 7,
    command: 'line',
    cwd: PathSpec.fromStrPath('/'),
    machine: LOCAL_MACHINE,
    startedAt: 0,
    runtime: null,
    machinePid: null,
    state: 'running',
    endedAt: null,
    exit: null,
    signal: null,
    error: null,
    ancestors: [],
  }
}

function ignore(): void {
  return undefined
}

function raises(): Promise<number> {
  return Promise.reject(new Error('boom'))
}

/** A runner that waits until the handle stops it, then fails as aborted. */
function hung(): ProcessHandle {
  const stop = new AbortController()
  const handle = new ProcessHandle(
    info(),
    () =>
      new Promise<number>((_resolve, reject) => {
        stop.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      }),
    () => {
      stop.abort()
    },
    ignore,
  )
  handle.start(true)
  return handle
}

describe('ProcessHandle', () => {
  it('a finished runner reports its code and its pid', async () => {
    const finished: number[] = []
    const handle = new ProcessHandle(
      info(),
      () => Promise.resolve(3),
      ignore,
      (pid) => {
        finished.push(pid)
      },
    )
    handle.start()
    const done = await handle.join()
    expect([done.state, done.exit, finished]).toEqual(['exited', 3, [7]])
  })

  it('a failing runner exits 1 with its failure', async () => {
    const handle = new ProcessHandle(info(), raises, ignore, ignore)
    handle.start()
    const done = await handle.join()
    expect([done.exit, done.error]).toEqual([1, 'boom'])
  })

  // A program the runner runs where an interrupt reaches it hands back what
  // it returned; a failure of its own is still its failure.
  it('a program returns unless interrupted and its own failure passes', async () => {
    const handle = new ProcessHandle(info(), () => Promise.resolve(0), ignore, ignore)
    handle.interrupt(2)
    expect(await handle.program(() => Promise.resolve(3))).toEqual([3, null])
    await expect(handle.program(raises)).rejects.toThrow('boom')
  })

  // A native run reads the signal an interrupt stops its program with, from
  // the runner or the program's abort, so it hands the program INT rather
  // than killing it; once the program is gone, nothing is stopping.
  it('names the signal an interrupt stops its program with', async () => {
    const handle = new ProcessHandle(info(), () => Promise.resolve(0), ignore, ignore)
    const seen: (number | null)[] = []
    const ran = handle.program(
      (stop) =>
        new Promise<number>((_, reject) => {
          stop.addEventListener('abort', () => {
            seen.push(handle.interrupted, stopSignal(stop))
            reject(stop.reason as Error)
          })
        }),
    )
    handle.interrupt(2)
    expect(await ran).toEqual([null, 2])
    expect([...seen, handle.interrupted]).toEqual([2, 2, null])
  })

  // A program that takes only some signals runs on through the others.
  it('runs a program on through a signal it does not take', async () => {
    const handle = new ProcessHandle(info(), () => Promise.resolve(0), ignore, ignore)
    let finish = (): void => undefined
    const ran = handle.program(
      () =>
        new Promise<number>((resolve) => {
          finish = () => {
            resolve(7)
          }
        }),
      new Set([2]),
    )
    handle.interrupt(3)
    finish()
    expect(await ran).toEqual([7, null])
  })

  it('terminate asks once and the runner exits 137', async () => {
    const abort = new AbortController()
    let started = ignore
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const run = (): Promise<number> =>
      new Promise((_resolve, reject) => {
        abort.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
        started()
      })
    const cancel = (): void => {
      abort.abort()
    }
    const handle = new ProcessHandle(info(), run, cancel, ignore)
    handle.start()
    await running
    expect(handle.terminate()).toBe(true)
    expect(handle.terminate()).toBe(false)
    const done = await handle.join()
    expect([done.exit, done.signal]).toEqual([137, 9])
  })

  // A stop stands for the signal a kill named: the binder hands the runner
  // its handle, and its status is 128 plus the signal, as bash reports a
  // child that signal ended.
  it.each([
    [15, 143],
    [2, 130],
    [1, 129],
  ])('a runner stopped with signal %i exits %i', async (signal, code) => {
    const abort = new AbortController()
    const run = (): Promise<number> =>
      new Promise((_resolve, reject) => {
        const stop = (): void => {
          reject(new DOMException('aborted', 'AbortError'))
        }
        if (abort.signal.aborted) stop()
        else abort.signal.addEventListener('abort', stop)
      })
    const bound: ProcessHandle[] = []
    const handle = new ProcessHandle(
      info(),
      run,
      () => {
        abort.abort()
      },
      ignore,
      ignore,
      (run, process) => {
        bound.push(process)
        return run()
      },
    )
    handle.start()
    expect(handle.signal).toBeNull()
    expect(handle.terminate(signal)).toBe(true)
    const done = await handle.join()
    expect([done.exit, handle.signal, bound]).toEqual([code, signal, [handle]])
  })

  // A KILL while the runner still stops under a gentler signal takes over,
  // for the runner and what it started, as a second `kill -KILL` does; a
  // repeated stop does not.
  it('a kill takes over a gentler stop', async () => {
    const abort = new AbortController()
    const run = (): Promise<number> =>
      new Promise((_resolve, reject) => {
        const stop = (): void => {
          reject(new DOMException('aborted', 'AbortError'))
        }
        if (abort.signal.aborted) stop()
        else abort.signal.addEventListener('abort', stop)
      })
    const children: number[] = []
    const handle = new ProcessHandle(
      info(),
      run,
      () => {
        abort.abort()
      },
      ignore,
      (signal) => {
        children.push(signal)
      },
    )
    handle.start()
    expect(handle.terminate(15)).toBe(true)
    expect(handle.terminate(15)).toBe(false)
    expect(handle.terminate(9)).toBe(true)
    expect(handle.terminate(9)).toBe(false)
    const done = await handle.join()
    expect([done.exit, handle.signal, children]).toEqual([137, 9, [15, 9]])
  })

  it('ignores only what the program that takes it inherits', () => {
    const handle = new ProcessHandle(
      info(),
      () => Promise.resolve(3),
      ignore,
      ignore,
      undefined,
      undefined,
      new Set([2, 3]),
    )
    handle.oneCommand = true
    handle.programIgnores = new Set([2])
    expect(handle.ignores.has(3)).toBe(true)
    expect(handle.take(null, 'local')).toBe(true)
    expect([...handle.ignores]).toEqual([2])
  })

  // A runner started for one command is its program once, on the program's
  // machine and runtime; one started for more, or taken already, is not,
  // and a host program's pid lands on the record.
  it('is the program of the one command it was started for, once', () => {
    const handle = new ProcessHandle(info(), () => Promise.resolve(3), ignore, ignore)
    expect(handle.take(null, 'docker')).toBe(false)
    handle.oneCommand = true
    expect(handle.take(new MachineId('docker', 'tools'), 'docker')).toBe(true)
    expect(handle.take(null, 'local')).toBe(false)
    expect([handle.record.machine.toString(), handle.record.runtime]).toEqual([
      'docker:tools',
      'docker',
    ])
    handle.setMachinePid({ pid: 41, started: 5 })
    expect(handle.record.machinePid).toEqual({ pid: 41, started: 5 })
    const other = new ProcessHandle(info(), () => Promise.resolve(3), ignore, ignore)
    other.oneCommand = true
    expect(other.take(null, 'local')).toBe(true)
    expect([other.record.machine, other.record.runtime]).toEqual([LOCAL_MACHINE, 'local'])
  })

  // What a program the runner started exited with after handling the
  // signal is the program's, kept apart from the runner's own 128 plus it.
  it('keeps the status of a program that handled the signal', async () => {
    const abort = new AbortController()
    let handle: ProcessHandle | null = null
    const run = (): Promise<number> =>
      new Promise((_resolve, reject) => {
        const stop = (): void => {
          handle?.programExited(3)
          reject(new DOMException('aborted', 'AbortError'))
        }
        if (abort.signal.aborted) stop()
        else abort.signal.addEventListener('abort', stop)
      })
    handle = new ProcessHandle(
      info(),
      run,
      () => {
        abort.abort()
      },
      ignore,
    )
    handle.start()
    expect(handle.programCode).toBeNull()
    expect(handle.terminate(15)).toBe(true)
    const done = await handle.join()
    expect([done.exit, handle.programCode]).toEqual([143, 3])
  })

  // An eager start runs the runner up to its first wait before start
  // returns, so a caller's setup must come first: the process table's
  // `started` hook.
  it('an eager start runs the runner before start returns', () => {
    const order: string[] = []
    const handle = new ProcessHandle(
      info(),
      () => {
        order.push('run')
        return Promise.resolve(0)
      },
      ignore,
      ignore,
    )
    handle.start(true)
    order.push('returned')
    expect(order).toEqual(['run', 'returned'])
  })

  // A runner that throws before it returns its promise fails like one
  // whose promise rejects, so its slot is freed rather than held forever.
  it('an eager runner that throws at once fails and finishes', async () => {
    const finished: number[] = []
    const handle = new ProcessHandle(
      info(),
      () => {
        throw new Error('boom')
      },
      ignore,
      (pid) => finished.push(pid),
    )
    handle.start(true)
    const ended = await handle.join()
    expect([ended.exit, ended.error, finished]).toEqual([1, 'boom', [ended.id.pid]])
  })

  // Reaping a runner waits for it as wait(2) does: its code, or 128 plus the
  // signal that stopped it; one the host stopped (revoked) ends the wait with
  // its error, and so does a waiter whose own shell stopped.
  it('reap answers a status unless the host stopped the runner', async () => {
    const done = new ProcessHandle(info(), () => Promise.resolve(3), ignore, ignore)
    done.start()
    expect(await done.reap()).toBe(3)
    const stopped = hung()
    stopped.terminate(15)
    expect(await stopped.reap()).toBe(143)
    const revoked = hung()
    revoked.revoked = true
    revoked.terminate()
    await expect(revoked.reap()).rejects.toMatchObject({ name: 'AbortError' })
    const waiter = new AbortController()
    waiter.abort()
    const waited = hung()
    waited.terminate()
    await expect(waited.reap(waiter.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

it('names TERM at a deadline and lets a stopped process go', async () => {
  const handle = new ProcessHandle(
    info(),
    () => Promise.resolve(3),
    () => undefined,
    () => undefined,
  )
  const gate = newPauseGate()
  handle.pauses.set(7, gate)
  expect(handle.paused).toBe(true)
  expect(handle.interrupted).toBeNull()
  handle.expire()
  await gate.promise
  expect(handle.paused).toBe(false)
  expect(handle.interrupted).toBe(15)
  expect(handle.signal).toBeNull()
})
