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

import { describe, expect, it, vi } from 'vitest'
import { PathSpec } from '../../../types.ts'
import { MontyExecution } from './execution.ts'

interface PoolHooks {
  loadPool: () => Promise<unknown>
  ensurePool: () => Promise<unknown>
}

describe('MontyExecution.close', () => {
  it('waits for a pool still being opened and closes it', async () => {
    const execution = new MontyExecution()
    const hooks = execution as unknown as PoolHooks
    let release: (pool: unknown) => void = () => undefined
    const close = vi.fn(() => Promise.resolve())
    vi.spyOn(hooks, 'loadPool').mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const opening = hooks.ensurePool()
    const closing = execution.close()
    release({ close })
    await Promise.all([opening, closing])
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('neither keeps nor rethrows a pool that failed to open', async () => {
    const execution = new MontyExecution()
    const hooks = execution as unknown as PoolHooks
    const loadPool = vi
      .spyOn(hooks, 'loadPool')
      .mockImplementation(() => Promise.reject(new Error('monty is not installed')))
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    await expect(hooks.ensurePool()).rejects.toThrow('not installed')
    await expect(hooks.ensurePool()).rejects.toThrow('not installed')
    await expect(execution.close()).resolves.toBeUndefined()
    expect(loadPool).toHaveBeenCalledTimes(2)
  })

  it('closes cleanly when the pool it waits for fails to open', async () => {
    const execution = new MontyExecution()
    const hooks = execution as unknown as PoolHooks
    let fail: (err: Error) => void = () => undefined
    vi.spyOn(hooks, 'loadPool').mockReturnValue(
      new Promise((_, reject) => {
        fail = reject
      }),
    )
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const opening = hooks.ensurePool()
    const closing = execution.close()
    fail(new Error('monty is not installed'))
    await expect(opening).rejects.toThrow('not installed')
    await expect(closing).resolves.toBeUndefined()
  })
})

// A reader that holds a finished program's last prints back does not hold
// its kill back: the run ends at the abort.
describe('MontyExecution.run', () => {
  it('stops at an abort while its reader holds the prints back', async () => {
    const execution = new MontyExecution()
    const stop = new AbortController()
    let taken = 0
    const output = (): Promise<void> => {
      taken += 1
      return new Promise<void>(() => undefined)
    }
    try {
      const run = execution.run(
        { code: 'print(1)\n', args: [], stdin: null },
        { stdin: null, flags: {}, cwd: PathSpec.fromStrPath('/'), signal: stop.signal },
        null,
        output,
      )
      await vi.waitFor(() => {
        expect(taken).toBe(1)
      })
      stop.abort()
      const result = await run
      expect(result.exitCode).toBe(1)
    } finally {
      await execution.close()
    }
  }, 30_000)
})
