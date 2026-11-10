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
import { IOResult } from '../../io/types.ts'
import { ExecutionNode } from '../../workspace/types.ts'
import {
  Channel,
  type ConsoleChunk,
  type ConsoleStore,
  JobConsole,
  RAMConsoleStore,
  type ReadResult,
} from '../../shell/console/index.ts'
import {
  LIST_CHECK_SECONDS,
  PUBLISH_SECONDS,
  STOP_WAIT_SECONDS,
  WATCH_RETRY_SECONDS,
} from './constants.ts'
import { WorkspaceHeldError } from '../errors.ts'
import { LineId } from '../types.ts'
import { RAMExecutionStore } from '../ram.ts'
import { ProcessTable } from '../process/table.ts'
import { PathSpec } from '../../types.ts'
import { JobTable } from './table.ts'
import { JobHandle, type JobResult, type JobRunner } from './handle.ts'
import { ManualClock } from '../../utils/clock.ts'
import { generationOf, type RecordFields } from '../../workspace/record/types.ts'
import { FIRST_PID } from '../process/constants.ts'

const dec = (b: Uint8Array | undefined): string =>
  b === undefined ? '' : new TextDecoder().decode(b)

/** A runner that finishes immediately with no output. */
const quiet: JobRunner = () => Promise.resolve([new IOResult(), new ExecutionNode()] as JobResult)

/** A runner that prints, then exits with the given code. */
function talking(text: string, exitCode = 0): JobRunner {
  return async (job) => {
    await job.console.emit(Channel.STDOUT, new TextEncoder().encode(text))
    return [new IOResult({ exitCode }), new ExecutionNode({ command: text, exitCode })]
  }
}

/**
 * A runner that never observes the abort signal, like a long command
 * that does not check it. Only `release.fire()` ends it.
 */
function deaf(release: { fire?: () => void }): JobRunner {
  return async () => {
    await new Promise<void>((resolve) => {
      release.fire = resolve
    })
    return [new IOResult(), new ExecutionNode()] as JobResult
  }
}

/**
 * A store whose appends park until the test opens the gate. Stands in
 * for a store that genuinely suspends: the window between a job's
 * status flipping and its final chunks landing becomes arbitrarily
 * wide.
 */
class GatedStore implements ConsoleStore {
  private readonly inner = new RAMConsoleStore()

  constructor(private readonly gate: Promise<void>) {}

  async append(channel: Channel, data: Uint8Array): Promise<ConsoleChunk> {
    await this.gate
    return this.inner.append(channel, data)
  }

  async readFrom(seq: number, limit?: number): Promise<ReadResult> {
    return this.inner.readFrom(seq, limit)
  }

  get closed(): boolean {
    return this.inner.closed
  }

  async wait(seq: number): Promise<void> {
    return this.inner.wait(seq)
  }

  async waitEnded(): Promise<void> {
    return this.inner.waitEnded()
  }

  async close(): Promise<void> {
    return this.inner.close()
  }
}

/** A job store whose consoles park their appends behind the gate. */
class GatedJobs extends RAMExecutionStore {
  constructor(private readonly gate: Promise<void>) {
    super()
  }

  override console(): ConsoleStore {
    return new GatedStore(this.gate)
  }
}

/** A job store that cannot open a console. */
class BrokenConsoles extends RAMExecutionStore {
  override console(): ConsoleStore {
    throw new Error('console unavailable')
  }
}

/** A live job whose console appends are parked behind the gate. */
async function gatedJob(gate: Promise<void>): Promise<[JobTable, JobHandle]> {
  const jt = new JobTable(new GatedJobs(gate))
  const abort = new AbortController()
  return [jt, await jt.submit({ command: 'deaf', run: pending(abort), abort, cwd: '/' })]
}

/** A runner that never finishes on its own; only an abort ends it. */
function pending(abort: AbortController, prelude?: string): JobRunner {
  return async (job) => {
    if (prelude !== undefined) {
      await job.console.emit(Channel.STDOUT, new TextEncoder().encode(prelude))
    }
    await new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
    throw new Error('unreachable')
  }
}

/** A process body that runs until it is stopped. */
function abortable(command: string): {
  sessionId: string
  command: string
  cwd: PathSpec
  cancel: () => void
  run: () => Promise<number>
} {
  const abort = new AbortController()
  return {
    sessionId: 's',
    command,
    cwd: PathSpec.fromStrPath('/'),
    cancel: () => {
      abort.abort()
    },
    run: () =>
      new Promise<number>((_resolve, reject) => {
        abort.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      }),
  }
}

/** A published process that ran a program on `machine`. */
function ran(pid: number, machine = 'docker:t'): Record<string, unknown> {
  return { pid, session: 's', machine, runtime: 'x' }
}

describe('JobTable.submit', () => {
  it('assigns incrementing ids starting at 1', async () => {
    const jt = new JobTable()
    const j1 = await jt.submit({ command: 'a', run: quiet, abort: new AbortController(), cwd: '/' })
    const j2 = await jt.submit({ command: 'b', run: quiet, abort: new AbortController(), cwd: '/' })
    expect(j1.id).toBe(1)
    expect(j2.id).toBe(2)
  })

  it('stamps jobs on the table clock, a child table included', async () => {
    const clock = new ManualClock(1_000)
    const jt = new JobTable(null, undefined, null, clock)
    const first = await jt.submit({
      command: 'a',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    clock.advance(5)
    const second = await jt
      .child()
      .submit({ command: 'b', run: quiet, abort: new AbortController(), cwd: '/' })
    expect([first.createdAt, second.createdAt]).toEqual([1_000, 1_005])
  })

  it('defaults sessionId', async () => {
    const jt = new JobTable()
    const j = await jt.submit({ command: 'a', run: quiet, abort: new AbortController(), cwd: '/' })
    expect(j.sessionId).toBe('')
    expect(j.state).toBe('running')
  })

  it('hands the runner a job that already has a console', async () => {
    const jt = new JobTable()
    const j = await jt.submit({
      command: 'echo hi',
      run: talking('hi'),
      abort: new AbortController(),
      cwd: '/',
    })
    await jt.wait(j.id)
    expect(dec(await j.console.snapshot(Channel.STDOUT))).toBe('hi')
  })
})

describe('JobTable.get / list / running', () => {
  it('retrieves and lists jobs', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const j = await jt.submit({ command: 'a', run: pending(abort), abort, cwd: '/' })
    expect(jt.get(j.id)).toBe(j)
    expect(jt.get(999)).toBeNull()
    expect(jt.listJobs()).toHaveLength(1)
    expect(jt.runningJobs()).toHaveLength(1)
  })
})

describe('JobTable.kill', () => {
  // kill %N with a signal records bash's status for it: 128 plus the signal.
  it.each([
    [9, 137],
    [15, 143],
    [1, 129],
  ])('a job killed with signal %i exits %i', async (signal, code) => {
    const jt = new JobTable()
    const abort = new AbortController()
    const j = await jt.submit({ command: 'sleep', run: pending(abort, 'up'), abort, cwd: '/' })
    while (dec(await j.console.snapshot(Channel.STDOUT)) === '') await Promise.resolve()
    expect(await jt.kill(j.id, '', signal)).toBe(true)
    expect(j.signal).not.toBeNull()
    expect(j.exitCode).toBe(code)
    expect((await j.process?.join())?.exit).toBe(code)
  })

  // bash's `wait` returns once a killed child has gone, with the status it
  // exited with when it handled the signal; a compound job is a shell the
  // signal ends. The status is the job's once its runner ends, so a
  // snapshot taken before any `wait` keeps it too.
  it.each([
    [true, 3],
    [false, 143],
  ])('wait joins a killed job (simple %s) and answers %i', async (simple, code) => {
    const jt = new JobTable()
    const abort = new AbortController()
    const stopped: string[] = []
    let started = (): void => undefined
    const up = new Promise<void>((resolve) => {
      started = resolve
    })
    const run: JobRunner = (job) =>
      new Promise((_resolve, reject) => {
        started()
        abort.signal.addEventListener('abort', () => {
          setTimeout(() => {
            job.process?.programExited(3)
            stopped.push('handled')
            reject(new DOMException('aborted', 'AbortError'))
          }, 50)
        })
      })
    const j = await jt.submit({ command: 'prog', run, abort, cwd: '/', simple })
    await up
    expect(await jt.kill(j.id, '', 15)).toBe(true)
    expect([j.exitCode, stopped]).toEqual([143, []])
    await j.process?.join()
    expect([j.exitCode, stopped]).toEqual([code, ['handled']])
    expect((await jt.wait(j.id)).exitCode).toBe(code)
  })

  it('wait answers the kill once a runner outlasts the bound', async () => {
    vi.useFakeTimers()
    try {
      const jt = new JobTable()
      const abort = new AbortController()
      let started = (): void => undefined
      const up = new Promise<void>((resolve) => {
        started = resolve
      })
      const run: JobRunner = () =>
        new Promise(() => {
          started()
        })
      const j = await jt.submit({ command: 'deaf', run, abort, cwd: '/', simple: true })
      await up
      expect(await jt.kill(j.id, '', 15)).toBe(true)
      const waiting = jt.wait(j.id)
      // The console ends at the stop's bound, and wait joins the runner
      // for one more before it answers.
      await vi.advanceTimersByTimeAsync(STOP_WAIT_SECONDS * 1000 * 2)
      expect((await waiting).exitCode).toBe(143)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts, marks killed, and keeps output produced before the kill', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const j = await jt.submit({ command: 'sleep', run: pending(abort, 'partial'), abort, cwd: '/' })
    while (dec(await j.console.snapshot(Channel.STDOUT)) === '') await Promise.resolve()

    expect(await jt.kill(j.id)).toBe(true)

    expect(j.signal).not.toBeNull()
    expect(j.exitCode).toBe(137)
    expect(dec(await j.console.snapshot(Channel.STDOUT))).toBe('partial')
    expect(dec(await j.console.snapshot(Channel.STDERR))).toBe('Killed')
    expect(abort.signal.aborted).toBe(true)
  })

  it('answers killed at once and ends the console once the runner stops', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const j = await jt.submit({ command: 'sleep', run: pending(abort), abort, cwd: '/' })
    expect(await jt.kill(j.id)).toBe(true)
    expect(j.signal).not.toBeNull()
    await j.process?.join()
    expect(j.console.finished).toBe(true)
  })

  it('answers killed without joining a runner that never observes the abort', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const release: { fire?: () => void } = {}
    const j = await jt.submit({ command: 'long', run: deaf(release), abort, cwd: '/' })

    // The signal is only seen where someone checks it. Joining the runner
    // here would hang the shell on exactly the runaway job being stopped.
    expect(await jt.kill(j.id)).toBe(true)

    expect(j.signal).not.toBeNull()
    expect(j.exitCode).toBe(137)
    expect(j.console.finished).toBe(false)

    // The runner finishing afterwards must not relabel the job.
    release.fire?.()
    await j.process?.join()
    expect(j.signal).not.toBeNull()
    expect(j.exitCode).toBe(137)
    expect(await j.console.outcome()).toBe('killed:137:9')
  })

  it('returns false for unknown and already-finished jobs', async () => {
    const jt = new JobTable()
    const j = await jt.submit({ command: 'a', run: quiet, abort: new AbortController(), cwd: '/' })
    await jt.wait(j.id)
    expect(await jt.kill(j.id)).toBe(false)
    expect(await jt.kill(999)).toBe(false)
  })

  it('killAll stops every running job', async () => {
    const jt = new JobTable()
    const a1 = new AbortController()
    const a2 = new AbortController()
    await jt.submit({ command: 'a', run: pending(a1), abort: a1, cwd: '/' })
    await jt.submit({ command: 'b', run: pending(a2), abort: a2, cwd: '/' })
    const killed = await jt.killAll()
    expect(killed).toHaveLength(2)
    expect(jt.runningJobs()).toHaveLength(0)
  })
})

