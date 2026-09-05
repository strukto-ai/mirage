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

import { beforeAll, describe, expect, it } from 'vitest'
import { IOResult } from '../../io/types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { Channel } from '../../shell/console/index.ts'
import { type JobResult, type JobRunner, JobStatus, JobTable } from '../../shell/job_table/index.ts'
import type { ShellParser } from '../../shell/parse/index.ts'
import { MountMode } from '../../types.ts'
import { getTestParser, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { ExecutionNode } from '../types.ts'
import { handleJobs, handleKill, handlePs, handleWait } from './jobs.ts'

/** A runner that finishes immediately with no output. */
const quiet: JobRunner = () => Promise.resolve([new IOResult(), new ExecutionNode()] as JobResult)

/** A runner that never finishes on its own; only an abort ends it. */
function pendingRun(abort: AbortController): JobRunner {
  return async () => {
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

function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

describe('handleWait', () => {
  it('waits for all jobs when no id given', async () => {
    const jt = new JobTable()
    jt.submit({
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

  it('awaits a specific job and returns its output and exit code', async () => {
    const jt = new JobTable()
    const run: JobRunner = async (job) => {
      await job.console.emit(Channel.STDOUT, new TextEncoder().encode('out'))
      await job.console.emit(Channel.STDERR, new TextEncoder().encode('done'))
      return [new IOResult({ exitCode: 3 }), new ExecutionNode({ command: 'foo', exitCode: 3 })]
    }
    const j = jt.submit({ command: 'foo', run, abort: new AbortController(), cwd: '/' })
    const [resStdout, resIo] = await handleWait(jt, ['wait', j.id.toString()])
    expect(resStdout).toEqual(new TextEncoder().encode('out'))
    expect(resIo.exitCode).toBe(3)
    expect(decode(resIo.stderr as Uint8Array)).toBe('done')
  })

  it('accepts %N job id syntax', async () => {
    const jt = new JobTable()
    const j = jt.submit({
      command: 'foo',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    const [, io] = await handleWait(jt, ['wait', `%${j.id.toString()}`])
    expect(io.exitCode).toBe(0)
  })
})

describe('handleKill', () => {
  it('rejects missing job id arg', async () => {
    const jt = new JobTable()
    const [, io] = await handleKill(jt, ['kill'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/usage/)
  })

  it('rejects non-numeric job id', async () => {
    const jt = new JobTable()
    const [, io] = await handleKill(jt, ['kill', 'abc'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/invalid job id/)
  })

  it('rejects unknown job id', async () => {
    const jt = new JobTable()
    const [, io] = await handleKill(jt, ['kill', '999'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/no such job/)
  })

  it('kills a known job and returns 0', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const task = pendingRun(abort)
    const j = jt.submit({ command: 'sleep', run: task, abort, cwd: '/' })
    const [, io] = await handleKill(jt, ['kill', j.id.toString()])
    expect(io.exitCode).toBe(0)
    expect(jt.get(j.id)?.status).toBe(JobStatus.KILLED)
  })
})

describe('handleJobs', () => {
  it('returns empty output when no jobs', () => {
    const jt = new JobTable()
    const [out, io] = handleJobs(jt, ['jobs'])
    expect((out as Uint8Array).byteLength).toBe(0)
    expect(io.exitCode).toBe(0)
  })

  it('lists jobs with id, status, command', async () => {
    const jt = new JobTable()
    const j = jt.submit({
      command: 'foo',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    const abort = new AbortController()
    const task = pendingRun(abort)
    jt.submit({ command: 'bar', run: task, abort, cwd: '/' })
    await jt.wait(j.id)
    const [out] = handleJobs(jt, ['jobs'])
    const text = decode(out as Uint8Array)
    expect(text).toMatch(/\[1\] completed foo/)
    expect(text).toMatch(/\[2\] running bar/)
  })

  it('removes completed jobs from the table', async () => {
    const jt = new JobTable()
    const j = jt.submit({
      command: 'foo',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    await jt.wait(j.id)
    handleJobs(jt, ['jobs'])
    expect(jt.listJobs()).toHaveLength(0)
  })
})

describe('handlePs', () => {
  it('lists only running jobs', () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const task = pendingRun(abort)
    jt.submit({ command: 'sleep', run: task, abort, cwd: '/' })
    const [out] = handlePs(jt, ['ps'])
    expect(decode(out as Uint8Array)).toMatch(/1\tsleep/)
  })

  it('returns empty output when no running jobs', () => {
    const jt = new JobTable()
    const [out] = handlePs(jt, ['ps'])
    expect((out as Uint8Array).byteLength).toBe(0)
  })
})

// `&` inside a compound body launches a job, as it does at top level.

let parser: ShellParser

beforeAll(async () => {
  parser = await getTestParser()
})

function buildWs(): Workspace {
  return new Workspace(
    { '/m': [new RAMResource(), MountMode.WRITE] },
    { mode: MountMode.WRITE, shellParser: parser },
  )
}

const BODY_SHAPES = [
  'for i in 1; do false & done',
  'for ((k=0;k<1;k++)); do false & done',
  'n=0; while [ $n -lt 1 ]; do false & n=$((n+1)); done',
  'n=0; until [ $n -ge 1 ]; do false & n=$((n+1)); done',
  'if true; then false & fi',
  'if false; then :; elif true; then false & fi',
  'if false; then :; else false & fi',
  'case x in x) false & ;; esac',
  '{ false & }',
  'f() { false & }; f',
]

describe('& inside a compound body', () => {
  it.each(BODY_SHAPES)('launches a job with launch status 0: %s', async (line) => {
    const ws = buildWs()
    const io = await ws.execute(`${line}; echo rc=$?`)
    expect(stdoutStr(io)).toBe('rc=0\n')
    const job = ws.jobTable.get(1)
    expect(job?.command).toBe('false')
    await ws.jobTable.wait(1)
    expect(job?.exitCode).toBe(1)
  })

  it('leaves loop-body jobs running when the loop ends', async () => {
    const ws = buildWs()
    const io = await ws.execute('for i in 1 2; do sleep 0.3 & done; jobs')
    expect(stdoutStr(io)).toBe('[1] running sleep 0.3\n[2] running sleep 0.3\n')
    await ws.execute('wait')
    expect(stdoutStr(await ws.execute('jobs'))).toBe('')
  })

  it('wait adopts loop-body jobs in id order, after the foreground line', async () => {
    const ws = buildWs()
    const io = await ws.execute('for i in 1 2; do echo $i & done; echo launched; wait')
    expect(stdoutStr(io)).toBe('launched\n1\n2\n')
  })

  it('$! names each loop-body job', async () => {
    const ws = buildWs()
    const io = await ws.execute('for i in 1 2; do sleep 0.1 & echo $!; done; wait')
    expect(stdoutStr(io)).toBe('1\n2\n')
  })

  it('errexit does not trip on a body launch', async () => {
    const ws = buildWs()
    const io = await ws.execute('set -e; for i in 1; do false & done; echo ok; wait')
    expect(stdoutStr(io)).toBe('ok\n')
  })
})
