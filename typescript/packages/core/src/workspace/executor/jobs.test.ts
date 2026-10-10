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
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Channel, JobConsole } from '../../shell/console/index.ts'
import { type JobResult, type JobRunner, JobStatus, JobTable } from '../../shell/job_table/index.ts'
import type { ShellParser } from '../../shell/parse/index.ts'
import { MountMode } from '../../types.ts'
import { getTestParser, stdoutStr, stderrStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { ExecutionNode } from '../types.ts'
import { handleFg, handleJobs, handleKill, handlePs, handleWait } from './jobs.ts'

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

  it('awaits a specific job, answers its status and prints nothing', async () => {
    const jt = new JobTable()
    const run: JobRunner = async (job) => {
      await job.console.emit(Channel.STDOUT, new TextEncoder().encode('out'))
      await job.console.emit(Channel.STDERR, new TextEncoder().encode('done'))
      return [new IOResult({ exitCode: 3 }), new ExecutionNode({ command: 'foo', exitCode: 3 })]
    }
    const j = jt.submit({ command: 'foo', run, abort: new AbortController(), cwd: '/' })
    const [resStdout, resIo] = await handleWait(jt, ['wait', j.id.toString()])
    expect(resStdout).toBeNull()
    expect(resIo.exitCode).toBe(3)
    expect(resIo.stderr).toBeNull()
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

const KILL_USAGE =
  'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n'

describe('handleKill', () => {
  it.each([
    [[], 2, KILL_USAGE],
    [['-9'], 2, KILL_USAGE],
    [['--'], 2, KILL_USAGE],
    [['-?'], 2, KILL_USAGE],
    [['-s'], 1, 'bash: kill: -s: option requires an argument\n'],
    [['-n'], 1, 'bash: kill: -n: option requires an argument\n'],
    [['-FOO'], 1, 'bash: kill: FOO: invalid signal specification\n'],
    [['-s', 'FOO', '1'], 1, 'bash: kill: FOO: invalid signal specification\n'],
    [['-65', '1'], 1, 'bash: kill: 65: invalid signal specification\n'],
    [['abc'], 1, 'bash: kill: abc: arguments must be process or job IDs\n'],
    [['0x1'], 1, 'bash: kill: 0x1: arguments must be process or job IDs\n'],
    [['--', '-'], 1, 'bash: kill: -: arguments must be process or job IDs\n'],
    [[''], 1, "bash: kill: `': not a pid or valid job spec\n"],
    [['999'], 1, 'bash: kill: (999) - No such process\n'],
    [['-0', '999'], 1, 'bash: kill: (999) - No such process\n'],
    [['%3'], 1, 'bash: kill: %3: no such job\n'],
    [['%abc'], 1, 'bash: kill: %abc: no such job\n'],
    [
      ['999', '998'],
      1,
      'bash: kill: (999) - No such process\nbash: kill: (998) - No such process\n',
    ],
  ] as const)('refuses %j in bash words', async (args, code, stderr) => {
    const [, io] = await handleKill(new JobTable(), ['kill', ...args])
    expect([io.exitCode, decode(io.stderr as Uint8Array)]).toEqual([code, stderr])
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

  it.each(['true && ps < /m/f | cat', 'ps | cat 2>/dev/null', 'true && ps | cat 2>/dev/null'])(
    'lists the stages of a pipeline under a redirect: %s',
    async (line) => {
      const ws = buildWs()
      try {
        await ws.shell('echo x > /m/f')
        const rows = stdoutStr(await ws.shell(line))
          .trim()
          .split('\n')
        const commands = rows.map((row) => row.split('\t')[1])
        expect(commands).toEqual(expect.arrayContaining(['ps', 'cat']))
      } finally {
        await ws.close()
      }
    },
  )
})

describe('handleWait with an invocation signal', () => {
  it('releases the caller on abort and leaves the job running', async () => {
    const jt = new JobTable()
    const jobAbort = new AbortController()
    jt.submit({ command: 'a', run: pendingRun(jobAbort), abort: jobAbort, cwd: '/' })
    const controller = new AbortController()
    const waiting = handleWait(jt, ['wait'], null, null, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(jt.listJobs()[0]?.status).toBe(JobStatus.RUNNING)
    jobAbort.abort()
    await jt.waitAll()
  })
})

describe('handleFg without an operand', () => {
  // A background job can end before `fg` runs; it is still the current job,
  // as `fg %N` would find it.
  it('takes a job that already finished', async () => {
    const jt = new JobTable()
    const run: JobRunner = async (job) => {
      await job.console.emit(Channel.STDOUT, new TextEncoder().encode('body'))
      return [new IOResult({ exitCode: 3 }), new ExecutionNode({ command: 'quick', exitCode: 3 })]
    }
    const job = jt.submit({ command: 'quick', run, abort: new AbortController(), cwd: '/' })
    await jt.wait(job.id)
    const [stdout, io] = await handleFg(jt, ['fg'])
    expect(decode(stdout as Uint8Array)).toBe('quick\n')
    expect(io.exitCode).toBe(3)
  })

  // bash's current job is the newest one still running; a finished job
  // answers only when nothing runs. The older job holds until fg has picked,
  // which it does before its first await.
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
    jt.submit({ command: 'older', run: late, abort: new AbortController(), cwd: '/' })
    const done = jt.submit({ command: 'newer', run: quiet, abort: new AbortController(), cwd: '/' })
    await jt.wait(done.id)
    const fg = handleFg(jt, ['fg'])
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
    jt.submit({ command: 'held', run: held, abort: new AbortController(), cwd: '/' })
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
    jt.submit({ command: 'a', run: pendingRun(jobAbort), abort: jobAbort, cwd: '/' })
    const controller = new AbortController()
    const waiting = handleFg(jt, ['fg'], null, null, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(jt.listJobs()[0]?.status).toBe(JobStatus.RUNNING)
    jobAbort.abort()
    await jt.waitAll()
  })
})

// `&` inside a compound body launches a job, as it does at top level.

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
    const io = await ws.shell(`${line}; echo rc=$?`)
    expect(stdoutStr(io)).toBe('rc=0\n')
    const job = ws.jobTable.get(1, ws.sessionManager.defaultId)
    expect(job?.command).toBe('false')
    await ws.jobTable.wait(1, ws.sessionManager.defaultId)
    expect(job?.exitCode).toBe(1)
  })

  it('leaves loop-body jobs running when the loop ends', async () => {
    const ws = buildWs()
    const io = await ws.shell('for i in 1 2; do sleep 0.3 & done; jobs')
    expect(stdoutStr(io)).toBe('[1] running sleep 0.3\n[2] running sleep 0.3\n')
    await ws.shell('wait')
    expect(stdoutStr(await ws.shell('jobs'))).toBe('')
  })

  it('loop-body jobs write after the foreground line', async () => {
    const ws = buildWs()
    const io = await ws.shell(
      'for i in 1 2; do { sleep 0.05; echo $i; } & done; echo launched; wait',
    )
    expect(stdoutStr(io)).toBe('launched\n1\n2\n')
  })

  it('$! names each loop-body job', async () => {
    const ws = buildWs()
    const io = await ws.shell('for i in 1 2; do sleep 0.1 & echo $!; done; wait')
    const pids = stdoutStr(io).trim().split('\n').map(Number)
    expect(pids).toHaveLength(2)
    expect(pids[1]).toBeGreaterThan(pids[0] ?? 0)
  })

  it('errexit does not trip on a body launch', async () => {
    const ws = buildWs()
    const io = await ws.shell('set -e; for i in 1; do false & done; echo ok; wait')
    expect(stdoutStr(io)).toBe('ok\n')
  })
})

describe('background conditions and function scope', () => {
  it.each<[string, string, number]>([
    ['if false & then echo yes; else echo no; fi; wait "$!"', 'yes\n', 1],
    ['if false; then echo no; elif false & then echo yes; fi; wait "$!"', 'yes\n', 1],
    ['while false & do echo yes; break; done; wait "$!"', 'yes\n', 1],
    ['until false & do echo no; break; done; echo yes; wait "$!"', 'yes\n', 1],
    [
      'f() { { sleep 0.05; printf "%s:%s:%s\\n" "$1" "$#" "$*"; } & }; f first second; wait',
      'first:2:first second\n',
      0,
    ],
    [
      'f() { { sleep 0.05; printf "%s:%s\\n" "$1" "$#"; } & shift; }; f first second; wait',
      'first:2\n',
      0,
    ],
    [
      'f() { { shift; sleep 0.05; printf "bg:%s:%s\\n" "$1" "$#"; } & sleep 0.1; printf "fg:%s:%s\\n" "$1" "$#"; wait; }; f first second',
      'bg:second:1\nfg:first:2\n',
      0,
    ],
    ['f() { return 7 & j=$!; wait "$j"; }; f', '', 7],
    ['f() { { sleep 0.05; return 9; } & }; f; wait "$!"', '', 9],
    ['f() { false; return & j=$!; wait "$j"; }; f', '', 1],
  ])('%s', async (line, expected, code) => {
    const ws = buildWs()
    try {
      const result = await ws.shell(line)
      expect(stdoutStr(result)).toBe(expected)
      expect(stderrStr(result)).toBe('')
      expect(result.exitCode).toBe(code)
    } finally {
      await ws.close()
    }
  })
})

describe('jobs are scoped to the session that launched them', () => {
  it('another session sees no job and cannot wait on it', async () => {
    const ws = buildWs()
    ws.createSession('a')
    ws.createSession('b')
    try {
      await ws.shell('sleep 30 &', { sessionId: 'a' })
      expect(stdoutStr(await ws.shell('jobs', { sessionId: 'b' }))).toBe('')
      expect(stdoutStr(await ws.shell('jobs', { sessionId: 'a' }))).toContain('[1]')
      const io = await ws.shell('wait %1', { sessionId: 'b' })
      expect(io.exitCode).toBe(127)
      expect(stderrStr(io)).toContain('no such job')
      expect(stdoutStr(await ws.shell('ps', { sessionId: 'b' }))).not.toContain('sleep 30')
      expect((await ws.shell('kill %1', { sessionId: 'a' })).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('closing a session purges its jobs', async () => {
    const ws = buildWs()
    ws.createSession('a')
    try {
      await ws.shell('sleep 30 &', { sessionId: 'a' })
      await ws.shell('sleep 30 &', { sessionId: 'a' })
      const old = ws.jobTable.get(2, 'a')
      expect(old).not.toBeNull()
      await ws.closeSession('a')
      expect(old?.status).toBe(JobStatus.KILLED)
      expect(ws.jobTable.listJobs('a')).toEqual([])
      // A session reusing the id starts from one and inherits nothing.
      ws.createSession('a')
      expect(stdoutStr(await ws.shell('jobs', { sessionId: 'a' }))).toBe('')
      expect(
        Number(stdoutStr(await ws.shell('sleep 30 & echo $!', { sessionId: 'a' }))),
      ).toBeGreaterThan(old?.process?.info.pid ?? 0)
      expect(ws.jobTable.get(1, 'a')).not.toBeNull()
      const io = await ws.shell('wait %2', { sessionId: 'a' })
      expect(io.exitCode).toBe(127)
      expect(stderrStr(io)).toContain('no such job')
    } finally {
      await ws.close()
    }
  })

  it("closing the other sessions keeps the default one's jobs", async () => {
    const ws = buildWs()
    ws.createSession('a')
    ws.createSession('b')
    try {
      await ws.shell('sleep 30 &')
      await ws.shell('sleep 30 &', { sessionId: 'a' })
      await ws.shell('sleep 30 &', { sessionId: 'b' })
      await ws.closeSession('a')
      await ws.closeSession('b')
      expect(ws.jobTable.listJobs('a')).toEqual([])
      expect(ws.jobTable.listJobs('b')).toEqual([])
      const kept = ws.jobTable.get(1, ws.sessionManager.defaultId)
      expect(kept?.status).toBe(JobStatus.RUNNING)
    } finally {
      await ws.close()
    }
  })

  it('each session numbers its jobs from one', async () => {
    const ws = buildWs()
    ws.createSession('a')
    ws.createSession('b')
    try {
      const firstA = await ws.shell('sleep 30 & echo $!', { sessionId: 'a' })
      const firstB = await ws.shell('sleep 30 & echo $!', { sessionId: 'b' })
      const secondA = await ws.shell('sleep 30 & echo $!', { sessionId: 'a' })
      expect(new Set([stdoutStr(firstA), stdoutStr(firstB), stdoutStr(secondA)]).size).toBe(3)
      expect(ws.jobTable.listJobs('a').map((j) => j.id)).toEqual([1, 2])
      expect(ws.jobTable.listJobs('b').map((j) => j.id)).toEqual([1])
    } finally {
      await ws.close()
    }
  })
})

describe('job builtins honor the process profile', () => {
  it('ps and kill reach other sessions as far as the profile says', async () => {
    const ws = buildWs()
    ws.createSession('a')
    ws.createSession('b')
    ws.createSession('audit', { profile: { processes: { list: 'workspace' } } })
    ws.createSession('ops', { profile: { processes: 'workspace' } })
    const count = "ps | grep -c 'sleep 30$'"
    const stop = "kill $(ps | grep 'sleep 30$' | cut -f1); echo rc=$?"
    try {
      const pid = stdoutStr(await ws.shell('sleep 30 & echo $!', { sessionId: 'a' })).trim()
      expect(stdoutStr(await ws.shell(count, { sessionId: 'b' }))).toBe('0\n')
      expect(stdoutStr(await ws.shell(count, { sessionId: 'audit' }))).toBe('1\n')
      const io = await ws.shell(stop, { sessionId: 'audit' })
      expect([stdoutStr(io), new TextDecoder().decode(io.stderr)]).toEqual([
        'rc=1\n',
        `bash: kill: (${pid}) - Operation not permitted\n`,
      ])
      expect(stdoutStr(await ws.shell(stop, { sessionId: 'ops' }))).toBe('rc=0\n')
    } finally {
      await ws.close()
    }
  })

  it('a session at its process cap cannot fork', async () => {
    const ws = buildWs()
    ws.createSession('capped', { profile: { processes: { max: 2 } } })
    const refusal = 'bash: fork: Resource temporarily unavailable\n'
    const run = async (line: string): Promise<[string, string, number]> => {
      const io = await ws.shell(line, { sessionId: 'capped' })
      return [stdoutStr(io), new TextDecoder().decode(io.stderr), io.exitCode]
    }
    try {
      expect(await run('(sleep 30 & echo in); echo sub=$?')).toEqual(['sub=254\n', refusal, 0])
      expect(await run('sleep 30 & echo one')).toEqual(['one\n', '', 0])
      for (const line of ['(echo sub); echo no', 'echo x | cat; echo no', 'sleep 30 & echo no'])
        expect(await run(line)).toEqual(['', refusal, 254])
      expect(await run('echo $?')).toEqual(['254\n', '', 0])
      expect(await run('kill %1')).toEqual(['', '', 0])
      await ws.processes.drain()
      expect(await run('(echo sub)')).toEqual(['sub\n', '', 0])
    } finally {
      await ws.close()
    }
  })

  it('a runaway loop stops at the process cap', async () => {
    const ws = buildWs()
    ws.createSession('capped', { profile: { processes: { max: 3 } } })
    try {
      const io = await ws.shell('n=0; while true; do sleep 30 & n=$((n+1)); done; echo no', {
        sessionId: 'capped',
      })
      expect(io.exitCode).toBe(254)
      expect(stdoutStr(await ws.shell('echo $n; jobs', { sessionId: 'capped' }))).toBe(
        '2\n[1] running sleep 30\n[2] running sleep 30\n',
      )
    } finally {
      await ws.close()
    }
  })
})

it.each(['-TERM', '-15', '-s TERM', '-n 15', '-SIGTERM', '-9'])(
  'ps and kill %s share managed processes',
  async (selector) => {
    const ws = buildWs()
    try {
      const pid = Number(stdoutStr(await ws.shell('sleep 30 & echo $!')))
      const result = await ws.shell(
        `kill -0 ${String(pid)}; echo alive=$?; ps -p${String(pid)} -o pid=,ppid=,comm=`,
      )
      const lines = stdoutStr(result).trimEnd().split('\n')
      expect(lines[0]).toBe('alive=0')
      expect(lines[1]?.trim().split(/\s+/)[0]).toBe(String(pid))
      expect(lines[1]?.trim().split(/\s+/).at(-1)).toBe('sleep')
      expect(stderrStr(result)).toBe('')
      expect(
        stdoutStr(await ws.shell(`ps --pid=${String(pid)} --format=pid= -o args=`))
          .trim()
          .split(/\s+/),
      ).toEqual([String(pid), 'sleep', '30'])
      const all = stdoutStr(await ws.shell('ps -eo pid,cmd'))
      expect(all.split('\n')[0]?.trim().split(/\s+/)).toEqual(['PID', 'CMD'])
      expect(all).toContain(String(pid))
      expect((await ws.shell(`kill ${selector} ${String(pid)}`)).exitCode).toBe(0)
      await ws.processes.drain()
      expect(stdoutStr(await ws.shell(`ps -p ${String(pid)} -o pid=; echo absent=$?`))).toBe(
        'absent=1\n',
      )
    } finally {
      await ws.close()
    }
  },
)

it('kill -0 checks signal permission without cancelling the process', async () => {
  const ws = buildWs()
  ws.createSession('owner')
  ws.createSession('audit', { profile: { processes: { list: 'workspace' } } })
  try {
    const pid = Number(stdoutStr(await ws.shell('sleep 30 & echo $!', { sessionId: 'owner' })))
    const result = await ws.shell(`kill -0 ${String(pid)}`, { sessionId: 'audit' })
    expect(result.exitCode).toBe(1)
    expect(stderrStr(result)).toContain('Operation not permitted')
    expect((await ws.shell(`kill -0 ${String(pid)}`, { sessionId: 'owner' })).exitCode).toBe(0)
    expect(ws.processes.view('owner').get(pid)?.cancellationRequested).toBe(false)
  } finally {
    await ws.close()
  }
})

it.each(['-kill', '-SIGkill', '-s kill', '-n KILL', '-s 9'])(
  'kill reads the signal name %s in any case',
  async (spelling) => {
    const ws = buildWs()
    try {
      const pid = stdoutStr(await ws.shell('sleep 30 & echo $!')).trim()
      const result = await ws.shell(`kill ${spelling} ${pid}`)
      expect([result.exitCode, stderrStr(result)]).toEqual([0, ''])
    } finally {
      await ws.close()
    }
  },
)

it('kill succeeds when any operand was signalled', async () => {
  const ws = buildWs()
  try {
    const pid = stdoutStr(await ws.shell('sleep 30 & echo $!')).trim()
    const result = await ws.shell(`kill 999999 %9 abc ${pid}; echo rc=$?`)
    expect(stdoutStr(result)).toBe('rc=0\n')
    expect(stderrStr(result)).toBe(
      'bash: kill: (999999) - No such process\nbash: kill: %9: no such job\n' +
        'bash: kill: abc: arguments must be process or job IDs\n',
    )
  } finally {
    await ws.close()
  }
})

it('ps lays columns out as procps does', async () => {
  const ws = buildWs()
  try {
    const pid = stdoutStr(await ws.shell('sleep 30 & echo $!')).trim()
    const at = pid.padStart(7)
    const cases: [string, string | null][] = [
      [`ps -o pid,ppid,cmd -p ${pid}`, `    PID    PPID CMD\n${at}       1 sleep 30\n`],
      [`ps -o cmd,pid -p ${pid}`, `CMD${' '.repeat(25)}    PID\nsleep 30${' '.repeat(20)}${at}\n`],
      [`ps -o comm,args -p ${pid}`, 'COMMAND         COMMAND\nsleep           sleep 30\n'],
      [`ps -o pid,cmd= -p ${pid}`, `    PID \n${at} sleep 30\n`],
      [`ps -o pid=,cmd -p ${pid}`, `        CMD\n${at} sleep 30\n`],
      [`ps -o pid=X,cmd=Y -p ${pid}`, `      X Y\n${at} sleep 30\n`],
      [`ps -o "pid cmd" -p ${pid},${pid}`, `    PID CMD\n${at} sleep 30\n`],
      [`ps ax -o pid= -p ${pid} | grep -c .`, null],
    ]
    for (const [line, out] of cases) {
      const result = await ws.shell(line)
      if (out !== null) expect(stdoutStr(result), line).toBe(out)
      expect([result.exitCode, stderrStr(result)], line).toEqual([0, ''])
    }
  } finally {
    await ws.close()
  }
})

// The issue's line: `$$` is the session's first line, which ps lists while it
// runs as the session leader procps marks with `s`; the owner is the workspace
// user and the group the session's profile.
it('ps lists the session leader with its owner', async () => {
  const ws = new Workspace(
    { '/m': [new RAMVFS(), MountMode.WRITE] },
    {
      mode: MountMode.WRITE,
      shellParser: parser,
      agentId: 'alice',
      profiles: { admin: parseSessionProfile({}) },
      profile: 'admin',
    },
  )
  try {
    const line = 'ps -o pid,ppid,pgid,sid,stat,user,uid,group,gid,cmd -p $$'
    expect(stdoutStr(await ws.shell(line))).toBe(
      '    PID    PPID    PGID     SID STAT USER       UID GROUP      GID CMD\n' +
        `      1       0       1       1 Rs   alice    alice admin    admin ${line}\n`,
    )
  } finally {
    await ws.close()
  }
})

it("ps does not name another session's group", async () => {
  const ws = new Workspace(
    { '/m': [new RAMVFS(), MountMode.WRITE] },
    {
      mode: MountMode.WRITE,
      shellParser: parser,
      profiles: {
        admin: parseSessionProfile({ processes: 'workspace' }),
        reader: parseSessionProfile({}),
      },
      profile: 'admin',
    },
  )
  ws.createSession('r', { profile: 'reader' })
  try {
    const pid = stdoutStr(await ws.shell('sleep 30 & echo $!', { sessionId: 'r' })).trim()
    const result = await ws.shell(`ps -o pid=,group= -p ${pid},$$`)
    const words = stdoutStr(result).split(/\s+/).filter(Boolean)
    const rows = new Map(words.flatMap((word, i) => (i % 2 === 0 ? [[word, words[i + 1]]] : [])))
    expect(rows.get(pid)).toBe('-')
    rows.delete(pid)
    expect([...rows.values()]).toEqual(['admin'])
  } finally {
    await ws.close()
  }
})

const PS_USAGE =
  '\nUsage:\n ps [options]\n\n' +
  " Try 'ps --help <simple|list|output|threads|misc|all>'\n" +
  "  or 'ps --help <s|l|o|t|m|a>'\n for additional help text.\n\n" +
  'For more details see ps(1).\n'

it.each([
  [['-p'], 'list of process IDs must follow -p'],
  [['-p', ''], 'list of process IDs must follow -p'],
  [['--pid'], 'list of process IDs must follow --pid'],
  [['-p', '1,x'], 'process ID list syntax error'],
  [['-p', '0'], 'process ID out of range'],
  [['-p', '-1'], 'process ID out of range'],
  [['-o'], 'format specification must follow -o'],
  [['--format'], 'format specification must follow --format'],
  [['-o', 'pid,,cmd'], 'improper format list'],
  [['-o', 'foo'], 'unknown user-defined format specifier "foo"'],
  [['-o', '='], 'unknown user-defined format specifier ""'],
  [['-K'], 'unsupported SysV option'],
  [['--bogus'], 'unknown gnu long option'],
  [['bogus'], 'unsupported option (BSD syntax)'],
] as const)('ps refuses %j in procps words', (args, message) => {
  const [out, io] = handlePs(new JobTable(), ['ps', ...args])
  expect(out).toBeNull()
  expect([io.exitCode, decode(io.stderr as Uint8Array)]).toEqual([
    1,
    `error: ${message}\n${PS_USAGE}`,
  ])
})