describe('JobTable.wait', () => {
  it('settles status, exit code, and output', async () => {
    const jt = new JobTable()
    const execNode = new ExecutionNode({ command: 'foo', exitCode: 2 })
    const run: JobRunner = async (job) => {
      await job.console.emit(Channel.STDOUT, new TextEncoder().encode('hi'))
      await job.console.emit(Channel.STDERR, new TextEncoder().encode('oops'))
      return [new IOResult({ exitCode: 2 }), execNode]
    }
    const j = await jt.submit({ command: 'foo', run, abort: new AbortController(), cwd: '/' })
    const result = await jt.wait(j.id)
    expect([result.state, result.signal]).toEqual(['exited', null])
    expect(result.exitCode).toBe(2)
    expect(dec(await result.console.snapshot(Channel.STDOUT))).toBe('hi')
    expect(dec(await result.console.snapshot(Channel.STDERR))).toBe('oops')
  })

  it('returns an already-completed job without re-awaiting', async () => {
    const jt = new JobTable()
    const j = new JobHandle({ id: 99, command: 'a', cwd: '/', createdAt: 0 })
    j.state = 'exited'
    await jt.load(j)
    const result = await jt.wait(99)
    expect(result).toBe(j)
  })

  it('sets COMPLETED and exitCode 1 on a runner error', async () => {
    const jt = new JobTable()
    const run: JobRunner = () => Promise.reject(new Error('boom'))
    const j = await jt.submit({ command: 'a', run, abort: new AbortController(), cwd: '/' })
    const result = await jt.wait(j.id)
    expect([result.state, result.signal]).toEqual(['exited', null])
    expect(result.exitCode).toBe(1)
    expect(dec(await result.console.snapshot(Channel.STDERR))).toBe('boom')
  })

  it('throws on unknown id', async () => {
    const jt = new JobTable()
    await expect(jt.wait(99)).rejects.toThrow(/unknown job/)
  })
})

