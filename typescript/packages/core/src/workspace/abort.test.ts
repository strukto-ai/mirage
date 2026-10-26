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
import { IOResult } from '../io/types.ts'
import { YIELD_CALLS } from '../io/yield_budget.ts'
import type { DispatchFn } from '../runtime/types.ts'
import { PathSpec } from '../types.ts'
import { guardDispatch } from './abort.ts'

describe('guardDispatch', () => {
  const path = PathSpec.fromStrPath('/x')

  function recording(seen: string[]): DispatchFn {
    return (op) => {
      seen.push(op)
      return Promise.resolve([null, new IOResult()])
    }
  }

  it('forwards an op while the signal is quiet', async () => {
    const seen: string[] = []
    const guarded = guardDispatch(recording(seen), new AbortController().signal)
    await guarded('stat', path)
    expect(seen).toEqual(['stat'])
  })

  it('refuses to start an op once the signal fired', async () => {
    const seen: string[] = []
    const controller = new AbortController()
    const guarded = guardDispatch(recording(seen), controller.signal)
    controller.abort(new Error('released'))
    await expect(guarded('unlink', path)).rejects.toMatchObject({
      name: 'AbortError',
      cause: { message: 'released' },
    })
    expect(seen).toEqual([])
  })

  it.each([false, true])(
    'hands a timer a turn in a run of microtask ops, signal %s, and stops there',
    async (withSignal) => {
      const seen: string[] = []
      const controller = new AbortController()
      const guarded = guardDispatch(recording(seen), withSignal ? controller.signal : undefined)
      let fired = false
      setTimeout(() => {
        fired = true
        controller.abort(new Error('released'))
      }, 0)
      // Due before the run starts: an immediate yield goes on before the loop
      // reaches its timers, so a due timer runs at the second yield.
      const due = performance.now() + 2
      while (performance.now() < due) continue
      const run = async (): Promise<void> => {
        while (!fired) await guarded('stat', path)
        await guarded('stat', path)
      }
      if (withSignal) await expect(run()).rejects.toMatchObject({ name: 'AbortError' })
      else await run()
      expect(fired).toBe(true)
      expect(seen.length).toBeLessThanOrEqual(2 * YIELD_CALLS + 1)
    },
  )
})
