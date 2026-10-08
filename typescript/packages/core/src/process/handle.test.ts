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
    const done = await handle.join()
    expect([done.state, done.exitCode, finished]).toEqual(['exited', 3, [7]])
  })

  it('a failing runner exits 1 with its failure', async () => {
    const done = await new ProcessHandle(info(), raises, ignore, ignore).join()
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
    await running
    expect(handle.terminate()).toBe(true)
    expect(handle.terminate()).toBe(false)
    const done = await handle.join()
    expect([done.exitCode, done.cancellationRequested]).toEqual([137, true])
  })
})