// A job started here and one restored from a snapshot are both named
// `job_` and 32 hex digits, the id every caller sees.
describe('JobTable job names', () => {
  it('names a started and a restored job job_ and hex', async () => {
    const jt = new JobTable()
    const started = await jt.submit({
      command: 'a',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    const restored = new JobHandle({ id: 7, command: 'x', cwd: '/', createdAt: 0 })
    restored.state = 'exited'
    await jt.load(restored)
    const names = [started.record.id.console, restored.record.id.console]
    for (const name of names) expect(name).toMatch(/^job_[0-9a-f]{32}$/)
    expect(names[0]).not.toBe(names[1])
    await jt.killAll()
  })
})

// A job whose program ended on a signal no kill sent lists by that signal,
// as bash's jobs does; its output gains no kill marker.
describe('JobTable signal-ended jobs', () => {
  it('records the signal its program ended on', async () => {
    const jt = new JobTable()
    const job = await jt.submit({
      command: 'train',
      run: (handle) => {
        handle.process?.programSignaled(1)
        return Promise.resolve([new IOResult({ exitCode: 129 }), new ExecutionNode()] as JobResult)
      },
      abort: new AbortController(),
      cwd: '/',
    })
    const waited = await jt.wait(job.id)
    expect([waited.exitCode, job.signal]).toEqual([129, 1])
    expect(dec(await waited.console.snapshot(Channel.STDERR))).toBe('')
  })
})

// Port of tests/shell/test_background_jobs.py::test_wait_all_survives_failing_task.
describe('JobTable.wait ordering', () => {
  it('joins a kill that is still appending its marker', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const [jt, job] = await gatedJob(gate)
    const killP = jt.kill(job.id)
    // kill's synchronous prefix has already flipped the status; the
    // marker appends are parked behind the gate.
    expect(job.signal).not.toBeNull()
    let settled = false
    const waiter = jt.wait(job.id).then((j) => {
      settled = true
      return j
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // A wait that trusted the status field would have resolved here and
    // let the caller snapshot without the marker.
    expect(settled).toBe(false)
    open()
    await killP
    const waited = await waiter
    expect(dec(await waited.console.snapshot(Channel.STDERR))).toBe('Killed')
  })

  it('waitAll joins a killed job that is still appending its marker', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const [jt, job] = await gatedJob(gate)
    const killP = jt.kill(job.id)
    expect(job.signal).not.toBeNull()
    let settled = false
    const allP = jt.waitAll().then((jobs) => {
      settled = true
      return jobs
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    open()
    await killP
    await allP
    expect(dec(await job.console.snapshot(Channel.STDERR))).toBe('Killed')
  })
})

describe('JobTable.waitAll', () => {
  it('survives a failing task — mixed success/failure both land in the table', async () => {
    const jt = new JobTable()
    const failing: JobRunner = () => Promise.reject(new Error('VFS API error'))
    const bad = await jt.submit({
      command: 'bad',
      run: failing,
      abort: new AbortController(),
      cwd: '/',
    })
    const good = await jt.submit({
      command: 'good',
      run: talking('hello'),
      abort: new AbortController(),
      cwd: '/',
    })
    await jt.waitAll()
    expect(jt.listJobs()).toHaveLength(2)
    const badJob = jt.get(bad.id)
    const goodJob = jt.get(good.id)
    expect(badJob?.exitCode).toBe(1)
    expect(dec(await badJob?.console.snapshot(Channel.STDERR))).toContain('VFS API error')
    expect(goodJob?.exitCode).toBe(0)
    expect(dec(await goodJob?.console.snapshot(Channel.STDOUT))).toBe('hello')
  })
})

describe('JobTable.popCompleted', () => {
  it('removes completed/killed jobs from the table', async () => {
    const jt = new JobTable()
    const j1 = await jt.submit({ command: 'a', run: quiet, abort: new AbortController(), cwd: '/' })
    const abort = new AbortController()
    await jt.submit({ command: 'b', run: pending(abort), abort, cwd: '/' })
    await jt.wait(j1.id)
    const popped = await jt.popCompleted()
    expect(popped).toHaveLength(1)
    expect(jt.listJobs()).toHaveLength(1)
  })

  it('a reader keeps its console after the job leaves the table', async () => {
    const jt = new JobTable()
    const j = await jt.submit({
      command: 'a',
      run: talking('kept'),
      abort: new AbortController(),
      cwd: '/',
    })
    await jt.wait(j.id)
    const console_ = j.console
    await jt.popCompleted()
    expect(jt.get(j.id)).toBeNull()
    expect(dec(await console_.snapshot(Channel.STDOUT))).toBe('kept')
  })

  it('a child table keeps its jobs off the shared store', async () => {
    const store = new RAMExecutionStore()
    const jt = new JobTable(store)
    const child = jt.child().child(jt)
    const j = await child.submit({
      command: 'a',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    expect(child.processes).toBe(jt.processes)
    expect(child.parent).toBe(jt)
    expect(child.store).not.toBe(store)
    expect(jt.listJobs()).toEqual([])
    expect(await store.load('')).toBeNull()
    await child.wait(j.id)
  })

  it('close leaves consoles open', async () => {
    const jt = new JobTable()
    const j = await jt.submit({ command: 'a', run: quiet, abort: new AbortController(), cwd: '/' })
    await jt.wait(j.id)
    await jt.close()
    expect(j.console.store.closed).toBe(false)
  })
})

/** A live job in one session, ended only by its own abort. */
async function live(jt: JobTable, sessionId: string): Promise<JobHandle> {
  const abort = new AbortController()
  return jt.submit({ command: 'x', run: pending(abort), abort, cwd: '/', sessionId })
}

describe('JobTable per-session scoping', () => {
  it('numbers each session from one', async () => {
    const jt = new JobTable()
    const a1 = await live(jt, 'a')
    const b1 = await live(jt, 'b')
    const a2 = await live(jt, 'a')
    expect([a1.id, b1.id, a2.id]).toEqual([1, 1, 2])
    await jt.killAll()
  })

  it('scopes every view to one session', async () => {
    const jt = new JobTable()
    const a1 = await live(jt, 'a')
    const b1 = await live(jt, 'b')
    expect(jt.listJobs('a')).toEqual([a1])
    expect(jt.runningJobs('b')).toEqual([b1])
    expect(jt.get(1, 'b')).toBe(b1)
    expect(jt.get(2, 'b')).toBeNull()
    expect(jt.listJobs()).toEqual([])
    expect(
      jt
        .allJobs()
        .map((j) => j.sessionId)
        .sort(),
    ).toEqual(['a', 'b'])
    await jt.killAll()
  })

  it('killAll reaches every session', async () => {
    const jt = new JobTable()
    const a1 = await live(jt, 'a')
    const b1 = await live(jt, 'b')
    const killed = await jt.killAll()
    expect(new Set(killed.map((j) => j.sessionId))).toEqual(new Set(['a', 'b']))
    expect(a1.signal).not.toBeNull()
    expect(b1.signal).not.toBeNull()
    expect(jt.allRunningJobs()).toEqual([])
  })

  it('resets numbering per session when its list empties', async () => {
    const jt = new JobTable()
    const a1 = await live(jt, 'a')
    await live(jt, 'b')
    expect(await jt.kill(a1.id, 'a')).toBe(true)
    await jt.reap(a1.id, 'a')
    expect((await live(jt, 'a')).id).toBe(1)
    expect((await live(jt, 'b')).id).toBe(2)
    await jt.killAll()
  })

  it("closeSession stops and forgets the session's jobs", async () => {
    const jt = new JobTable()
    const a1 = await live(jt, 'a')
    const a2 = await live(jt, 'a')
    const b1 = await live(jt, 'b')
    expect(await jt.disown(a2.id, 'a')).toBe(true)
    expect(await jt.closeSession('a')).toEqual([a1])
    expect(a1.signal).not.toBeNull()
    // Disowned: off the list, still running, bash's own rule.
    expect(a2.state).toBe('running')
    expect(jt.listJobs('a')).toEqual([])
    expect(jt.get(1, 'a')).toBeNull()
    expect(jt.listJobs('b')).toEqual([b1])
    expect(jt.savedStatuses('a', a2.pid).size).toBe(0)
    // A session reusing the id starts from one and inherits nothing.
    expect((await live(jt, 'a')).id).toBe(1)
    await jt.killAll()
    expect(a2.signal).not.toBeNull()
  })

  it('loadJob restores a job into its session', async () => {
    const jt = new JobTable()
    const restored = new JobHandle({
      id: 3,
      command: 'x',
      cwd: '/',
      createdAt: 0,
      state: 'exited',
      sessionId: 'a',
      console: new JobConsole(),
    })
    await jt.load(restored)
    expect(jt.get(3, 'a')).toBe(restored)
    expect(jt.get(3)).toBeNull()
    expect((await live(jt, 'a')).id).toBe(4)
    expect((await live(jt, 'b')).id).toBe(1)
    await jt.killAll()
  })
})

it('keeps a disowned process visible until its cancelled runner really exits', async () => {
  const table = new JobTable(),
    release: { fire?: () => void } = {}
  const job = await table.submit({
    command: 'long',
    run: deaf(release),
    cwd: '/',
    sessionId: 'a',
    abort: new AbortController(),
  })
  await Promise.resolve()
  const process = job.process
  if (process === null) throw new Error('missing process')
  expect(await table.disown(job.id, 'a')).toBe(true)
  expect(table.listJobs('a')).toEqual([])
  expect(table.processes.visible('a').map((info) => info.id.pid)).toEqual([process.record.id.pid])
  await table.killAll()
  expect(job.signal).not.toBeNull()
  expect(table.processes.visible('a').map((info) => info.state)).toEqual(['stopping'])
  if (release.fire === undefined) throw new Error('runner did not start')
  release.fire()
  expect(await process.join()).toMatchObject({ exit: 0, signal: null })
  expect(table.processes.visible('a')).toEqual([])
})

it('does not restart process IDs with shell job numbers', async () => {
  const table = new JobTable()
  const submit = (sessionId: string) => {
    const abort = new AbortController()
    return table.submit({ command: 'wait', run: pending(abort), abort, cwd: '/', sessionId })
  }
  const a = await submit('a'),
    b = await submit('b')
  expect(a.id).toBe(1)
  expect(b.id).toBe(1)
  const pa = a.process,
    pb = b.process
  if (pa === null || pb === null) throw new Error('missing process')
  expect(pa.record.id.pid).not.toBe(pb.record.id.pid)
  await table.kill(a.id, 'a')
  await table.reap(a.id, 'a')
  const replacement = await submit('a')
  expect(replacement.id).toBe(1)
  const pr = replacement.process
  if (pr === null) throw new Error('missing process')
  expect(pr.record.id.pid).toBeGreaterThan(pb.record.id.pid)
  await table.killAll()
  await Promise.all([pa.join(), pb.join(), pr.join()])
})

it('settles an already aborted job without entering its runner', async () => {
  const table = new JobTable(),
    abort = new AbortController()
  abort.abort()
  let entered = false
  const job = await table.submit({
    command: 'cancelled',
    abort,
    cwd: '/',
    run: () => {
      entered = true
      return quiet(job)
    },
  })
  await table.wait(job.id)
  expect(entered).toBe(false)
  expect(job.signal).not.toBeNull()
  expect(await job.process?.join()).toMatchObject({ exit: 137, signal: 9 })
})

it('a refused job gives its number back', async () => {
  const store = new RAMExecutionStore()
  const table = new JobTable(store)
  const abort = new AbortController()
  const job = await table.submit({
    command: 'held',
    run: pending(abort),
    abort,
    cwd: '/',
    limit: 1,
  })
  try {
    for (let n = 0; n < 3; n++)
      await expect(
        table.submit({
          command: 'refused',
          run: quiet,
          abort: new AbortController(),
          cwd: '/',
          limit: 1,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: 'EAGAIN' }))
    expect(table.listJobs()).toEqual([job])
    const stored = await store.load('')
    expect(Object.keys(stored?.jobs ?? {})).toEqual(['1'])
    expect(stored?.next).toBe(2)
  } finally {
    await table.killAll()
    await table.processes.drain()
  }
})

it('a console failure never enters the job runner', async () => {
  const entered: string[] = []
  const store = new BrokenConsoles()
  const table = new JobTable(store)
  await expect(
    table.submit({
      command: 'refused',
      cwd: '/',
      abort: new AbortController(),
      limit: 1,
      run: (job) => {
        entered.push('runner')
        return quiet(job)
      },
    }),
  ).rejects.toThrow('console unavailable')
  await table.processes.drain()
  expect(table.listJobs()).toEqual([])
  expect(table.processes.live()).toEqual([])
  expect(entered).toEqual([])
  expect((await store.load(''))?.jobs).toEqual({})
})

it("a substitution lists its caller's jobs before its own", async () => {
  const caller = new JobTable()
  const outer = await caller.submit({
    command: 'outer',
    run: quiet,
    abort: new AbortController(),
    cwd: '/',
  })
  const innerTable = new JobTable(null, caller.processes, caller)
  const inner = await innerTable.submit({
    command: 'inner',
    run: quiet,
    abort: new AbortController(),
    cwd: '/',
  })
  expect(innerTable.listing()).toEqual([outer, inner])
  expect(innerTable.listJobs()).toEqual([inner])
})

/** A runner that exits at once with `code`. */
function exitWith(code: number): JobRunner {
  return () =>
    Promise.resolve([new IOResult({ exitCode: code }), new ExecutionNode({ exitCode: code })])
}

/** A job in session `s` that ends only through its abort. */
async function sleeping(jt: JobTable): Promise<JobHandle> {
  const abort = new AbortController()
  return jt.submit({ command: 'sleep 30', run: pending(abort), abort, cwd: '/', sessionId: 's' })
}

describe('JobTable on a shared store', () => {
  it('another table lists, waits on and kills a job', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store)
    const b = new JobTable(store)
    const job = await sleeping(a)
    await b.sync('s')
    const [seen] = b.listJobs('s')
    expect([seen?.id, seen?.command, seen?.state]).toEqual([1, 'sleep 30', 'running'])
    expect(seen?.process).toBeNull()
    expect(await b.kill(1, 's', 15)).toBe(true)
    expect((await b.wait(1, 's')).exitCode).toBe(143)
    await job.process?.join()
    expect([job.signal, job.exitCode]).toEqual([15, 143])
    expect(dec(await job.console.snapshot(Channel.STDERR))).toBe('Killed')
  })

  it('another table waits for a job to end', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store)
    const b = new JobTable(store)
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const run: JobRunner = async () => {
      await gate
      return [new IOResult({ exitCode: 1 }), new ExecutionNode({ exitCode: 1 })]
    }
    await a.submit({
      command: 'false',
      run,
      abort: new AbortController(),
      cwd: '/',
      sessionId: 's',
    })
    await b.sync('s')
    let done = false
    const waiter = b.wait(1, 's').then((job) => {
      done = true
      return job
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(done).toBe(false)
    release()
    expect((await waiter).exitCode).toBe(1)
  })

  // One daemon runs a workspace's jobs at a time: another one is told which
  // daemon holds the lease, and once that one closes it runs them,
  // numbering its pids past every pid the first gave out.
  it('a second daemon starts no job while the lease holds', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store)
    const b = new JobTable(store)
    const [first, second] = await Promise.all([sleeping(a), sleeping(a)])
    expect(new Set([first.id, second.id])).toEqual(new Set([1, 2]))
    const refused = await sleeping(b).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(WorkspaceHeldError)
    expect((refused as WorkspaceHeldError).holder).toBe(a.daemon)
    expect((refused as Error).message).toContain(a.daemon)
    await b.sync('s')
    expect(b.listJobs('s').map((j) => j.id)).toEqual([1, 2])
    await a.killAll()
    await a.close()
    const third = await sleeping(b)
    expect(third.pid).toBeGreaterThan(Math.max(first.pid, second.pid))
    await b.killAll()
  })

  // A daemon keeps its id across a restart, so it holds its workspace again
  // at once, and the jobs it ran before end as hung up.
  it('a restarted daemon holds its workspace again', async () => {
    const store = new RAMExecutionStore(30)
    const before = new JobTable(store, undefined, null, undefined, 'd')
    const lost = await sleeping(before)
    const held = before as unknown as { lease: ReturnType<typeof setTimeout> | null }
    if (held.lease !== null) clearTimeout(held.lease)
    held.lease = null
    const after = new JobTable(store, undefined, null, undefined, 'd')
    const abort = new AbortController()
    await after.submit({ command: 'next', run: pending(abort), abort, cwd: '/', sessionId: 's' })
    await after.sync('s')
    const [old, fresh] = after.listJobs('s')
    expect([old?.command, old?.signal, old?.exitCode]).toEqual(['sleep 30', 1, 129])
    expect([fresh?.command, fresh?.state]).toEqual(['next', 'running'])
    await lost.process?.join()
    await after.killAll()
    await after.close()
  })

  it('a job whose daemon lost the lease ends as hung up', async () => {
    const store = new RAMExecutionStore(0.05)
    const a = new JobTable(store)
    const b = new JobTable(store)
    const job = await sleeping(a)
    const owner = a as unknown as { lease: ReturnType<typeof setTimeout> | null }
    expect(owner.lease).not.toBeNull()
    if (owner.lease !== null) clearTimeout(owner.lease)
    await b.sync('s')
    expect(b.runningJobs('s')).not.toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await b.wait(1, 's')).exitCode).toBe(129)
    expect(b.get(1, 's')?.signal).not.toBeNull()
    await job.process?.join()
    expect([job.signal, job.exitCode]).toEqual([1, 129])
  })

  it('a reap elsewhere drops the job from its owner', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store)
    const b = new JobTable(store)
    await a.submit({
      command: 'true',
      run: exitWith(0),
      abort: new AbortController(),
      cwd: '/',
      sessionId: 's',
    })
    await b.sync('s')
    expect((await b.wait(1, 's')).exitCode).toBe(0)
    await b.reap(1, 's')
    await a.sync('s')
    expect(a.listJobs('s')).toEqual([])
    expect((await sleeping(a)).id).toBe(1)
    await a.killAll()
  })
})

