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
import { CommandTimeoutError } from '../../../errors/types.ts'
import { PathSpec } from '../../../types.ts'
import { POOL_WORKERS } from './constants.ts'
import { MontyExecution } from './execution.ts'
import type * as loader from './loader.ts'

const fake = vi.hoisted(() => ({ module: null as unknown }))

vi.mock('./loader.ts', async (importOriginal) => {
  const original = await importOriginal<typeof loader>()
  return {
    ...original,
    loadMontyModule: (): Promise<loader.MontyModuleLike> =>
      fake.module === null
        ? original.loadMontyModule()
        : Promise.resolve(fake.module as loader.MontyModuleLike),
  }
})

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
describe('the shared pool', () => {
  it('serves every runtime and closes with the last one', async () => {
    const pools: { options: unknown; close: ReturnType<typeof vi.fn> }[] = []
    fake.module = {
      Monty: {
        create: (options: unknown) => {
          const pool = { options, close: vi.fn(() => Promise.resolve()) }
          pools.push(pool)
          return Promise.resolve(pool)
        },
      },
    }
    try {
      const first = new MontyExecution(null, true)
      const second = new MontyExecution(null, true)
      const one = await (first as unknown as PoolHooks).ensurePool()
      expect(await (second as unknown as PoolHooks).ensurePool()).toBe(one)
      expect(pools.map((pool) => pool.options)).toEqual([{ maxProcesses: POOL_WORKERS }])
      await first.close()
      expect(pools[0]?.close).not.toHaveBeenCalled()
      await second.close()
      expect(pools[0]?.close).toHaveBeenCalledTimes(1)
      const third = new MontyExecution(null, true)
      expect(await (third as unknown as PoolHooks).ensurePool()).not.toBe(one)
      await third.close()
    } finally {
      fake.module = null
    }
  })
})

describe('MontyExecution.run', () => {
  it('stops at its deadline while it waits for a worker, and gives a late one back', async () => {
    const execution = new MontyExecution()
    const late = { workerPid: undefined, close: vi.fn(() => Promise.resolve()) }
    let arrive: (session: typeof late) => void = () => undefined
    vi.spyOn(execution as unknown as PoolHooks, 'loadPool').mockResolvedValue({
      checkout: () =>
        new Promise((resolve) => {
          arrive = resolve
        }),
      close: () => Promise.resolve(),
    })
    try {
      await expect(
        execution.run(
          { code: 'print(1)\n', args: [], stdin: null },
          { stdin: null, flags: {}, cwd: PathSpec.fromStrPath('/'), timeoutSeconds: 0.05 },
          null,
        ),
      ).rejects.toBeInstanceOf(CommandTimeoutError)
      expect(late.close).not.toHaveBeenCalled()
      arrive(late)
      await vi.waitFor(() => {
        expect(late.close).toHaveBeenCalledTimes(1)
      })
    } finally {
      await execution.close()
    }
  })

  it('stops at an abort while it waits for a worker', async () => {
    const execution = new MontyExecution()
    const stop = new AbortController()
    vi.spyOn(execution as unknown as PoolHooks, 'loadPool').mockResolvedValue({
      checkout: () => new Promise(() => undefined),
      close: () => Promise.resolve(),
    })
    try {
      const run = execution.run(
        { code: 'print(1)\n', args: [], stdin: null },
        { stdin: null, flags: {}, cwd: PathSpec.fromStrPath('/'), signal: stop.signal },
        null,
      )
      stop.abort()
      expect((await run).exitCode).toBe(1)
    } finally {
      await execution.close()
    }
  })

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
