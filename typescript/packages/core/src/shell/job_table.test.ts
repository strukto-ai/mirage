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
import { ExecutionNode } from '../workspace/types.ts'
import {
  Channel,
  type ConsoleChunk,
  type ConsoleStore,
  JobConsole,
  RAMConsoleStore,
  type ReadResult,
} from './console/index.ts'
import { Job, type JobResult, type JobRunner, JobStatus, JobTable } from './job_table.ts'

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

  async close(): Promise<void> {
    return this.inner.close()
  }
}

/** A live job whose console appends are parked behind the gate. */
function gatedJob(table: JobTable, gate: Promise<void>): Job {
  const job = new Job({
    id: 1,
    command: 'deaf',
    abort: new AbortController(),
    cwd: '/',
    console: new JobConsole(new GatedStore(gate)),
    task: new Promise<void>(() => undefined),
  })
  table.loadJob(job)
  return job
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

describe('JobTable.submit', () => {
  it('assigns incrementing ids starting at 1', () => {
    const jt = new JobTable()
    const j1 = jt.submit({ command: 'a', run: quiet, abort: new AbortController(), cwd: '/' })
    const j2 = jt.submit({ command: 'b', run: quiet, abort: new AbortController(), cwd: '/' })
    expect(j1.id).toBe(1)
    expect(j2.id).toBe(2)
  })

  it('defaults agent and sessionId', () => {
    const jt = new JobTable()
    const j = jt.submit({ command: 'a', run: quiet, abort: new AbortController(), cwd: '/' })
    expect(j.agent).toBe('unknown')
    expect(j.sessionId).toBe('')
    expect(j.status).toBe(JobStatus.RUNNING)
  })

  it('hands the runner a job that already has a console', async () => {
    const jt = new JobTable()
    const j = jt.submit({
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
  it('retrieves and lists jobs', () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const j = jt.submit({ command: 'a', run: pending(abort), abort, cwd: '/' })
    expect(jt.get(j.id)).toBe(j)
    expect(jt.get(999)).toBeNull()
    expect(jt.listJobs()).toHaveLength(1)
    expect(jt.runningJobs()).toHaveLength(1)
  })
})

describe('JobTable.kill', () => {
  it('aborts, marks killed, and keeps output produced before the kill', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const j = jt.submit({ command: 'sleep', run: pending(abort, 'partial'), abort, cwd: '/' })
    while (dec(await j.console.snapshot(Channel.STDOUT)) === '') await Promise.resolve()

    expect(await jt.kill(j.id)).toBe(true)

    expect(j.status).toBe(JobStatus.KILLED)
    expect(j.exitCode).toBe(137)
    expect(dec(await j.console.snapshot(Channel.STDOUT))).toBe('partial')
    expect(dec(await j.console.snapshot(Channel.STDERR))).toBe('Killed')
    expect(abort.signal.aborted).toBe(true)
  })

  it('returns a settled job, so callers never see a half-dead one', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const j = jt.submit({ command: 'sleep', run: pending(abort), abort, cwd: '/' })
    expect(await jt.kill(j.id)).toBe(true)
    expect(j.console.finished).toBe(true)
  })

  it('settles a job whose runner never observes the abort, instead of joining it', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const release: { fire?: () => void } = {}
    const j = jt.submit({ command: 'long', run: deaf(release), abort, cwd: '/' })

    // The signal is only seen where someone checks it. Joining the runner
    // here would hang the shell on exactly the runaway job being stopped.
    expect(await jt.kill(j.id)).toBe(true)

    expect(j.status).toBe(JobStatus.KILLED)
    expect(j.exitCode).toBe(137)
    expect(j.console.finished).toBe(true)

    // The runner unwinding afterwards must not reopen or relabel the job.
    release.fire?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(j.status).toBe(JobStatus.KILLED)
    expect(j.exitCode).toBe(137)
  })

  it('returns false for unknown and already-finished jobs', async () => {
    const jt = new JobTable()
    const j = jt.submit({ command: 'a', run: quiet, abort: new AbortController(), cwd: '/' })
    await jt.wait(j.id)
    expect(await jt.kill(j.id)).toBe(false)
    expect(await jt.kill(999)).toBe(false)
  })

  it('killAll stops every running job', async () => {
    const jt = new JobTable()
    const a1 = new AbortController()
    const a2 = new AbortController()
    jt.submit({ command: 'a', run: pending(a1), abort: a1, cwd: '/' })
    jt.submit({ command: 'b', run: pending(a2), abort: a2, cwd: '/' })
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
    const j = jt.submit({ command: 'foo', run, abort: new AbortController(), cwd: '/' })
    const result = await jt.wait(j.id)
    expect(result.status).toBe(JobStatus.COMPLETED)
    expect(result.exitCode).toBe(2)
    expect(dec(await result.console.snapshot(Channel.STDOUT))).toBe('hi')
    expect(dec(await result.console.snapshot(Channel.STDERR))).toBe('oops')
    expect(result.executionNode).toBe(execNode)
  })

  it('returns an already-completed job without re-awaiting', async () => {
    const jt = new JobTable()
    const j = new Job({ id: 99, command: 'a', cwd: '/' })
    j.status = JobStatus.COMPLETED
    jt.loadJob(j)
    const result = await jt.wait(99)
    expect(result).toBe(j)
  })

  it('sets COMPLETED and exitCode 1 on a runner error', async () => {
    const jt = new JobTable()
    const run: JobRunner = () => Promise.reject(new Error('boom'))
    const j = jt.submit({ command: 'a', run, abort: new AbortController(), cwd: '/' })
    const result = await jt.wait(j.id)
    expect(result.status).toBe(JobStatus.COMPLETED)
    expect(result.exitCode).toBe(1)
    expect(dec(await result.console.snapshot(Channel.STDERR))).toBe('boom')
  })

  it('throws on unknown id', async () => {
    const jt = new JobTable()
    await expect(jt.wait(99)).rejects.toThrow(/unknown job/)
  })
})

// Port of tests/shell/test_background_jobs.py::test_wait_all_survives_failing_task.
describe('JobTable.wait ordering', () => {
  it('joins a kill that is still appending its marker', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const jt = new JobTable()
    const job = gatedJob(jt, gate)
    const killP = jt.kill(job.id)
    // kill's synchronous prefix has already flipped the status; the
    // marker appends are parked behind the gate.
    expect(job.status).toBe(JobStatus.KILLED)
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
    const jt = new JobTable()
    const job = gatedJob(jt, gate)
    const killP = jt.kill(job.id)
    expect(job.status).toBe(JobStatus.KILLED)
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
    const failing: JobRunner = () => Promise.reject(new Error('resource API error'))
    const bad = jt.submit({ command: 'bad', run: failing, abort: new AbortController(), cwd: '/' })
    const good = jt.submit({
      command: 'good',
      run: talking('hello'),
      abort: new AbortController(),
      cwd: '/',
    })
    const jobs = await jt.waitAll()
    expect(jobs).toHaveLength(2)
    const badJob = jt.get(bad.id)
    const goodJob = jt.get(good.id)
    expect(badJob?.exitCode).toBe(1)
    expect(dec(await badJob?.console.snapshot(Channel.STDERR))).toContain('resource API error')
    expect(goodJob?.exitCode).toBe(0)
    expect(dec(await goodJob?.console.snapshot(Channel.STDOUT))).toBe('hello')
  })
})