/** A runner that ends only once `gate` opens, exiting with `code`. */
function gated(gate: Promise<void>, code = 0): JobRunner {
  return async () => {
    await gate
    return [new IOResult({ exitCode: code }), new ExecutionNode({ exitCode: code })]
  }
}

/** A console whose first watch fails, as a dropped connection does. */
class FailsFirstWatch implements ConsoleStore {
  private failed = false

  constructor(private readonly inner: ConsoleStore) {}

  append(channel: Channel, data: Uint8Array): Promise<ConsoleChunk> {
    return this.inner.append(channel, data)
  }

  readFrom(seq: number, limit?: number): Promise<ReadResult> {
    return this.inner.readFrom(seq, limit)
  }

  get closed(): boolean {
    return this.inner.closed
  }

  wait(seq: number): Promise<void> {
    return this.inner.wait(seq)
  }

  waitEnded(signal?: AbortSignal): Promise<void> {
    if (!this.failed) {
      this.failed = true
      return Promise.reject(new Error('connection dropped'))
    }
    return this.inner.waitEnded(signal)
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}

/** A job store whose consoles each fail their first watch. */
class DroppedWatches extends RAMExecutionStore {
  override console(name: string): ConsoleStore {
    return new FailsFirstWatch(super.console(name))
  }
}

/** A console whose reads fail while its store counts failures down. */
class FailsReads implements ConsoleStore {
  constructor(
    private readonly inner: ConsoleStore,
    private readonly store: FailingReads,
  ) {}

  append(channel: Channel, data: Uint8Array): Promise<ConsoleChunk> {
    return this.inner.append(channel, data)
  }

  readFrom(seq: number, limit?: number): Promise<ReadResult> {
    if (this.store.failures > 0) {
      this.store.failures -= 1
      return Promise.reject(new Error('connection dropped'))
    }
    return this.inner.readFrom(seq, limit)
  }

  get closed(): boolean {
    return this.inner.closed
  }

  wait(seq: number): Promise<void> {
    return this.inner.wait(seq)
  }

  waitEnded(signal?: AbortSignal): Promise<void> {
    return this.inner.waitEnded(signal)
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}

/** A job store whose consoles fail its next `failures` reads. */
class FailingReads extends RAMExecutionStore {
  failures = 0

  override console(name: string): ConsoleStore {
    return new FailsReads(super.console(name), this)
  }
}

/** A job store on which a job starts just as a list is about to go; with
 * `replaces`, after another close deleted it. */
class StartsOnDelete extends RAMExecutionStore {
  peer: JobTable | null = null
  readonly started: JobHandle[] = []

  constructor(private readonly replaces = false) {
    super()
  }

  override async delete(sessionId: string, expectedGeneration: number): Promise<boolean> {
    if (this.peer !== null && this.started.length === 0) {
      if (this.replaces)
        expect(await super.delete(sessionId, generationOf(await this.load(sessionId)))).toBe(true)
      this.started.push(await sleeping(this.peer))
    }
    return super.delete(sessionId, expectedGeneration)
  }
}

/** A job store whose consoles' output can expire, as Redis's does. */
class ExpiringOutput extends RAMExecutionStore {
  readonly expired = new Set<string>()

  override console(name: string): ConsoleStore {
    return this.expired.has(name) ? new RAMConsoleStore() : super.console(name)
  }
}

/** A console that counts the reads parked on it at once. */
class CountedWaits implements ConsoleStore {
  constructor(
    private readonly inner: ConsoleStore,
    private readonly count: { parked: number; most: number },
  ) {}

  append(channel: Channel, data: Uint8Array): Promise<ConsoleChunk> {
    return this.inner.append(channel, data)
  }

  readFrom(seq: number, limit?: number): Promise<ReadResult> {
    return this.inner.readFrom(seq, limit)
  }

  get closed(): boolean {
    return this.inner.closed
  }

  async wait(seq: number, signal?: AbortSignal): Promise<void> {
    this.count.parked += 1
    this.count.most = Math.max(this.count.most, this.count.parked)
    try {
      await this.inner.wait(seq, signal)
    } finally {
      this.count.parked -= 1
    }
  }

