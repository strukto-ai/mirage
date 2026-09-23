import { describe, expect, it, vi } from 'vitest'
import { PyodideRuntime } from './runtime.ts'
import * as interrupt from './interrupt.ts'
import type * as PendingCleanup from './fixtures/pending_cleanup.ts'
import type * as FailingCleanup from './fixtures/failing_cleanup.ts'
import type * as Capability from './fixtures/capability.ts'

describe('PyodideRuntime host initializer', () => {
  it('declares process reach only when a host initializer is configured', () => {
    expect(new PyodideRuntime().capabilities.reach).toBe('workspace')
    const rt = new PyodideRuntime({ config: { initModule: 'file:///trusted/init.mjs' } })
    expect(rt.reach).toBe('process')
    expect(rt.capabilities.reach).toBe('process')
  })

  it.each([false, true])(
    'queues execution and another close behind pending cleanup (rejects: %s)',
    async (rejects) => {
      const ref = new URL('./fixtures/pending_cleanup.ts', import.meta.url)
      ref.searchParams.set('case', String(rejects))
      const module = (await import(ref.href)) as typeof PendingCleanup
      module.configure(rejects)
      const rt = new PyodideRuntime({
        config: { initModule: ref.href, autoLoadFromImports: false },
      })
      const pending: Promise<unknown>[] = []
      try {
        expect((await rt.eval('from _test_lifecycle import use; use()')).value).toBe(1)
        const closing = rt.close()
        const closed = rejects
          ? expect(closing).rejects.toBe(module.failure)
          : expect(closing).resolves.toBeUndefined()
        pending.push(closed)
        await module.entered
        const run = rt.run({
          code: 'from _test_lifecycle import use; print(use())',
          args: [],
          env: {},
          stdin: null,
        })
        const evaluation = rt.eval('from _test_lifecycle import use; use()')
        const closeAgain = rt.close()
        pending.push(run, evaluation, closeAgain)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(module.events).toEqual(['install 1', 'use 1', 'closing 1'])
        module.release()
        await closed
        const result = await run
        expect(result.exitCode).toBe(0)
        expect(new TextDecoder().decode(result.stdout)).toBe('2\n')
        expect((await evaluation).value).toBe(2)
        await closeAgain
        expect(module.events).toEqual([
          'install 1',
          'use 1',
          'closing 1',
          'closed 1',
          'install 2',
          'use 2',
          'use 2',
          'closing 2',
          'closed 2',
        ])
      } finally {
        module.release()
        await Promise.allSettled(pending)
        await rt.close()
      }
    },
    60_000,
  )

  it.each(['sync', 'async'] as const)(
    'finishes teardown after %s cleanup fails',
    async (kind) => {
      const ref = new URL('./fixtures/failing_cleanup.ts', import.meta.url)
      ref.searchParams.set('case', kind)
      const module = (await import(ref.href)) as typeof FailingCleanup
      module.configure(kind)
      const closeInterrupt = vi.fn()
      const factory = vi.spyOn(interrupt, 'createPyodideInterrupter').mockResolvedValue({
        view: new Int32Array(new SharedArrayBuffer(16)),
        arm: () => ({ disarm: () => null }),
        close: closeInterrupt,
      })
      const rt = new PyodideRuntime({
        config: { initModule: ref.href, bootstrapCode: 'import builtins; builtins.ready = 42' },
      })
      try {
        expect((await rt.eval('ready')).value).toBe(42)
        await expect(rt.close()).rejects.toBe(module.failure)
        expect(closeInterrupt).toHaveBeenCalledTimes(1)
        await rt.close()
        expect(module.disposals).toBe(1)
        expect(closeInterrupt).toHaveBeenCalledTimes(1)
        expect((await rt.eval('ready')).value).toBe(42)
        expect(module.installs).toBe(2)
        await expect(rt.close()).rejects.toBe(module.failure)
        expect(module.disposals).toBe(2)
        expect(closeInterrupt).toHaveBeenCalledTimes(2)
      } finally {
        factory.mockRestore()
        try {
          await rt.close()
        } catch (error) {
          expect(error).toBe(module.failure)
        }
      }
    },
    60_000,
  )

  it('initializes once before bootstrap and disposes with the runtime', async () => {
    const ref = new URL('./fixtures/capability.ts', import.meta.url)
    const module = (await import(ref.href)) as typeof Capability
    const rt = new PyodideRuntime({
      config: {
        initModule: ref.href,
        bootstrapCode: 'from _test_capability import add; assert add(2, 3) == 5',
      },
    })
    try {
      for (let i = 0; i < 2; i++) {
        const result = await rt.run({
          code: 'from _test_capability import add; print(add(3, 4))',
          args: [],
          env: {},
          stdin: new Uint8Array(),
        })
        expect(result.exitCode).toBe(0)
        expect(new TextDecoder().decode(result.stdout)).toBe('7\n')
      }
      expect(module.installs).toBe(1)
    } finally {
      await rt.close()
    }
    expect(module.disposals).toBe(1)
  }, 60_000)
})

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
