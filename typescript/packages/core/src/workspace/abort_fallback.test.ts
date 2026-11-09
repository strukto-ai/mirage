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
import { SessionState } from './session/session.ts'
import { newStatusWriter } from './abort.ts'
import { currentCaller, lineSignal, runWithCaller } from '../context/session_context.ts'
import { MountMode } from '../types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Workspace } from './workspace/workspace.ts'

// The browser-runtime branch under node's test runner: the mock forces
// the real FallbackStorage (no task isolation, one frame stack per
// storage), so this pins what the status write does where the newest
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

describe('the status write on the fallback storage', () => {
  it("a line's own layers count as one line", async () => {
    // Each layer below the line copies its frame; counted per layer, the
    // line would read as two and its reads lose the signal.
    const a = new SessionState({ sessionId: 'a', cwd: '/' })
    const abort = new AbortController()
    const seen = await runWithLineAbort(abort.signal, [a], newStatusWriter(), () =>
      runWithCaller({ ...currentCaller(), writeHeld: true }, () => Promise.resolve(lineSignal(a))),
    )
    expect(seen).toBe(abort.signal)
  })

  it('an aborted line does not reach a concurrent line on another session', async () => {
    // B binds after A and aborts; while B's frame is the newest, A stamps.
    // The slot would answer A with B's signal and make A throw B's abort.
    const a = new SessionState({ sessionId: 'a', cwd: '/' })
    const b = new SessionState({ sessionId: 'b', cwd: '/' })
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

describe('a nested line on the fallback storage', () => {
  it.each(["eval 'x=${X//+(?)/x}; touched=yes'", 'f() { x=${X//+(?)/x}; touched=yes; }; f'])(
    "answers to the typed line's signal: %s",
    async (line) => {
      const ws = new Workspace({}, { maxEnv: null })
      const controller = new AbortController()
      let work: ReturnType<typeof ws.shell> | undefined
      try {
        await ws.shell('shopt -s extglob')
        work = ws.shell(line, { signal: controller.signal, env: { X: 'a'.repeat(2_000_000) } })
        const aborted = expect(work).rejects.toMatchObject({ name: 'AbortError' })
        setTimeout(() => {
          controller.abort()
        }, 0)
        await aborted
        const peer = await ws.shell('printf "%s\\n" "${touched-unset}"')
        expect(new TextDecoder().decode(peer.stdout)).toBe('unset\n')
      } finally {
        controller.abort()
        await work?.catch(() => undefined)
        await ws.close()
      }
    },
  )
})

describe('a per-call line on the fallback storage', () => {
  it('keeps its status when a line waiting on the session is aborted', async () => {
    // The waiting line's frame is the only live one on the session when
    // the per-call line stamps; borrowing its identity would let its
    // abort put back the status it found over the per-call line's.
    const ws = new Workspace({})
    const abort = new AbortController()
    const [reading, read] = gate()
    const [held, release] = gate()
    async function* stdin(): AsyncGenerator<Uint8Array> {
      read()
      await held
      yield new TextEncoder().encode('go\n')
    }
    try {
      const waiting = ws.shell('read x', { stdin: stdin(), signal: abort.signal })
      const aborted = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
      await reading
      await ws.shell('false', { cwd: '/' })
      abort.abort()
      await aborted
      expect(ws.sessionManager.get(ws.sessionManager.defaultId).lastExitCode).toBe(1)
    } finally {
      release()
      await ws.close()
    }
  })
})

describe('a job on the fallback storage', () => {
  it('is killed alone while its EXIT action runs', async () => {
    // The killed job's frames are the newest while the line expands its next
    // words; read as the line's own, its signal would end the line.
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const io = await ws.shell(
        "{ trap 'echo ready > /data/r; sleep 30; echo late > /data/l' EXIT; true; } & v=$!; " +
          'while ! test -e /data/r; do sleep .01; done; kill $v; wait $v 2>/dev/null; ' +
          'test -e /data/l; echo present:$?',
      )
      expect(io.exitCode).toBe(0)
      expect(new TextDecoder().decode(io.stdout)).toBe('present:1\n')
    } finally {
      await ws.close()
    }
  })
})