  waitEnded(signal?: AbortSignal): Promise<void> {
    return this.inner.waitEnded(signal)
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}

/** A job store whose consoles count the reads parked on them. */
class CountingWaits extends RAMExecutionStore {
  readonly count = { parked: 0, most: 0 }

  override console(name: string): ConsoleStore {
    return new CountedWaits(super.console(name), this.count)
  }
}

describe('JobTable on a shared store, across reuse and failure', () => {
  it('a stale reap never drops a job that took its number', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store)
    const b = new JobTable(store)
    const abort = new AbortController()
    await a.submit({ command: 'true', run: exitWith(0), abort, cwd: '/', sessionId: 's' })
    await a.wait(1, 's')
    await a.close()
    await b.sync('s')
    await b.reap(1, 's')
    expect((await sleeping(b)).id).toBe(1)
    expect((await a.popCompleted('s')).map((j) => j.command)).toEqual(['true'])
    await b.sync('s')
    expect(b.listJobs('s').map((j) => j.command)).toEqual(['sleep 30'])
    await b.killAll()
  })

  it('a sync takes the job that took a reaped number', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store)
    const b = new JobTable(store)
    const abort = new AbortController()
    await a.submit({ command: 'true', run: exitWith(0), abort, cwd: '/', sessionId: 's' })
    await a.wait(1, 's')
    await a.close()
    await b.sync('s')
    await b.reap(1, 's')
    await sleeping(b)
    await a.sync('s')
    const [seen] = a.listJobs('s')
    expect([seen?.command, seen?.state]).toEqual(['sleep 30', 'running'])
    expect(await a.popCompleted('s')).toEqual([])
    await b.sync('s')
    expect(b.listJobs('s').map((j) => j.command)).toEqual(['sleep 30'])
    await b.killAll()
  })

  // A program that handled the kill leaves its own status, and the ending
  // every workspace reads carries it, not the signal's.
  it('a handled kill answers one status everywhere', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store)
    const b = new JobTable(store)
    const abort = new AbortController()
    let started = (): void => undefined
    const up = new Promise<void>((resolve) => {
      started = resolve
    })
    const run: JobRunner = (job) =>
      new Promise((_resolve, reject) => {
        started()
        abort.signal.addEventListener('abort', () => {
          setTimeout(() => {
            job.process?.programExited(3)
            reject(new DOMException('aborted', 'AbortError'))
          }, 50)
        })
      })
    const j = await a.submit({ command: 'prog', run, abort, cwd: '/', simple: true })
    await up
    await b.sync()
    expect(await a.kill(j.id, '', 15)).toBe(true)
    expect((await b.wait(j.id)).exitCode).toBe(3)
    expect((await a.wait(j.id)).exitCode).toBe(3)
  })

  it('a kill before the runner begins ends the console at once', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const j = await jt.submit({ command: 'never', run: pending(abort), abort, cwd: '/' })
    expect(await jt.kill(j.id, '', 15)).toBe(true)
    expect((await jt.wait(j.id)).exitCode).toBe(143)
    expect(dec(await j.console.snapshot(Channel.STDERR))).toBe('Killed')
  })

  it('close ends a killed job still stopping', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const release: { fire?: () => void } = {}
    const j = await jt.submit({ command: 'deaf', run: deaf(release), abort, cwd: '/' })
    expect(await jt.kill(j.id, '', 15)).toBe(true)
    expect(j.console.finished).toBe(false)
    await jt.close()
    expect(await j.console.outcome()).toBe('killed:143:15')
    release.fire?.()
    await j.process?.join()
  })

  it('a watch that failed a read still heeds a kill', async () => {
    vi.useFakeTimers()
    try {
      const store = new DroppedWatches()
      const a = new JobTable(store)
      const b = new JobTable(store)
      const job = await sleeping(a)
      await vi.advanceTimersByTimeAsync(0)
      await b.sync('s')
      expect(await b.kill(1, 's', 15)).toBe(true)
      await vi.advanceTimersByTimeAsync(WATCH_RETRY_SECONDS * 1000 * 3)
      await job.process?.join()
      expect([job.signal, job.exitCode]).toEqual([15, 143])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a finished job outlives its expired output', async () => {
    const store = new ExpiringOutput(0.05)
    const a = new JobTable(store)
    const abort = new AbortController()
    const job = await a.submit({
      command: 'true',
      run: exitWith(0),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    await job.process?.join()
    store.expired.add(job.consoleName)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const fresh = new JobTable(store)
    await fresh.sync('s')
    const [seen] = fresh.listJobs('s')
    expect([seen?.state, seen?.signal, seen?.exitCode]).toEqual(['exited', null, 0])
  })

  it('a long wait elsewhere keeps one read across lease checks', async () => {
    const store = new CountingWaits(0.03)
    const a = new JobTable(store)
    const b = new JobTable(store)
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const abort = new AbortController()
    await a.submit({ command: 'slow', run: gated(gate), abort, cwd: '/', sessionId: 's' })
    await b.sync('s')
    const waiting = b.wait(1, 's')
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    expect((await waiting).exitCode).toBe(0)
    expect(store.count.most).toBe(1)
  })
})

/**
 * A job store that runs one hook right after a list read, as another
 * workspace's write landing between a read and what follows it.
 */
class HookAfterRead extends RAMExecutionStore {
  afterRead: (() => Promise<void>) | null = null

  override async load(sessionId: string): Promise<RecordFields | null> {
    const fields = await super.load(sessionId)
    const hook = this.afterRead
    this.afterRead = null
    if (hook !== null) await hook()
    return fields
  }
}

describe('JobTable on a shared store, across reaps and closes', () => {
  it('a sync never attaches a console reaped after its read', async () => {
    const store = new HookAfterRead()
    const a = new JobTable(store)
    const b = new JobTable(store)
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const abort = new AbortController()
    const job = await a.submit({
      command: 'slow',
      run: gated(gate),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    store.afterRead = async () => {
      release()
      await job.process?.join()
      await a.reap(1, 's')
    }
    await b.sync('s')
    expect(b.listJobs('s')).toEqual([])
  })

  it('a close elsewhere stops a disowned job', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store)
    const b = new JobTable(store)
    const job = await sleeping(a)
    await b.sync('s')
    expect(await b.disown(1, 's')).toBe(true)
    expect((await sleeping(a)).id).toBe(1)
    await b.closeSession('s')
    await job.process?.join()
    expect([job.signal, job.exitCode]).toEqual([9, 137])
  })

  it('a disowned job drops its record when it ends', async () => {
    const store = new RAMExecutionStore()
    const jt = new JobTable(store)
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const abort = new AbortController()
    const job = await jt.submit({
      command: 'slow',
      run: gated(gate),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    expect(await jt.disown(job.id, 's')).toBe(true)
    expect(Object.keys((await store.load('s'))?.disowned ?? {})).toEqual([job.consoleName])
    release()
    await job.process?.join()
    expect((await store.load('s'))?.disowned).toBeUndefined()
    expect((jt as unknown as { disowned: JobHandle[] }).disowned).toEqual([])
  })
})

describe('JobTable on a shared store, across launches, restores and abandoned waits', () => {
  it('a job started during a sync stays this table own', async () => {
    const store = new HookAfterRead()
    const jt = new JobTable(store)
    const started: JobHandle[] = []
    store.afterRead = async () => {
      started.push(await sleeping(jt))
    }
    await jt.sync('s')
    const [job] = started
    expect(job).toBeDefined()
    if (job === undefined) return
    expect(jt.get(job.id, 's')).toBe(job)
    expect(job.process).not.toBeNull()
    await jt.killAll()
  })

  it('a disown never parks a job that already ended', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store)
    const b = new JobTable(store)
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const abort = new AbortController()
    const job = await a.submit({
      command: 'slow',
      run: gated(gate),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    await b.sync('s')
    release()
    await job.process?.join()
    expect(await b.disown(1, 's')).toBe(true)
    expect((await store.load('s'))?.disowned).toBeUndefined()
  })

  it('a restore never hides a job that holds its number', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store)
    const b = new JobTable(store)
    const live = await sleeping(b)
    const restored = new JobHandle({
      id: live.id,
      command: 'old',
      cwd: '/',
      createdAt: 0,
      state: 'exited',
      sessionId: 's',
      console: new JobConsole(null, true),
    })
    await a.load(restored)
    expect(restored.id).toBe(live.id + 1)
    await b.sync('s')
    expect(b.listJobs('s').map((j) => [j.id, j.command])).toEqual([
      [live.id, 'sleep 30'],
      [live.id + 1, 'old'],
    ])
    await b.killAll()
  })

  it('an abandoned wait elsewhere stops reading', async () => {
    const store = new CountingWaits()
    const a = new JobTable(store)
    const b = new JobTable(store)
    const job = await sleeping(a)
    await b.sync('s')
    const abandon = new AbortController()
    const waiting = b.wait(1, 's', abandon.signal)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(store.count.parked).toBe(1)
    abandon.abort()
    await waiting
    expect(store.count.parked).toBe(0)
    expect(job.state).toBe('running')
    await a.killAll()
  })
})

/** A console whose watch never wakes, as an owner that has not looked yet. */
class Unwatched extends FailsFirstWatch {
  override waitEnded(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      signal?.addEventListener(
        'abort',
        () => {
          resolve()
        },
        { once: true },
      )
    })
  }
}

