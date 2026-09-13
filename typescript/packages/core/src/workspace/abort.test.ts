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
import type { DispatchFn } from '../runtime/types.ts'
import { PathSpec } from '../types.ts'
import { abortable, guardDispatch, joinOrAbort, makeAbortError } from './abort.ts'

function never(): Promise<never> {
  return new Promise<never>(() => undefined)
}

describe('abortable', () => {
  it('settles with the promise when the signal stays quiet', async () => {
    await expect(abortable(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7)
  })

  it('keeps a listener on a promise it abandons to an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const late = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('settled after the caller left'))
      }, 10)
    })
    await expect(abortable(late, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    // Vitest reports an unhandled rejection as a run error; this wait gives it the chance.
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
  })

  it('rejects as an abort as soon as the signal fires', async () => {
    const controller = new AbortController()
    const pending = abortable(never(), controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('joinOrAbort', () => {
  it('lets a responsive tree report its own error within the grace', async () => {
    const controller = new AbortController()
    const reason = new Error('caller stopped the run')
    const tree = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        setTimeout(() => {
          reject(reason)
        }, 20)
      })
    })
    const pending = joinOrAbort(tree, controller.signal, 200)
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('takes a tree that finishes inside the grace as its result', async () => {
    const controller = new AbortController()
    const tree = new Promise<string>((resolve) => {
      controller.signal.addEventListener('abort', () => {
        setTimeout(() => {
          resolve('done')
        }, 20)
      })
    })
    const pending = joinOrAbort(tree, controller.signal, 200)
    controller.abort()
    await expect(pending).resolves.toBe('done')
  })

  it('releases the caller once a stalled tree outlives the grace', async () => {
    const controller = new AbortController()
    const t0 = Date.now()
    const pending = joinOrAbort(never(), controller.signal, 30)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe('makeAbortError', () => {
  it('carries the reason as the cause for a plain abort() too', () => {
    const controller = new AbortController()
    controller.abort()
    const error = makeAbortError(controller.signal)
    expect(error.name).toBe('AbortError')
    expect(error).not.toBe(controller.signal.reason)
    expect((error as { cause?: unknown }).cause).toBe(controller.signal.reason)
  })

  it('carries a custom reason as the cause', () => {
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    const error = makeAbortError(controller.signal)
    expect(error.name).toBe('AbortError')
    expect((error as { cause?: unknown }).cause).toBe(controller.signal.reason)
  })
})

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

  it('is the dispatch itself without a signal', () => {
    const seen: string[] = []
    const inner = recording(seen)
    expect(guardDispatch(inner, undefined)).toBe(inner)
  })
})
