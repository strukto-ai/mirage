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
import { RAMResource } from '../../resource/ram/ram.ts'
import { Channel } from '../../shell/console/index.ts'
import { JobStatus } from '../../shell/job_table/index.ts'
import type { ShellParser } from '../../shell/parse/index.ts'
import { MountMode } from '../../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

const DEC = new TextDecoder()

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

/** Run a backgrounded command and return its finished console. */
async function runBg(cmd: string): Promise<{ out: string; err: string }> {
  const ws = buildWs()
  await ws.execute(cmd)
  await ws.jobTable.wait(1)
  const job = ws.jobTable.get(1)
  if (job === null) throw new Error('job 1 missing')
  return {
    out: DEC.decode(await job.console.snapshot(Channel.STDOUT)),
    err: DEC.decode(await job.console.snapshot(Channel.STDERR)),
  }
}

describe('streaming: output lands while the job is still running', () => {
  it('streams each loop iteration instead of batching at the end', async () => {
    const ws = buildWs()
    await ws.execute('for i in 1 2 3; do echo $i; sleep 0.25; done &')
    const job = ws.jobTable.get(1)
    if (job === null) throw new Error('job 1 missing')

    await new Promise((resolve) => setTimeout(resolve, 350))
    const mid = DEC.decode(await job.console.snapshot(Channel.STDOUT))

    await ws.jobTable.wait(1)
    const end = DEC.decode(await job.console.snapshot(Channel.STDOUT))

    expect(end).toBe('1\n2\n3\n')
    // Without the sink the whole construct is pumped at completion, so
    // a mid-run snapshot is empty.
    expect(mid).not.toBe('')
    expect(end.startsWith(mid)).toBe(true)
    expect(mid).not.toBe(end)
  })

  it.each([
    ['echo one && echo two &', 'one\ntwo\n'],
    ['(echo s1; echo s2) &', 's1\ns2\n'],
    ['if true; then echo yes; fi &', 'yes\n'],
    ['i=0; while [ $i -lt 2 ]; do echo w$i; i=$((i+1)); done &', 'w0\nw1\n'],
    ['for i in a b; do echo $i; done &', 'a\nb\n'],
  ])('feeds the console for %s', async (cmd, expected) => {
    const { out } = await runBg(cmd)
    expect(out).toBe(expected)
  })
})

describe('capture sites: a sink must never leak into a captured value', () => {
  it('does not leak command substitution', async () => {
    const { out } = await runBg('echo $(echo inner) &')
    expect(out).toBe('inner\n')
  })

  it('does not leak intermediate pipe stages', async () => {
    const { out } = await runBg("printf 'a\\nb\\n' | grep b &")
    expect(out).toBe('b\n')
  })

  it('sends redirected output to the file, not the console', async () => {
    const ws = buildWs()
    await ws.execute('echo hi > /m/f.txt &')
    await ws.jobTable.wait(1)
    const job = ws.jobTable.get(1)
    if (job === null) throw new Error('job 1 missing')
    expect(DEC.decode(await job.console.snapshot(Channel.STDOUT))).toBe('')
    const res = await ws.execute('cat /m/f.txt')
    expect(res.stdoutText).toBe('hi\n')
  })

  it('routes stderr to its own channel', async () => {
    const { out, err } = await runBg('echo err >&2 &')
    expect(out).toBe('')
    expect(err).toBe('err\n')
  })
})

describe('bare wait adopts job output', () => {
  // A real shell has nothing to adopt because its jobs share the
  // terminal. Mirage jobs print to their console, so bare `wait` has to
  // surface it or the output is stranded.
  it('surfaces every job in id order', async () => {
    const ws = buildWs()
    await ws.execute('echo a &')
    await ws.execute('echo b &')
    const res = await ws.execute('wait')
    expect(res.stdoutText).toBe('a\nb\n')
  })

  it('returns nothing and exit 0 when there are no jobs', async () => {
    const ws = buildWs()
    const res = await ws.execute('wait')
    expect(res.stdoutText).toBe('')
    expect(res.exitCode).toBe(0)
  })

  // A job started inside a backgrounded subshell has to reach its own
  // console, not the enclosing job's. The subshell's executor closure is
  // the only one built by hand, so it is the only one that can drop the
  // per-call opts carrying that console; when it does, both nested jobs
  // write straight to the outer console and bare `wait` adopts nothing,
  // which turns the documented job-id order into completion order.
  it('gives a job nested in a backgrounded subshell its own console', async () => {
    const ws = buildWs()
    await ws.execute('( (sleep 0.15; echo a) & echo b & wait ) &')
    await ws.jobTable.wait(1)
    const job = ws.jobTable.get(1)
    if (job === null) throw new Error('job 1 missing')
    expect(DEC.decode(await job.console.snapshot(Channel.STDOUT))).toBe('a\nb\n')
  })
})

describe('kill reaches a real running command', () => {
  it('stops a job that is already mid-flight, not one still queued', async () => {
    const ws = buildWs()
    // Grouped, so `&` backgrounds the whole sequence rather than only
    // the last command.
    await ws.execute('(echo started; sleep 10; echo never) &')
    const job = ws.jobTable.get(1)
    if (job === null) throw new Error('job 1 missing')

    // Wait until the job is genuinely inside the long command. Killing
    // before it starts would pass on the entry check alone and prove
    // nothing about aborting work in progress.
    const deadline = Date.now() + 3000
    while (DEC.decode(await job.console.snapshot(Channel.STDOUT)) === '') {
      if (Date.now() > deadline) throw new Error('job never started')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const started = Date.now()
    await ws.execute('kill %1')
    const elapsed = Date.now() - started

    expect(job.status).toBe(JobStatus.KILLED)
    expect(DEC.decode(await job.console.snapshot(Channel.STDOUT))).not.toContain('never')
    // Without a signal reaching the executor this waits the full 10s
    // for `sleep` to finish on its own.
    expect(elapsed).toBeLessThan(3000)
  })
})
