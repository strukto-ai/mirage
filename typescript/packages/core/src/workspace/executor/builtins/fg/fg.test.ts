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
import { IOResult } from '../../../../io/types.ts'
import { Channel, JobConsole } from '../../../../shell/console/index.ts'
import { type JobRunner, JobTable } from '../../../../execution/job/index.ts'
import { ExecutionNode } from '../../../types.ts'
import { handleFg } from './fg.ts'
import { pendingRun, quiet } from '../../../../../tests/workspace/fixtures/job_runners.ts'

function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

describe('handleFg without an operand', () => {
  // A background job can end before `fg` runs; it is still the current job,
  // as `fg %N` would find it.
  it('takes a job that already finished', async () => {
    const jt = new JobTable()
    const run: JobRunner = async (job) => {
      await job.console.emit(Channel.STDOUT, new TextEncoder().encode('body'))
      return [new IOResult({ exitCode: 3 }), new ExecutionNode({ command: 'quick', exitCode: 3 })]
    }
    const job = await jt.submit({ command: 'quick', run, abort: new AbortController(), cwd: '/' })
    await jt.wait(job.id)
    const [stdout, io] = await handleFg(jt, ['fg'])
    expect(decode(stdout as Uint8Array)).toBe('quick\n')
    expect(io.exitCode).toBe(3)
  })

  // bash's current job is the newest one still running; a finished job
  // answers only when nothing runs. The older job holds until fg has picked,
  // which it has done by the next turn.
  it('prefers a running job to a finished one', async () => {
    const jt = new JobTable()
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const late: JobRunner = async (job) => {
      await gate
      await job.console.emit(Channel.STDOUT, new TextEncoder().encode('late'))
      return [new IOResult(), new ExecutionNode({ command: 'older' })]
    }
    await jt.submit({ command: 'older', run: late, abort: new AbortController(), cwd: '/' })
    const done = await jt.submit({
      command: 'newer',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    await jt.wait(done.id)
    const fg = handleFg(jt, ['fg'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    const [stdout] = await fg
    expect(decode(stdout as Uint8Array)).toBe('older\n')
  })
})

describe('handleFg with a sink', () => {
  it('writes the command line before it blocks', async () => {
    const jt = new JobTable()
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held: JobRunner = async (job) => {
      await gate
      await job.console.emit(Channel.STDOUT, new TextEncoder().encode('late'))
      return [new IOResult(), new ExecutionNode({ command: 'held' })]
    }
    await jt.submit({ command: 'held', run: held, abort: new AbortController(), cwd: '/' })
    const sink = new JobConsole()
    const fg = handleFg(jt, ['fg'], null, null, undefined, sink)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(decode(await sink.snapshot(Channel.STDOUT))).toBe('held\n')
    release()
    const [stdout] = await fg
    expect(stdout).toBeNull()
  })
})

describe('handleFg with an invocation signal', () => {
  it('releases the caller on abort and leaves the job running', async () => {
    const jt = new JobTable()
    const jobAbort = new AbortController()
    await jt.submit({ command: 'a', run: pendingRun(jobAbort), abort: jobAbort, cwd: '/' })
    const controller = new AbortController()
    const waiting = handleFg(jt, ['fg'], null, null, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(jt.listJobs()[0]?.state).toBe('running')
    jobAbort.abort()
    await jt.waitAll()
  })
})