describe('JobTable.popCompleted', () => {
  it('removes completed/killed jobs from the table', async () => {
    const jt = new JobTable()
    const j1 = jt.submit({ command: 'a', run: quiet, abort: new AbortController(), cwd: '/' })
    const abort = new AbortController()
    jt.submit({ command: 'b', run: pending(abort), abort, cwd: '/' })
    await jt.wait(j1.id)
    const popped = jt.popCompleted()
    expect(popped).toHaveLength(1)
    expect(jt.listJobs()).toHaveLength(1)
  })

  it('a reader keeps its console after the job leaves the table', async () => {
    const jt = new JobTable()
    const j = jt.submit({
      command: 'a',
      run: talking('kept'),
      abort: new AbortController(),
      cwd: '/',
    })
    await jt.wait(j.id)
    const console_ = j.console
    jt.popCompleted()
    expect(jt.get(j.id)).toBeNull()
    expect(dec(await console_.snapshot(Channel.STDOUT))).toBe('kept')
  })

  it('closeConsoles releases factory-built stores', async () => {
    const stores: RAMConsoleStore[] = []
    const factory = (): JobConsole => {
      const store = new RAMConsoleStore()
      stores.push(store)
      return new JobConsole(store)
    }
    const jt = new JobTable(factory)
    const j = jt.submit({ command: 'a', run: quiet, abort: new AbortController(), cwd: '/' })
    await jt.wait(j.id)
    await jt.closeConsoles()
    expect(stores).toHaveLength(1)
    expect(stores.every((s) => s.closed)).toBe(true)
  })

  it('closeConsoles leaves default consoles alone', async () => {
    const jt = new JobTable()
    const j = jt.submit({ command: 'a', run: quiet, abort: new AbortController(), cwd: '/' })
    await jt.wait(j.id)
    await jt.closeConsoles()
    const store = (j.console as unknown as { store: { closed: boolean } }).store
    expect(store.closed).toBe(false)
  })
})
