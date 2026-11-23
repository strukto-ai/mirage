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
import { ProcessTable } from '../execution/process/table.ts'
import { recordStatus } from './executor/statement.ts'
import { armSignals } from './executor/traps.ts'
import { SessionState } from './session/session.ts'
import {
  callerSignal,
  currentCaller,
  lineSignal,
  bindCaller,
  setCurrentEvaluation,
} from '../context/session_context.ts'
import { EvaluationContext } from './evaluation.ts'
import { MountMode, PathSpec } from '../types.ts'
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
    const seen = await runWithLineAbort(abort.signal, [a], Symbol('line'), () =>
      bindCaller({ ...currentCaller(), writeHeld: true }, () => Promise.resolve(lineSignal(a))),
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
    const lineA = runWithLineAbort(new AbortController().signal, [a], Symbol('line'), async () => {
      await holdA
      recordStatus(a, 3)
      releaseB()
    })
    const lineB = runWithLineAbort(abortB.signal, [b], Symbol('line'), async () => {
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
  it('leaves an expansion its own line to answer to', async () => {
    // The job is newest and shares the shell's id, so only the evaluation
    // an expansion names tells whose signal it is.
    const line = new SessionState({ sessionId: 's', cwd: '/' })
    const job = new SessionState({ sessionId: 's', cwd: '/' })
    const lineAbort = new AbortController()
    const jobAbort = new AbortController()
    const evaluation = new EvaluationContext(line)
    const jobEvaluation = new EvaluationContext(job)
    jobEvaluation.frame.abortSignal = jobAbort.signal
    await runWithLineAbort(lineAbort.signal, [line], Symbol('line'), () =>
      setCurrentEvaluation(evaluation, () =>
        runWithLineAbort(jobAbort.signal, [job], Symbol('line'), () =>
          setCurrentEvaluation(jobEvaluation, () => {
            expect(callerSignal()).toBeUndefined()
            expect(callerSignal(evaluation)).toBe(lineAbort.signal)
            expect(callerSignal(jobEvaluation)).toBe(jobAbort.signal)
            return Promise.resolve()
          }),
        ),
      ),
    )
  })

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

  it('arms only the process its frame names', async () => {
    // A pid names no workspace: without the frame's shell a shell arms nothing,
    // whatever process sits in the slot or shares its pid.
    const init = {
      sessionId: 'a',
      command: 'sh',
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => undefined,
      run: () => new Promise<number>(() => undefined),
    }
    const own = new ProcessTable().start(init)
    const foreign = new ProcessTable().start(init)
    expect(foreign.record.id.pid).toBe(own.record.id.pid)
    const session = new SessionState({ sessionId: 'a', cwd: '/' })
    session.exitTrap = 'echo bye'
    await bindCaller({ ...currentCaller(), process: foreign }, () => {
      armSignals(session)
      session.processId = own.record.id.pid
      armSignals(session)
      armSignals(session, own)
      return Promise.resolve()
    })
    expect(foreign.exitCatcher).toBeNull()
    expect(own.exitCatcher).not.toBeNull()
  })

  it('arms a nested shell its own traps', async () => {
    // Pinned on bash 5.2: each nested shell answers the signal it sends itself.
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const io = await ws.shell(
        `bash -c 'trap "echo caught" TERM; kill $$; echo after'; echo rc=$?; ` +
          `( trap 'echo c' TERM; kill $BASHPID; echo after ); echo rc=$?; ` +
          `timeout 5 bash -c 'trap "echo t" TERM; kill $$; echo after'; echo rc=$?; ` +
          `bash -c 'trap "echo bye" EXIT; kill $$; echo after' 2>/dev/null; echo rc=$?; ` +
          `( trap 'echo sub' EXIT; kill $BASHPID; echo after ) 2>/dev/null; echo rc=$?`,
      )
      expect(new TextDecoder().decode(io.stdout)).toBe(
        'caught\nafter\nrc=0\nc\nafter\nrc=0\nt\nafter\nrc=0\nbye\nrc=143\nsub\nrc=143\n',
      )
    } finally {
      await ws.close()
    }
  })

  it('answers its own signals while another workspace runs beside it', async () => {
    // Both lines run under the same pid, each in its own table; the shell that
    // ignores TERM must arm its own process, not the other workspace's.
    const a = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const b = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const running = a.shell('sleep 0.3; echo a')
      const io = await b.shell("trap '' TERM; kill $$; echo survived")
      expect(new TextDecoder().decode(io.stdout)).toBe('survived\n')
      expect(new TextDecoder().decode((await running).stdout)).toBe('a\n')
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('runs its EXIT action when a signal ends it', async () => {
    // The line's frames are the newest while the job sets its action; armed on
    // the line's process, the job would end of the signal without it.
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const io = await ws.shell(
        "{ trap 'echo ran > /data/l' EXIT; echo ready > /data/r; sleep 30; } & v=$!; " +
          'while ! test -e /data/r; do sleep .01; done; kill $v; wait $v 2>/dev/null; ' +
          'test -e /data/l; echo present:$?',
      )
      expect(io.exitCode).toBe(0)
      expect(new TextDecoder().decode(io.stdout)).toBe('present:0\n')
    } finally {
      await ws.close()
    }
  })
})
