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
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Channel } from '../../shell/console/index.ts'
import { JobStatus } from '../../shell/job_table/index.ts'
import type { ShellParser } from '../../shell/parse/index.ts'
import { MountMode, type PathSpec } from '../../types.ts'
import { eacces } from '../../utils/errors.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

const DEC = new TextDecoder()

let parser: ShellParser

beforeAll(async () => {
  parser = await getTestParser()
})

function buildWs(): Workspace {
  return new Workspace(
    { '/m': [new RAMVFS(), MountMode.WRITE] },
    { mode: MountMode.WRITE, shellParser: parser },
  )
}

/** Run a backgrounded command and return its finished console. */
async function runBg(cmd: string): Promise<{ out: string; err: string }> {
  const ws = buildWs()
  await ws.shell(cmd)
  await ws.jobTable.wait(1, ws.sessionManager.defaultId)
  const job = ws.jobTable.get(1, ws.sessionManager.defaultId)
  if (job === null) throw new Error('job 1 missing')
  return {
    out: DEC.decode(await job.console.snapshot(Channel.STDOUT)),
    err: DEC.decode(await job.console.snapshot(Channel.STDERR)),
  }
}

describe('streaming: output lands while the job is still running', () => {
  it('streams each loop iteration instead of batching at the end', async () => {
    const ws = buildWs()
    await ws.shell('for i in 1 2 3; do echo $i; sleep 0.25; done &')
    const job = ws.jobTable.get(1, ws.sessionManager.defaultId)
    if (job === null) throw new Error('job 1 missing')

    await new Promise((resolve) => setTimeout(resolve, 350))
    const mid = DEC.decode(await job.console.snapshot(Channel.STDOUT))

    await ws.jobTable.wait(1, ws.sessionManager.defaultId)
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
    await ws.shell('echo hi > /m/f.txt &')
    await ws.jobTable.wait(1, ws.sessionManager.defaultId)
    const job = ws.jobTable.get(1, ws.sessionManager.defaultId)
    if (job === null) throw new Error('job 1 missing')
    expect(DEC.decode(await job.console.snapshot(Channel.STDOUT))).toBe('')
    const res = await ws.shell('cat /m/f.txt')
    expect(res.stdoutText).toBe('hi\n')
  })

  it('routes stderr to its own channel', async () => {
    const { out, err } = await runBg('echo err >&2 &')
    expect(out).toBe('')
    expect(err).toBe('err\n')
  })
})

describe('job output reaches the session terminal as it is written', () => {
  // A job writes to the terminal its shell writes to, as bash's does: the
  // line running when it wrote shows it, or the next one does, and `wait`
  // has nothing left to print.
  it('reaches the lines once, and wait prints none', async () => {
    const ws = buildWs()
    const lines = [
      await ws.shell('echo a &'),
      await ws.shell('echo b &'),
      await ws.shell('wait'),
      await ws.shell('true'),
    ]
    expect(lines.map((line) => line.stdoutText).join('')).toBe('a\nb\n')
  })

  it('shows a line its jobs in the order they wrote', async () => {
    const ws = buildWs()
    const res = await ws.shell('(sleep 0.05; echo bg) & for i in 1 2; do echo $i; sleep 0.1; done')
    expect(res.stdoutText).toBe('1\nbg\n2\n')
  })

  it('returns nothing and exit 0 when there are no jobs', async () => {
    const ws = buildWs()
    const res = await ws.shell('wait')
    expect(res.stdoutText).toBe('')
    expect(res.exitCode).toBe(0)
  })

  // A nested job writes where the job that started it writes, its stdout,
  // so that job's console and the terminal both show the two in the order
  // they were written (bash's `b` then `a`).
  it('writes a job nested in a backgrounded subshell through its job', async () => {
    const ws = buildWs()
    await ws.shell('( (sleep 0.15; echo a) & echo b & wait ) &')
    await ws.jobTable.wait(1, ws.sessionManager.defaultId)
    const job = ws.jobTable.get(1, ws.sessionManager.defaultId)
    if (job === null) throw new Error('job 1 missing')
    expect(DEC.decode(await job.console.snapshot(Channel.STDOUT))).toBe('b\na\n')
    expect((await ws.shell('true')).stdoutText).toBe('b\na\n')
  })
})

