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
import { PathSpec } from '../types.ts'
import { ProcessHandle } from './handle.ts'
import type { ProcessInfo } from './types.ts'

function info(): ProcessInfo {
  return {
    pid: 7,
    sessionId: 'a',
    command: 'line',
    cwd: PathSpec.fromStrPath('/'),
    startedAt: 0,
    executionId: 'exec_test',
    state: 'running',
    cancellationRequested: false,
    exitCode: null,
    failure: null,
    parentPid: null,
    groupId: 0,
  }
}

function ignore(): void {
  return undefined
}

function raises(): Promise<number> {
  return Promise.reject(new Error('boom'))
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
    expect([done.state, done.exitCode, finished]).toEqual(['exited', 3, [7]])
  })

  it('a failing runner exits 1 with its failure', async () => {
    const handle = new ProcessHandle(info(), raises, ignore, ignore)
    handle.start()
    const done = await handle.join()
    expect([done.exitCode, done.failure]).toEqual([1, 'boom'])
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
    expect([done.exitCode, done.cancellationRequested]).toEqual([137, true])
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
      (_id, run, process) => {
        bound.push(process)
        return run()
      },
    )
    handle.start()
    expect(handle.signal).toBeNull()
    expect(handle.terminate(signal)).toBe(true)
    const done = await handle.join()
    expect([done.exitCode, handle.signal, bound]).toEqual([code, signal, [handle]])
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
    expect([done.exitCode, handle.programCode]).toEqual([143, 3])
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
    expect([ended.exitCode, ended.failure, finished]).toEqual([1, 'boom', [ended.pid]])
  })
})
