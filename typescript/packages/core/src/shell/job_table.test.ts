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
import { Job, JobStatus, JobTable, type JobTaskResult } from './job_table.ts'

function settled(result: JobTaskResult): Promise<JobTaskResult> {
  return Promise.resolve(result)
}

function pending(): { task: Promise<JobTaskResult>; abort: AbortController } {
  const abort = new AbortController()
  const task = new Promise<JobTaskResult>((resolve, reject) => {
    abort.signal.addEventListener('abort', () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    })
    void resolve
  })
  task.catch(() => {
    // silence unhandled rejection; tests that care use jt.wait()
  })
  return { task, abort }
}

describe('JobTable.submit', () => {
  it('assigns incrementing ids starting at 1', () => {
    const jt = new JobTable()
    const j1 = jt.submit({
      command: 'a',
      task: settled([null, new IOResult(), new ExecutionNode()]),
      abort: new AbortController(),
      cwd: '/',
    })
    const j2 = jt.submit({
      command: 'b',
      task: settled([null, new IOResult(), new ExecutionNode()]),
      abort: new AbortController(),
      cwd: '/',
    })
    expect(j1.id).toBe(1)
    expect(j2.id).toBe(2)
  })

  it('defaults agent and sessionId', () => {
    const jt = new JobTable()
    const j = jt.submit({
      command: 'a',
      task: settled([null, new IOResult(), new ExecutionNode()]),
      abort: new AbortController(),
      cwd: '/',
    })
    expect(j.agent).toBe('unknown')
    expect(j.sessionId).toBe('default')
    expect(j.status).toBe(JobStatus.RUNNING)
  })
})

describe('JobTable.get / list / running', () => {
  it('retrieves and lists jobs', () => {
    const jt = new JobTable()
    const j = jt.submit({
      command: 'a',
      task: settled([null, new IOResult(), new ExecutionNode()]),
      abort: new AbortController(),
      cwd: '/',
    })
    expect(jt.get(j.id)).toBe(j)
    expect(jt.get(999)).toBeNull()
    expect(jt.listJobs()).toHaveLength(1)
    expect(jt.runningJobs()).toHaveLength(1)
  })
})

describe('JobTable.kill', () => {
  it('aborts the controller + marks killed + exitCode 137', () => {
    const jt = new JobTable()
    const { task, abort } = pending()
    const j = jt.submit({ command: 'sleep', task, abort, cwd: '/' })
    expect(jt.kill(j.id)).toBe(true)
    expect(j.status).toBe(JobStatus.KILLED)
    expect(j.exitCode).toBe(137)
    expect(new TextDecoder().decode(j.stderr)).toBe('Killed')
    expect(abort.signal.aborted).toBe(true)
  })

  it('returns false for unknown job id', () => {
    const jt = new JobTable()
    expect(jt.kill(999)).toBe(false)
  })
})

describe('JobTable.wait', () => {
  it('awaits a completed task and syncs stdout/stderr/exitCode', async () => {
    const jt = new JobTable()
    const io = new IOResult({ stderr: new TextEncoder().encode('oops'), exitCode: 2 })
    const execNode = new ExecutionNode({ command: 'foo', exitCode: 2 })
    const stdout = new TextEncoder().encode('hi')
    const j = jt.submit({
      command: 'foo',
      task: settled([stdout, io, execNode]),
      abort: new AbortController(),
      cwd: '/',
    })
    const result = await jt.wait(j.id)
    expect(result.status).toBe(JobStatus.COMPLETED)
    expect(result.exitCode).toBe(2)
    expect(new TextDecoder().decode(result.stdout)).toBe('hi')
    expect(new TextDecoder().decode(result.stderr)).toBe('oops')
    expect(result.executionNode).toBe(execNode)
  })

  it('returns already-completed job without re-awaiting', async () => {
    const jt = new JobTable()
    const j = new Job({
      id: 99,
      command: 'a',
      task: settled([null, new IOResult(), new ExecutionNode()]),
      abort: new AbortController(),
      cwd: '/',
    })
    j.status = JobStatus.COMPLETED
    jt.loadJob(j)
    const result = await jt.wait(99)
    expect(result).toBe(j)
    expect(result.status).toBe(JobStatus.COMPLETED)
  })

  it('sets KILLED status on abort error', async () => {
    const jt = new JobTable()
    const { task, abort } = pending()
    const j = jt.submit({ command: 'sleep', task, abort, cwd: '/' })
    // Kick off wait before killing
    const waiter = jt.wait(j.id)
    jt.kill(j.id) // sets killed + aborts
    const result = await waiter
    expect(result.status).toBe(JobStatus.KILLED)
  })

  it('sets COMPLETED + exitCode 1 on other errors', async () => {
    const jt = new JobTable()
    const failing = Promise.reject<JobTaskResult>(new Error('boom'))
    const j = jt.submit({ command: 'a', task: failing, abort: new AbortController(), cwd: '/' })
    const result = await jt.wait(j.id)
    expect(result.status).toBe(JobStatus.COMPLETED)
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toBe('boom')
  })

  it('throws on unknown id', async () => {
    const jt = new JobTable()
    await expect(jt.wait(99)).rejects.toThrow(/unknown job/)
  })
})

// Port of tests/shell/test_background_jobs.py::test_wait_all_survives_failing_task.
describe('JobTable.waitAll', () => {
  it('survives a failing task — mixed success/failure both land in the table', async () => {
    const jt = new JobTable()
    const failing = Promise.reject<JobTaskResult>(new Error('resource API error'))
    const succeeding = settled([
      new TextEncoder().encode('hello'),
      new IOResult(),
      new ExecutionNode({ command: 'echo hello', exitCode: 0 }),
    ])
    const bad = jt.submit({ command: 'bad', task: failing, abort: new AbortController(), cwd: '/' })
    const good = jt.submit({
      command: 'good',
      task: succeeding,
      abort: new AbortController(),
      cwd: '/',
    })
    const jobs = await jt.waitAll()
    expect(jobs).toHaveLength(2)
    const badJob = jt.get(bad.id)
    const goodJob = jt.get(good.id)
    expect(badJob?.exitCode).toBe(1)
    expect(new TextDecoder().decode(badJob?.stderr)).toContain('resource API error')
    expect(goodJob?.exitCode).toBe(0)
    expect(new TextDecoder().decode(goodJob?.stdout)).toBe('hello')
  })
})

describe('JobTable.popCompleted', () => {
  it('removes completed/killed jobs from the table', async () => {
    const jt = new JobTable()
    const j1 = jt.submit({
      command: 'a',
      task: settled([null, new IOResult(), new ExecutionNode()]),
      abort: new AbortController(),
      cwd: '/',
    })
    const { task, abort } = pending()
    jt.submit({ command: 'b', task, abort, cwd: '/' })
    await jt.wait(j1.id)
    const popped = jt.popCompleted()
    expect(popped).toHaveLength(1)
    expect(jt.listJobs()).toHaveLength(1)
  })
})