/** Make each file's first write take 0.2 s, as a remote mount's can. */
function slowFirstWrites(ws: Workspace): void {
  type Dispatch = (op: string, path: PathSpec, ...rest: unknown[]) => Promise<unknown>
  const dispatcher = (ws as unknown as { dispatcher: { dispatch: Dispatch } }).dispatcher
  const inner = dispatcher.dispatch.bind(dispatcher)
  const seen = new Set<string>()
  dispatcher.dispatch = async (op, path, ...rest) => {
    const key = `${op} ${path.virtual}`
    if (['write', 'append', 'pwrite'].includes(op) && !seen.has(key)) {
      seen.add(key)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return inner(op, path, ...rest)
  }
}

async function slowly(line: string): Promise<string> {
  const ws = buildWs()
  slowFirstWrites(ws)
  return (await ws.shell(line)).stdoutText
}

/** Make every write fail after 0.2 s, as a remote mount's can. */
function failingSlowWrites(ws: Workspace): void {
  type Dispatch = (op: string, path: PathSpec, ...rest: unknown[]) => Promise<unknown>
  const dispatcher = (ws as unknown as { dispatcher: { dispatch: Dispatch } }).dispatcher
  const inner = dispatcher.dispatch.bind(dispatcher)
  dispatcher.dispatch = async (op, path, ...rest) => {
    if (['write', 'append', 'pwrite'].includes(op)) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      throw eacces(path)
    }
    return inner(op, path, ...rest)
  }
}

describe('a job writing through its redirect', () => {
  it('keeps both when it writes while the redirect opens the file', async () => {
    expect(
      await slowly('{ echo first; (sleep .05; echo second) & } > /m/out; wait; cat /m/out'),
    ).toBe('first\nsecond\n')
  })

  it('keeps every line when jobs write one file at once', async () => {
    expect(
      await slowly(
        '{ echo a; (sleep .3; echo b) & (sleep .3; echo c) & } > /m/out; wait; sort /m/out',
      ),
    ).toBe('a\nb\nc\n')
  })

  it('writes after what the redirect held, in every file', async () => {
    expect(
      await slowly(
        '{ echo a; echo b >&2; (sleep .05; echo c >&2) & } > /m/out 2> /m/err; wait; cat /m/err',
      ),
    ).toBe('b\nc\n')
  })

  it('leaves the line running when a held write fails', async () => {
    const ws = buildWs()
    failingSlowWrites(ws)
    const result = await ws.shell(
      '{ echo first; (sleep .05; echo job) & } > /m/out; echo next=$?; wait',
    )
    expect(result.stdoutText).toBe('next=1\n')
  })

  it('writes the file after its redirect is aborted', async () => {
    const ws = buildWs()
    const abort = new AbortController()
    setTimeout(() => {
      abort.abort()
    }, 50)
    await expect(
      ws.shell('{ { sleep .1; echo late; } & sleep 5; } > /m/out', { signal: abort.signal }),
    ).rejects.toThrow()
    expect((await ws.shell('sleep .3; cat /m/out')).stdoutText).toBe('late\n')
  })
})

describe('kill reaches a real running command', () => {
  it('stops a job that is already mid-flight, not one still queued', async () => {
    const ws = buildWs()
    // Grouped, so `&` backgrounds the whole sequence rather than only
    // the last command.
    await ws.shell('(echo started; sleep 10; echo never) &')
    const job = ws.jobTable.get(1, ws.sessionManager.defaultId)
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
    await ws.shell('kill %1')
    const elapsed = Date.now() - started

    expect(job.status).toBe(JobStatus.KILLED)
    expect(DEC.decode(await job.console.snapshot(Channel.STDOUT))).not.toContain('never')
    // Without a signal reaching the executor this waits the full 10s
    // for `sleep` to finish on its own.
    expect(elapsed).toBeLessThan(3000)
  })
})

// `timeout N tail -f` cannot show partial output: the line barrier
// materializes stdout before `timeout` drains it. A job is the shape that
// works, and the one an agent reaches for: the console shows each line as
// the file gains it, and `kill` ends the follow.
it('a followed tail streams to its job console until killed', async () => {
  const ws = buildWs()
  ws.createSession('writer')
  await ws.shell("printf 'l1\\n' > /m/log")
  await ws.shell('tail -f -s 0.05 /m/log &')
  await new Promise((resolve) => setTimeout(resolve, 150))
  await ws.shell("printf 'l2\\n' >> /m/log", { sessionId: 'writer' })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const job = ws.jobTable.get(1, ws.sessionManager.defaultId)
  expect(job?.status).toBe(JobStatus.RUNNING)
  expect(new TextDecoder().decode(await job?.console.snapshot(Channel.STDOUT))).toBe('l1\nl2\n')
  expect((await ws.shell('kill %1')).exitCode).toBe(0)
  await ws.close()
})
