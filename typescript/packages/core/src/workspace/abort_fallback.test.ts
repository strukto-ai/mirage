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
import type * as asyncContextModule from '../utils/async_context.ts'
import { runWithLineAbort } from './abort.ts'
import { recordStatus } from './executor/statement.ts'
import { Session, newStatusWriter } from './session/session.ts'

// The browser-runtime branch under node's test runner: the mock forces
// the real FallbackStorage (no task isolation, one frame stack per
// storage), so this pins what the status door does where the newest
// frame can belong to another line.
vi.mock('../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return {
    ...real,
    asyncContextIsolatesTasks: false,
    createAsyncContext<T>() {
      return new real.FallbackStorage<T>()
    },
  }
})

/** A promise released by hand, for holding one run live inside another. */
function gate(): [Promise<void>, () => void] {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return [held, release]
}

describe('the status door on the fallback storage', () => {
  it('an aborted line does not reach a concurrent line on another session', async () => {
    // B binds after A and aborts; while B's frame is the newest, A stamps.
    // The slot would answer A with B's signal and make A throw B's abort.
    const a = new Session({ sessionId: 'a', cwd: '/' })
    const b = new Session({ sessionId: 'b', cwd: '/' })
    const abortB = new AbortController()
    const [holdA, releaseA] = gate()
    const [holdB, releaseB] = gate()
    let refusedB: unknown = null
    const lineA = runWithLineAbort(
      new AbortController().signal,
      [a],
      newStatusWriter(),
      async () => {
        await holdA
        recordStatus(a, 3)
        releaseB()
      },
    )
    const lineB = runWithLineAbort(abortB.signal, [b], newStatusWriter(), async () => {
      abortB.abort()
      releaseA()
      await holdB
      try {
        recordStatus(b, 0)
      } catch (err) {
        refusedB = err
      }
    })
    await Promise.all([lineA, lineB])
    expect(a.lastExitCode).toBe(3)
    expect(refusedB).toMatchObject({ name: 'AbortError' })
    expect(b.lastExitCode).toBe(0)
  })
})
