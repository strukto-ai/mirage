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

import { expect, it, vi } from 'vitest'
import {
  clearSignals,
  createPyodideInterrupter,
  guestSignals,
  INTERRUPT_BYTES,
  sendSignal,
  signalled,
} from './interrupt.ts'
import { requestSync } from '../../wasm/transport.ts'

it('reasserts consumed deadline and abort signals until the run disarms', async () => {
  const interrupter = await createPyodideInterrupter()
  if (interrupter === null) throw new Error('test requires a worker watchdog')
  try {
    for (const kind of ['deadline', 'signal'] as const) {
      const controller = new AbortController()
      const armed = interrupter.arm(kind === 'deadline' ? 0.01 : null, controller.signal)
      if (kind === 'signal') controller.abort()
      await vi.waitFor(() => {
        expect(Atomics.load(interrupter.view, 0)).toBe(2)
      })
      // Pyodide consumes the signal even when it fails to unwind WASM.
      Atomics.store(interrupter.view, 0, 0)
      await vi.waitFor(() => {
        expect(Atomics.load(interrupter.view, 0)).toBe(2)
      })
      expect(armed.disarm()).toBe(kind)
    }
    const fresh = interrupter.arm(null)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(Atomics.load(interrupter.view, 0)).toBe(0)
    expect(fresh.disarm()).toBe(null)
  } finally {
    interrupter.close()
  }
})

it('cancels a VFS wait after Pyodide has consumed the interrupt cell', () => {
  const cells = new Int32Array(new SharedArrayBuffer(16))
  Atomics.store(cells, 1, 1)
  expect(() => requestSync(() => undefined, { op: 'stat', path: '/data/hang' }, cells)).toThrow(
    'interrupted',
  )
})

it('keeps signals above 32 apart from those below', () => {
  const cells = new Int32Array(new SharedArrayBuffer(INTERRUPT_BYTES))
  sendSignal(cells, 42)
  sendSignal(cells, 10)
  expect(signalled(cells)).toBe(true)
  const guest = guestSignals(cells)
  expect([guest.take(), guest.take(), guest.take()]).toEqual([10, 42, 0])
  sendSignal(cells, 64)
  clearSignals(cells)
  expect(signalled(cells)).toBe(false)
})
