import { describe, expect, it, vi } from 'vitest'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { WorkspaceBinding } from '../../binding.ts'
import { EvalError } from '../../errors.ts'
import { PrefixResolver } from '../../resolver.ts'
import { PyodideExecution } from './execution.ts'
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
        expect(
          new TextDecoder().decode(
            (await rt.eval('from _test_lifecycle import use; print(use())', { session: 'one' }))
              .stdout,
          ),
        ).toBe('1\n')
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
        expect((await evaluation).value).toBe(3)
        await closeAgain
        expect(module.events).toEqual([
          'install 1',
          'use 1',
          'closing 1',
          'closed 1',
          'install 2',
          'use 2',
          'closing 2',
          'closed 2',
          'install 3',
          'use 3',
          'closing 3',
          'closed 3',
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
        expect(
          new TextDecoder().decode((await rt.eval('print(ready)', { session: 'one' })).stdout),
        ).toBe('42\n')
        await expect(rt.close()).rejects.toBe(module.failure)
        expect(closeInterrupt).toHaveBeenCalledTimes(1)
        await rt.close()
        expect(module.disposals).toBe(1)
        expect(closeInterrupt).toHaveBeenCalledTimes(1)
        expect(
          new TextDecoder().decode((await rt.eval('print(ready)', { session: 'one' })).stdout),
        ).toBe('42\n')
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

  it('initializes before bootstrap and disposes after every command', async () => {
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
        expect(module.installs).toBe(i + 1)
        expect(module.disposals).toBe(i + 1)
      }
    } finally {
      await rt.close()
    }
    expect(module.disposals).toBe(2)
  }, 60_000)

  it('closes every named console when their cleanup fails', async () => {
    const ref = new URL('./fixtures/failing_cleanup.ts', import.meta.url)
    ref.searchParams.set('case', 'multiple-sessions')
    const module = (await import(ref.href)) as typeof FailingCleanup
    module.configure('async')
    const rt = new PyodideRuntime({ config: { initModule: ref.href } })
    try {
      await rt.eval('pass', { session: 'one' })
      await rt.eval('pass', { session: 'two' })
      await expect(rt.close()).rejects.toMatchObject({ errors: [module.failure, module.failure] })
      expect(module.disposals).toBe(2)
      await expect(rt.close()).resolves.toBeUndefined()
    } finally {
      await rt.close()
    }
  }, 60_000)

  it.each(['inline', 'worker'] as const)(
    'preserves evaluation and timeout errors when cleanup also fails (%s)',
    async (mode) => {
      const ref = new URL('./fixtures/failing_cleanup.ts', import.meta.url)
      ref.searchParams.set('case', `primary-${mode}`)
      const module = (await import(ref.href)) as typeof FailingCleanup
      module.configure('async')
      const rt = new PyodideRuntime({ config: { initModule: ref.href } })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      if (mode === 'worker') {
        rt.bind(
          new WorkspaceBinding(
            () => Promise.reject(new Error('unexpected filesystem operation')),
            new PrefixResolver(() => []),
          ),
        )
      }
      try {
        const evaluated = rt.eval("raise ValueError('primary failure')")
        await expect(evaluated).rejects.toBeInstanceOf(EvalError)
        await expect(evaluated).rejects.toThrow('ValueError: primary failure')
        await expect(evaluated).rejects.toMatchObject({ syntax: false })
        if (mode === 'inline')
          await expect(evaluated).rejects.toHaveProperty('cause', module.failure)
        const timedOut = rt.run({
          code: 'while True: pass',
          args: [],
          env: {},
          stdin: null,
          timeoutSeconds: 0.05,
        })
        await expect(timedOut).rejects.toBeInstanceOf(CommandTimeoutError)
        await expect(timedOut).rejects.toMatchObject({ command: 'pyodide', seconds: 0.05 })
        if (mode === 'inline')
          await expect(timedOut).rejects.toHaveProperty('cause', module.failure)
        expect(warn).toHaveBeenCalledTimes(2)
        for (const diagnostic of warn.mock.calls) {
          expect(diagnostic.map(String).join(' ')).toContain('pyodide runtime cleanup failed')
          expect(diagnostic.map(String).join(' ')).toContain('Error: cleanup failed')
        }
      } finally {
        await rt.close()
        warn.mockRestore()
      }
    },
    60_000,
  )

  it.each(['mutable', 'frozen', 'readonly'] as const)(
    'keeps the original error, stack, and prior cause (%s)',
    async (mode) => {
      const ref = new URL('./fixtures/failing_cleanup.ts', import.meta.url)
      ref.searchParams.set('case', `prior-cause-${mode}`)
      const module = (await import(ref.href)) as typeof FailingCleanup
      const prior = new Error('original cause')
      const primary = new EvalError('original traceback', { cause: prior })
      const stack = primary.stack
      if (mode === 'frozen') Object.freeze(primary)
      if (mode === 'readonly')
        Object.defineProperty(primary, 'cause', { writable: false, configurable: false })
      const evaluate = vi.spyOn(PyodideExecution.prototype, 'evaluate').mockImplementation(() => {
        throw primary
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const rt = new PyodideRuntime({ config: { initModule: ref.href } })
      try {
        await expect(rt.eval('42')).rejects.toBe(primary)
        expect(primary.stack).toBe(stack)
        if (mode !== 'mutable') expect(primary.cause).toBe(prior)
        else {
          expect(primary.cause).toBeInstanceOf(AggregateError)
          expect(primary.cause).toHaveProperty('errors', [prior, module.failure])
        }
        expect(warn).toHaveBeenCalledWith('pyodide runtime cleanup failed', module.failure)
        expect(module.disposals).toBe(1)
      } finally {
        await rt.close()
        evaluate.mockRestore()
        warn.mockRestore()
      }
    },
    60_000,
  )

  it.each(['run', 'eval'] as const)(
    'rejects cleanup-only failure after successful %s',
    async (method) => {
      const ref = new URL('./fixtures/failing_cleanup.ts', import.meta.url)
      ref.searchParams.set('case', `cleanup-only-${method}`)
      const module = (await import(ref.href)) as typeof FailingCleanup
      module.configure('async')
      const rt = new PyodideRuntime({ config: { initModule: ref.href } })
      try {
        const result =
          method === 'run'
            ? rt.run({ code: 'print(42)', args: [], env: {}, stdin: null })
            : rt.eval('42')
        await expect(result).rejects.toBe(module.failure)
        expect(module.disposals).toBe(1)
      } finally {
        await rt.close()
      }
    },
    60_000,
  )
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
