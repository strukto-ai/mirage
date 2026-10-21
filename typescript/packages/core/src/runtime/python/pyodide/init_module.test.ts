import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../../../commands/config.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { context } from '../../../../tests/workspace/fixtures/context.ts'
import { WorkspaceBinding } from '../../binding.ts'
import { PrefixResolver } from '../../resolver.ts'
import type { RunResult } from '../../types.ts'
import { PyodideExecution } from './execution.ts'
import { PyodideRuntime } from './runtime.ts'
import type * as FailingCleanup from '../../../../tests/runtime/python/pyodide/fixtures/failing_cleanup.ts'
import type * as Capability from '../../../../tests/runtime/python/pyodide/fixtures/capability.ts'

/** Run `code` at `/`; pyodide has no engine, so the run queues at the call. */
function interpret(
  rt: PyodideRuntime,
  code: string,
  stdin: Uint8Array | null = null,
  extra: Partial<Context> = {},
): Promise<RunResult> {
  return rt.interpret(undefined, { code, args: [], stdin }, context(extra))
}

describe('PyodideRuntime host initializer', () => {
  it('declares process reach only when a host initializer is configured', () => {
    expect(new PyodideRuntime().reach).toBe('workspace')
    const rt = new PyodideRuntime({ config: { initModule: 'file:///trusted/init.mjs' } })
    expect(rt.reach).toBe('process')
  })

  it('initializes before bootstrap and disposes after every command', async () => {
    const ref = new URL(
      '../../../../tests/runtime/python/pyodide/fixtures/capability.ts',
      import.meta.url,
    )
    const module = (await import(ref.href)) as typeof Capability
    const rt = new PyodideRuntime({
      config: {
        initModule: ref.href,
        bootstrapCode: 'from _test_capability import add; assert add(2, 3) == 5',
      },
    })
    try {
      for (let i = 0; i < 2; i++) {
        const result = await interpret(
          rt,
          'from _test_capability import add; print(add(3, 4))',
          new Uint8Array(),
        )
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

  it.each(['inline', 'worker'] as const)(
    'preserves a timeout error when cleanup also fails (%s)',
    async (mode) => {
      const ref = new URL(
        '../../../../tests/runtime/python/pyodide/fixtures/failing_cleanup.ts',
        import.meta.url,
      )
      ref.searchParams.set('case', `primary-${mode}`)
      const module = (await import(ref.href)) as typeof FailingCleanup
      module.configure('async')
      const rt = new PyodideRuntime({ config: { initModule: ref.href } })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      if (mode === 'worker') {
        rt.bind(
          WorkspaceBinding.overBridge(
            () => Promise.reject(new Error('unexpected filesystem operation')),
            new PrefixResolver(() => []),
          ),
        )
      }
      try {
        const timedOut = interpret(rt, 'while True: pass', null, { timeoutSeconds: 0.05 })
        await expect(timedOut).rejects.toBeInstanceOf(CommandTimeoutError)
        await expect(timedOut).rejects.toMatchObject({ command: 'pyodide', seconds: 0.05 })
        if (mode === 'inline')
          await expect(timedOut).rejects.toHaveProperty('cause', module.failure)
        expect(warn).toHaveBeenCalledTimes(1)
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
      const ref = new URL(
        '../../../../tests/runtime/python/pyodide/fixtures/failing_cleanup.ts',
        import.meta.url,
      )
      ref.searchParams.set('case', `prior-cause-${mode}`)
      const module = (await import(ref.href)) as typeof FailingCleanup
      const prior = new Error('original cause')
      const primary = new Error('original traceback', { cause: prior })
      const stack = primary.stack
      if (mode === 'frozen') Object.freeze(primary)
      if (mode === 'readonly')
        Object.defineProperty(primary, 'cause', { writable: false, configurable: false })
      const execute = vi.spyOn(PyodideExecution.prototype, 'run').mockImplementation(() => {
        throw primary
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const rt = new PyodideRuntime({ config: { initModule: ref.href } })
      try {
        await expect(interpret(rt, '42')).rejects.toBe(primary)
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
        execute.mockRestore()
        warn.mockRestore()
      }
    },
    60_000,
  )

  it('rejects cleanup-only failure after a successful run', async () => {
    const ref = new URL(
      '../../../../tests/runtime/python/pyodide/fixtures/failing_cleanup.ts',
      import.meta.url,
    )
    ref.searchParams.set('case', 'cleanup-only-run')
    const module = (await import(ref.href)) as typeof FailingCleanup
    module.configure('async')
    const rt = new PyodideRuntime({ config: { initModule: ref.href } })
    try {
      const result = interpret(rt, 'print(42)')
      await expect(result).rejects.toBe(module.failure)
      expect(module.disposals).toBe(1)
    } finally {
      await rt.close()
    }
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
