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
import { Channel } from '../../../../shell/console/index.ts'
import { type JobRunner, JobTable } from '../../../../execution/job/index.ts'
import { ExecutionNode } from '../../../types.ts'
import { handleWait } from './wait.ts'
import { pendingRun, quiet } from '../../../../../tests/workspace/fixtures/job_runners.ts'

function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

describe('handleWait', () => {
  it('waits for all jobs when no id given', async () => {
    const jt = new JobTable()
    await jt.submit({
      command: 'a',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    const [, io, exec] = await handleWait(jt, ['wait'])
    expect(io.exitCode).toBe(0)
    expect(exec.command).toBe('wait')
    // Bare `wait` reaps, so nothing is left to wait on afterwards.
    expect(jt.listJobs()).toHaveLength(0)
  })

  it('rejects non-numeric job id', async () => {
    const jt = new JobTable()
    const [, io] = await handleWait(jt, ['wait', 'abc'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/not a pid or valid job spec/)
  })

  it('rejects unknown job id', async () => {
    const jt = new JobTable()
    const [, io] = await handleWait(jt, ['wait', '999'])
    expect(io.exitCode).toBe(127)
    expect(decode(io.stderr as Uint8Array)).toMatch(/not a child of this shell/)
  })

  it('awaits a specific job, answers its status and prints nothing', async () => {
    const jt = new JobTable()
    const run: JobRunner = async (job) => {
      await job.console.emit(Channel.STDOUT, new TextEncoder().encode('out'))
      await job.console.emit(Channel.STDERR, new TextEncoder().encode('done'))
      return [new IOResult({ exitCode: 3 }), new ExecutionNode({ command: 'foo', exitCode: 3 })]
    }
    const j = await jt.submit({ command: 'foo', run, abort: new AbortController(), cwd: '/' })
    const [resStdout, resIo] = await handleWait(jt, ['wait', j.id.toString()])
    expect(resStdout).toBeNull()
    expect(resIo.exitCode).toBe(3)
    expect(resIo.stderr).toBeNull()
  })

  it('accepts %N job id syntax', async () => {
    const jt = new JobTable()
    const j = await jt.submit({
      command: 'foo',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    const [, io] = await handleWait(jt, ['wait', `%${j.id.toString()}`])
    expect(io.exitCode).toBe(0)
  })
})

describe('handleWait with an invocation signal', () => {
  it('releases the caller on abort and leaves the job running', async () => {
    const jt = new JobTable()
    const jobAbort = new AbortController()
    await jt.submit({ command: 'a', run: pendingRun(jobAbort), abort: jobAbort, cwd: '/' })
    const controller = new AbortController()
    const waiting = handleWait(jt, ['wait'], null, null, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(jt.listJobs()[0]?.state).toBe('running')
    jobAbort.abort()
    await jt.waitAll()
  })
})