/** A job store whose owners never notice an ending on their own. */
class UnwatchedConsoles extends RAMExecutionStore {
  override console(name: string): ConsoleStore {
    return new Unwatched(super.console(name))
  }
}

describe('JobTable on a shared store, across retaken numbers and early kills', () => {
  // A daemon that lost the lease while its job still ran, unaware, lists the
  // job the daemon that took the lease started under the same number.
  it('a number retaken elsewhere lists the new job', async () => {
    const store = new UnwatchedConsoles(0.05)
    const a = new JobTable(store)
    const b = new JobTable(store)
    const old = await sleeping(a)
    const held = a as unknown as { lease: ReturnType<typeof setTimeout> | null }
    if (held.lease !== null) clearTimeout(held.lease)
    held.lease = null
    await new Promise((resolve) => setTimeout(resolve, 100))
    await b.sync('s')
    expect((await b.wait(1, 's')).exitCode).toBe(129)
    await b.reap(1, 's')
    const abort = new AbortController()
    await b.submit({ command: 'next', run: pending(abort), abort, cwd: '/', sessionId: 's' })
    await a.sync('s')
    expect(a.get(1, 's')?.command).toBe('next')
    expect(old.state).toBe('running')
    await a.killAll()
    await old.process?.join()
    await b.killAll()
  })

  it('a killed job keeps its ending and the lease', async () => {
    const store = new RAMExecutionStore(30)
    const jt = new JobTable(store)
    const abort = new AbortController()
    const job = await jt.submit({
      command: 'never',
      run: pending(abort),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    expect(await jt.kill(job.id, 's', 15)).toBe(true)
    await job.process?.join()
    const stored = (await store.load('s'))?.jobs as Record<
      string,
      { state: string; exit: number | null; signal: number | null }
    >
    const entry = stored[job.id.toString()]
    expect([entry?.state, entry?.exit, entry?.signal]).toEqual(['exited', 143, 15])
    expect(await store.holder()).toBe(jt.daemon)
    await jt.close()
    expect((jt as unknown as { lease: unknown }).lease).toBeNull()
  })

  it.each([false, true])(
    'a close stops a job started while it closed (replaces: %s)',
    async (replaces) => {
      const store = new StartsOnDelete(replaces)
      const a = new JobTable(store)
      store.peer = a
      await sleeping(a)
      const stopped = await a.closeSession('s')
      const [late] = store.started
      expect(stopped.map((j) => j.consoleName)).toEqual(expect.arrayContaining([late?.consoleName]))
      expect(stopped).toHaveLength(2)
      await late?.process?.join()
      expect([late?.signal, late?.exitCode]).toEqual([9, 137])
      expect(await store.load('s')).toBeNull()
    },
  )

  it('a job whose list was deleted elsewhere stops', async () => {
    vi.useFakeTimers()
    try {
      const store = new RAMExecutionStore()
      const job = await sleeping(new JobTable(store))
      await vi.advanceTimersByTimeAsync(0)
      await store.clear()
      await vi.advanceTimersByTimeAsync(LIST_CHECK_SECONDS * 1000 * 2)
      await job.process?.join()
      expect([job.signal, job.exitCode]).toEqual([9, 137])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a listed or disowned job runs on past its checks', async () => {
    vi.useFakeTimers()
    try {
      const jt = new JobTable(new RAMExecutionStore())
      const listed = await sleeping(jt)
      const disowned = await sleeping(jt)
      expect(await jt.disown(disowned.id, 's')).toBe(true)
      await vi.advanceTimersByTimeAsync(LIST_CHECK_SECONDS * 1000 * 3)
      expect([listed.state, disowned.state]).toEqual(['running', 'running'])
      await jt.killAll()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a list check that failed a read checks again', async () => {
    vi.useFakeTimers()
    try {
      const store = new FailingReads()
      const job = await sleeping(new JobTable(store))
      await vi.advanceTimersByTimeAsync(0)
      store.failures = 1
      await store.clear()
      await vi.advanceTimersByTimeAsync(LIST_CHECK_SECONDS * 1000 * 3)
      await job.process?.join()
      expect([job.signal, job.exitCode]).toEqual([9, 137])
      expect(store.failures).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a dropped job deaf to its stop still ends', async () => {
    vi.useFakeTimers()
    try {
      const store = new RAMExecutionStore()
      const jt = new JobTable(store)
      const release: { fire?: () => void } = {}
      const abort = new AbortController()
      const job = await jt.submit({
        command: 'deaf',
        run: deaf(release),
        abort,
        cwd: '/',
        sessionId: 's',
      })
      await vi.advanceTimersByTimeAsync(0)
      await store.clear()
      const waited = jt.wait(job.id, 's')
      await vi.advanceTimersByTimeAsync((LIST_CHECK_SECONDS + STOP_WAIT_SECONDS) * 1000 * 2)
      const ended = await waited
      expect([ended.signal, ended.exitCode]).toEqual([9, 137])
      release.fire?.()
      await job.process?.join()
    } finally {
      vi.useRealTimers()
    }
  })
})

/** A table whose processes are published on `store`, as a workspace's are. */
function publishing(store: RAMExecutionStore): JobTable {
  const processes: ProcessTable = new ProcessTable(undefined, undefined, undefined, () => {
    table.processesChanged()
  })
  const table: JobTable = new JobTable(store, processes)
  return table
}

/** Poll `check` until it holds, for at most five seconds. */
async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('JobTable process plane', () => {
  // A table on a shared store publishes the processes it runs while it runs
  // any, each stamped with when it read them on the host's clock, whatever
  // clock the table keeps, and its record goes once it runs none; another
  // table lists them.
  it('publishes its processes while it runs any', async () => {
    const store = new RAMExecutionStore(30)
    const processes: ProcessTable = new ProcessTable(undefined, undefined, undefined, () => {
      a.processesChanged()
    })
    const a: JobTable = new JobTable(store, processes, null, new ManualClock())
    const b = publishing(store)
    const abort = new AbortController()
    const job = await a.submit({
      command: 'sleep 30',
      run: pending(abort),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    await until(async () => a.daemon in (await b.remoteProcesses()))
    const record = (await b.remoteProcesses())[a.daemon]?.[String(job.pid)]
    expect([record?.command, record?.session]).toEqual(['sleep 30', 's'])
    expect([record?.runtime, record?.machine_pid]).toEqual([null, null])
    expect(Math.abs((record?.seen_at as number) - Date.now() / 1000)).toBeLessThan(5)
    expect(await a.remoteProcesses()).toEqual({})
    expect(await a.kill(job.id, 's')).toBe(true)
    await until(async () => Object.keys(await store.processes()).length === 0)
    await a.close()
    await b.close()
  })

  // A stop another table asks of a process reaches its owner, which stops it
  // as kill does: a job's runner ends the job killed by that signal.
  it("stops the owner's job when another table asks", async () => {
    const store = new RAMExecutionStore(30)
    const [a, b] = [publishing(store), publishing(store)]
    const abort = new AbortController()
    const job = await a.submit({
      command: 'sleep 30',
      run: pending(abort),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    await until(async () => a.daemon in (await b.remoteProcesses()))
    const every = { list: 'workspace', kill: 'workspace', max: null } as const
    expect(await b.signalRemote(job.pid, 0, 't', () => every)).toBe(true)
    expect(job.state).toBe('running')
    expect(await b.signalRemote(job.pid, 15, 't', () => every)).toBe(true)
    await job.process?.join()
    expect([job.signal, job.exitCode]).toEqual([15, 143])
    expect(await b.signalRemote(job.pid + 1, 15, 't', () => every)).toBe(false)
    await a.close()
    await b.close()
  })

  // bash starts a job ignoring INT and QUIT: either, sent by the job's own
  // table, by another table on the store or as a stop asked through it,
  // leaves the job running, so the TERM after them is what ends it.
  it('leaves a job running on INT and QUIT from any table', async () => {
    const store = new RAMExecutionStore(30)
    const [a, b] = [publishing(store), publishing(store)]
    const abort = new AbortController()
    const job = await a.submit({
      command: 'sleep 30',
      run: pending(abort),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    await until(async () => a.daemon in (await b.remoteProcesses()))
    await b.sync('s')
    const every = { list: 'workspace', kill: 'workspace', max: null } as const
    for (const signal of [2, 3]) {
      expect(await a.kill(job.id, 's', signal)).toBe(true)
      expect(await b.kill(job.id, 's', signal)).toBe(true)
      expect(await b.signalRemote(job.pid, signal, 't', () => every)).toBe(true)
    }
    expect(await b.signalRemote(job.pid, 15, 't', () => every)).toBe(true)
    await job.process?.join()
    expect([job.signal, job.exitCode]).toEqual([15, 143])
    await a.close()
    await b.close()
  })

  // Another table's process is seen and stopped within the session's view:
  // one another session runs is not found, or not permitted to stop.
  it("keeps a remote signal to the session's view", async () => {
    const store = new RAMExecutionStore(30)
    const [a, b] = [publishing(store), publishing(store)]
    const abort = new AbortController()
    const job = await a.submit({
      command: 'sleep 30',
      run: pending(abort),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    await until(async () => a.daemon in (await b.remoteProcesses()))
    const own = { list: 'session', kill: 'session', max: null } as const
    const seen = { list: 'workspace', kill: 'session', max: null } as const
    expect(await b.signalRemote(job.pid, 15, 't', () => own)).toBe(false)
    await expect(b.signalRemote(job.pid, 15, 't', () => seen)).rejects.toMatchObject({
      code: 'EPERM',
    })
    expect(await b.signalRemote(job.pid, 15, 's', () => own)).toBe(true)
    await a.close()
    await b.close()
  })

  // The grants are read once the store has answered: a view revoked while
  // it answered stops nothing under the grants it had before.
  it('reads the grants of a remote signal after the store', async () => {
    const store = new RAMExecutionStore(30)
    const [a, b] = [publishing(store), publishing(store)]
    const abort = new AbortController()
    const job = await a.submit({
      command: 'sleep 30',
      run: pending(abort),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    await until(async () => a.daemon in (await b.remoteProcesses()))
    const every = { list: 'workspace', kill: 'workspace', max: null } as const
    let revoked = false
    const listing = store.processes.bind(store)
    const spy = vi.spyOn(store, 'processes').mockImplementation(() => {
      revoked = true
      return listing()
    })
    try {
      expect(await b.signalRemote(job.pid, 15, 't', () => (revoked ? null : every))).toBe(false)
    } finally {
      spy.mockRestore()
    }
    expect(await store.takeStops(a.daemon)).toEqual([])
    expect(job.state).toBe('running')
    abort.abort()
    await a.close()
    await b.close()
  })

  // The processes of a daemon that lost the lease are not listed; each that
  // ran a program past the workspace is handed to the runStopper as published,
  // and its record keeps only the processes nobody here reached. One that
  // ran none (a shell) has nothing left to stop.
  it.each([false, true])(
    "stops a lapsed owner's programs (one unreached: %s)",
    async (unreached) => {
      const store = new RAMExecutionStore(30)
      const host = {
        ...ran(2, 'host:h'),
        machine_pid: { pid: 41, started: 1, exited: null },
        seen_at: 5,
      }
      const box = ran(3)
      const shell = { pid: 4, session: 's', runtime: null }
      await store.publish('dead', { '2': host, '3': box, '4': shell })
      const stopped: [unknown, number][] = []
      const b = new JobTable(store)
      b.runStopper = (record, signum) => {
        stopped.push([record, signum])
        return Promise.resolve(!(unreached && record.pid === 3))
      }
      expect(await b.remoteProcesses()).toEqual({})
      await until(
        async () => stopped.length === 2 && (await store.processes()).dead?.['2'] === undefined,
      )
      expect(stopped).toEqual([
        [host, 15],
        [box, 15],
      ])
      expect(await store.processes()).toEqual(unreached ? { dead: { '3': box } } : {})
      await b.close()
    },
  )

  // A start stops the daemons on the store that lost the lease, and once
  // more a lease later: a daemon that still held it at the start, as one
  // that died just before it would, is stopped once it lapsed.
  it('stops lapsed daemons as it starts', async () => {
    const store = new RAMExecutionStore(0.5)
    for (const owner of ['dead', 'dying']) {
      await store.publish(owner, { '2': ran(2, `docker:${owner}`) })
    }
    await store.lease('dying')
    const stopped: unknown[] = []
    const b = new JobTable(store)
    b.runStopper = (record) => {
      stopped.push(String(record.machine).split(':')[1])
      return Promise.resolve(true)
    }
    b.stopLapsed()
    await until(() => Promise.resolve(stopped.length > 0))
    expect(stopped).toEqual(['dead'])
    await until(async () => Object.keys(await store.processes()).length === 0)
    expect(stopped).toEqual(['dead', 'dying'])
    await b.close()
  })

  it('finishes the lease wait after an early timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let elapsed = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    const store = new RAMExecutionStore(0.5)
    const b = new JobTable(store)
    const stopped: unknown[] = []
    b.runStopper = (record) => {
      stopped.push(String(record.machine).split(':')[1])
      return Promise.resolve(true)
    }
    try {
      await store.publish('dying', { '2': ran(2, 'docker:dying') })
      await store.lease('dying')
      b.stopLapsed()
      await vi.advanceTimersByTimeAsync(0)
      elapsed = 499
      await vi.advanceTimersByTimeAsync(500)
      expect(stopped).toEqual([])
      elapsed = 500
      await vi.advanceTimersByTimeAsync(1)
      expect(stopped).toEqual(['dying'])
      expect(await store.processes()).toEqual({})
    } finally {
      await b.close()
      now.mockRestore()
      vi.useRealTimers()
    }
  })

  // A store whose leases never lapse has no lapsed daemon, so a start sweeps
  // nothing.
  it('sweeps nothing on a store without leases', async () => {
    const b = new JobTable(new RAMExecutionStore())
    b.stopLapsed()
    expect((b as unknown as { stoppingRuns: Set<Promise<void>> }).stoppingRuns.size).toBe(0)
    await b.close()
  })

  // Teardown ends a start's sweep that waits for a lease to pass.
  it('ends the sweep at teardown', async () => {
    const store = new RAMExecutionStore(30)
    await store.lease('live')
    await store.publish('live', { '2': { pid: 2, session: 's', runs: [] } })
    const b = new JobTable(store)
    b.stopLapsed()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    await b.killAll()
    expect(Date.now() - started).toBeLessThan(5000)
    await b.close()
  })

  // A teardown while the sweep's first read is still out leaves no wait to
  // start once the read answers.
  it('starts no wait once teardown came during the first read', async () => {
    class HeldReads extends RAMExecutionStore {
      answer: () => void = () => undefined
      private readonly gate = new Promise<void>((resolve) => {
        this.answer = resolve
      })

      override async processes(): Promise<Record<string, Record<string, RecordFields>>> {
        await this.gate
        return super.processes()
      }
    }
    const store = new HeldReads(30)
    await store.lease('live')
    await store.publish('live', { '2': { pid: 2, session: 's', runs: [] } })
    const b = new JobTable(store)
    b.stopLapsed()
    const started = Date.now()
    const killing = b.killAll()
    store.answer()
    await killing
    expect(Date.now() - started).toBeLessThan(5000)
    await b.close()
  })

  // The lease goes ahead of the record it vouches for, so no daemon ever
  // reads a record whose daemon it takes for lapsed, even for a process that
  // is no job (a line, a spawned child); and the record is written again
  // with every renewal, so it outlives its store's expiry and comes back
  // after a daemon dropped it.
  it('vouches for its record and writes it again', async () => {
    const vouched: boolean[] = []
    class VouchedStore extends RAMExecutionStore {
      override async publish(
        daemon: string,
        processes: Readonly<Record<string, RecordFields>>,
        lastPid = 0,
      ): Promise<void> {
        if (Object.keys(processes).length > 0) vouched.push((await this.holder()) === daemon)
        await super.publish(daemon, processes, lastPid)
      }
    }
    const store = new VouchedStore(3 * PUBLISH_SECONDS)
    const a = publishing(store)
    await a.claim()
    const abort = new AbortController()
    const runner = a.processes.start({
      sessionId: 's',
      command: 'sleep 30',
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => {
        abort.abort()
      },
      run: () =>
        new Promise<number>((_resolve, reject) => {
          abort.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    })
    await until(() => Promise.resolve(vouched.length >= 3))
    await RAMExecutionStore.prototype.publish.call(store, a.daemon, {})
    await until(async () => a.daemon in (await store.processes()))
    expect(vouched.every(Boolean)).toBe(true)
    runner.terminate()
    await runner.join()
    await a.close()
  }, 15_000)

  // A daemon that takes the lease back while its programs are being stopped
  // keeps them: the lease is read again before each is stopped.
  it('lets a daemon that renews keep its programs', async () => {
    let asked = 0
    class Revives extends RAMExecutionStore {
      override holder(): Promise<string | null> {
        asked += 1
        return Promise.resolve(asked > 1 ? 'back' : null)
      }
    }
    const store = new Revives(30)
    await store.publish('back', { '2': ran(2) })
    const stopped: unknown[] = []
    const b = new JobTable(store)
    b.runStopper = (record) => {
      stopped.push(record)
      return Promise.resolve(true)
    }
    expect(await b.remoteProcesses()).toEqual({})
    await b.killAll()
    expect(stopped).toEqual([])
    expect('back' in (await store.processes())).toBe(true)
    await b.close()
  })

  // Teardown ends the stopping, before the runtimes it goes through close:
  // a stop under way is waited for, and no listing starts another.
  it('ends the stopping at teardown', async () => {
    const store = new RAMExecutionStore(30)
    await store.publish('dead', { '2': ran(2) })
    let calls = 0
    let finished = false
    const b = new JobTable(store)
    b.runStopper = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 50))
      finished = true
      return true
    }
    await b.remoteProcesses()
    await until(() => Promise.resolve(calls === 1))
    await b.killAll()
    expect(finished).toBe(true)
    await store.publish('dead', { '2': ran(2) })
    await b.remoteProcesses()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toBe(1)
    await b.close()
  })

  // A stop that fails to apply leaves the others it came with to be applied.
  it('applies the other stops when one fails', async () => {
    const store = new RAMExecutionStore(30)
    const a = publishing(store)
    const abort = new AbortController()
    const job = await a.submit({
      command: 'sleep 30',
      run: pending(abort),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    const applied: number[] = []
    const table = a as unknown as { stopAsked: (pid: number, signal: number) => Promise<void> }
    const stop = table.stopAsked.bind(a)
    table.stopAsked = async (pid, signal) => {
      if (pid === 999) throw new Error('cannot stop')
      applied.push(pid)
      await stop(pid, signal)
    }
    await store.requestStop(a.daemon, 999, 15)
    await store.requestStop(a.daemon, job.pid, 15)
    await job.process?.join()
    expect(applied).toEqual([job.pid])
    await a.close()
  }, 15_000)

  // A child shell's table keeps its job list private but reaches the other
  // workspaces' processes through the workspace's.
  it("reaches the process plane from a child shell's table", async () => {
    const store = new RAMExecutionStore(30)
    const [a, b] = [publishing(store), publishing(store)]
    const abort = new AbortController()
    const job = await a.submit({
      command: 'sleep 30',
      run: pending(abort),
      abort,
      cwd: '/',
      sessionId: 's',
    })
    const child = b.child().child()
    await until(async () => a.daemon in (await child.remoteProcesses()))
    const every = { list: 'workspace', kill: 'workspace', max: null } as const
    expect(await child.signalRemote(job.pid, 15, 's', () => every)).toBe(true)
    await job.process?.join()
    await a.close()
    await b.close()
  })

  // A stop another workspace asks for reaches a child shell's job through
  // the child's table, as its own kill would: the job answers killed at
  // once, though its runner ignores the stop.
  it("reaches a child shell's job with a stop asked elsewhere", async () => {
    const store = new RAMExecutionStore(30)
    const [a, b] = [publishing(store), publishing(store)]
    const child = a.child()
    let release = (): void => undefined
    const run: JobRunner = () =>
      new Promise<JobResult>((resolve) => {
        release = () => {
          resolve([new IOResult(), new ExecutionNode()])
        }
      })
    const job = await child.submit({
      command: 'deaf',
      run,
      abort: new AbortController(),
      cwd: '/',
      sessionId: 's',
      simple: true,
    })
    await until(async () => a.daemon in (await b.remoteProcesses()))
    const every = { list: 'workspace', kill: 'workspace', max: null } as const
    expect(await b.signalRemote(job.pid, 15, 't', () => every)).toBe(true)
    await until(() => Promise.resolve(job.signal !== null))
    expect(job.exitCode).toBe(143)
    release()
    await job.process?.join()
    await a.close()
    await b.close()
  })

  // The lease is the workspace's from the table's claim until it closes,
  // whether anything runs or not.
  it('keeps the lease from the claim until close', async () => {
    const store = new RAMExecutionStore(30)
    const a = publishing(store)
    await a.claim()
    const abort = new AbortController()
    const runner = a.processes.start({
      sessionId: 's',
      command: 'sleep 30',
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => {
        abort.abort()
      },
      run: () =>
        new Promise<number>((_resolve, reject) => {
          abort.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    })
    await until(async () => a.daemon in (await store.processes()))
    runner.terminate()
    await runner.join()
    const table = a as unknown as { lease: unknown }
    expect(table.lease).not.toBeNull()
    expect(await store.holder()).toBe(a.daemon)
    await a.close()
    expect(table.lease).toBeNull()
    expect(await store.holder()).toBeNull()
  })

  // A daemon whose lease lapsed and was taken by another stops renewing it,
  // hangs up what it runs, and its next job is refused, naming the daemon
  // that holds it now.
  it('refuses the next job once another daemon took the lease', async () => {
    const store = new RAMExecutionStore(0.03)
    const a = new JobTable(store)
    const b = new JobTable(store)
    await a.claim()
    const runner = a.processes.start(abortable('sleep 30'))
    const held = a as unknown as {
      lease: ReturnType<typeof setTimeout> | null
      keepLease: () => void
    }
    if (held.lease !== null) clearTimeout(held.lease)
    held.lease = null
    await new Promise((resolve) => setTimeout(resolve, 50))
    await b.claim()
    held.keepLease.call(a)
    await until(() => Promise.resolve(!a.claimed))
    expect((await runner.join()).signal).toBe(1)
    const refused = await sleeping(a).catch((err: unknown) => err)
    expect((refused as WorkspaceHeldError).holder).toBe(b.daemon)
    await b.close()
  })

  // A claim stops none of what its table runs now: a second claim waits for
  // the first, and a record of a process this table runs is its own, not one
  // left before a restart.
  it('stops none of what its table runs as it claims', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store, undefined, null, undefined, 'd')
    const stopped: unknown[] = []
    a.runStopper = (record) => {
      stopped.push(record.pid)
      return Promise.resolve(true)
    }
    const runner = a.processes.start(abortable('sleep 30'))
    const pid = runner.record.id.pid
    const own = { ...ran(pid), started_at: runner.record.startedAt }
    await store.publish('d', { [String(pid)]: own, '7': ran(7) }, 7)
    await Promise.all([a.claim(), a.claim()])
    await until(() => Promise.resolve(stopped.length > 0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopped).toEqual([7])
    runner.terminate()
    await runner.join()
    await a.close()
  })

  // A close waits for a claim under way and gives up the lease it took.
  it('gives up the lease a pending claim takes when it closes', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    class Slow extends RAMExecutionStore {
      override async lease(
        daemon: string,
        consoles: readonly string[] = [],
      ): Promise<string | null> {
        await gate
        return super.lease(daemon, consoles)
      }
    }
    const store = new Slow(30)
    const a = new JobTable(store)
    const claiming = a.claim()
    const closing = a.close()
    open()
    await claiming
    await closing
    expect(await store.holder()).toBeNull()
  })

  // A program this daemon left before a restart that the runStopper could not
  // reach stays in its record, so a later claim tries it again.
  it('keeps the record of a program it could not reach as it claims', async () => {
    const store = new RAMExecutionStore()
    await store.publish('d', { '7': ran(7) }, 7)
    const a = new JobTable(store, undefined, null, undefined, 'd')
    a.runStopper = () => Promise.resolve(false)
    await a.claim()
    await until(async () => (await store.processes()).d?.['7']?.machine === 'docker:t')
    await a.close()
  })

  // A job's record, and its entry in the session's list, name the line that
  // started it and the process group it runs in, its parent's.
  it('names the line and group of its job', async () => {
    const store = new RAMExecutionStore()
    const a = new JobTable(store)
    const abort = new AbortController()
    const parent = a.processes.start({
      sessionId: 's',
      command: 'sh',
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => {
        abort.abort()
      },
      run: () =>
        new Promise<number>((_resolve, reject) => {
          abort.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
      line: new LineId('l1'),
    })
    const stop = new AbortController()
    const job = await a.submit({
      command: 'sleep 30',
      run: pending(stop),
      abort: stop,
      cwd: '/',
      sessionId: 's',
      parent: parent.record.id.pid,
    })
    expect([job.record.line, job.record.group]).toEqual([new LineId('l1'), parent.record.group])
    const entries = Object.values(
      ((await store.load('s'))?.jobs ?? {}) as Record<string, RecordFields>,
    )
    expect(entries.map((entry) => [entry.line, entry.group])).toEqual([['l1', parent.record.group]])
    await a.killAll()
    parent.terminate()
    await parent.join()
  })

  // A table that closes drops its record, so it never reads as lapsed, and
  // gives the lease up for another daemon to take.
  it('drops its record and the lease once closed', async () => {
    const store = new RAMExecutionStore(30)
    const a = new JobTable(store)
    await a.claim()
    expect(a.claimed).toBe(true)
    await store.publish(a.daemon, { '2': { pid: 2, runs: [] } })
    await a.close()
    expect(await store.processes()).toEqual({})
    expect(await store.holder()).toBeNull()
  })

  // A daemon taking the lease stops the programs it left before a restart
  // and numbers its pids past the highest the store recorded.
  it("stops this daemon's programs from before a restart as it claims", async () => {
    const store = new RAMExecutionStore()
    const pid = FIRST_PID + 6
    await store.publish('d', { [String(pid)]: ran(pid) }, pid)
    const stopped: unknown[] = []
    const a = new JobTable(store, undefined, null, undefined, 'd')
    a.runStopper = (record) => {
      stopped.push(record)
      return Promise.resolve(true)
    }
    await a.claim()
    await until(() => Promise.resolve(stopped.length > 0))
    expect(stopped).toEqual([ran(pid)])
    const job = await sleeping(a)
    expect(job.pid).toBe(pid + 1)
    await a.killAll()
    await a.close()
  })
})
