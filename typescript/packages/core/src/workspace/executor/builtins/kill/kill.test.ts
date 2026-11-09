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
import { stderrStr, stdoutStr } from '../../../../../tests/workspace/fixtures/workspace_fixture.ts'
import { JobTable } from '../../../../execution/job/index.ts'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace.ts'
import { handleKill } from './kill.ts'
import { pendingRun } from '../../../../../tests/workspace/fixtures/job_runners.ts'

function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

function buildWs(): Workspace {
  return new Workspace({ '/m': [new RAMVFS(), MountMode.WRITE] }, { mode: MountMode.WRITE })
}

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
    const j = await jt.submit({ command: 'sleep', run: task, abort, cwd: '/' })
    const [, io] = await handleKill(jt, ['kill', String(j.pid)])
    expect(io.exitCode).toBe(0)
    expect(jt.get(j.id)?.signal).not.toBeNull()
  })
})

// bash starts a job ignoring INT and QUIT, so kill -INT or -QUIT reaches it
// and the job runs on; TERM still ends it. Pinned on bash 5.2, once the job
// has started (a kill right after `&` races bash's own setup).
describe('kill -INT and -QUIT on a job', () => {
  it.each([
    ['sleep 0.5 & sleep 0.1; kill -INT $!; wait $!; echo $?', '0\n'],
    ['sleep 0.5 & sleep 0.1; kill -s QUIT %1; wait %1; echo $?', '0\n'],
    ['(sleep 0.5; echo x $?) & sleep 0.1; kill -2 $!; wait $!; echo $?', 'x 0\n0\n'],
    ['f() { sleep 0.5; echo f; }; f & sleep 0.1; kill -INT $!; wait $!; echo $?', 'f\n0\n'],
    ["bash -c 'sleep 0.5; echo y' & sleep 0.1; kill -INT $!; wait; echo $?", 'y\n0\n'],
    ['sleep 5 & sleep 0.1; kill -TERM $!; wait $!; echo $?', '143\n'],
  ])('%s', async (line, out) => {
    const ws = new Workspace({ '/m': [new RAMVFS(), MountMode.WRITE] }, { mode: MountMode.WRITE })
    try {
      const io = await ws.shell(line)
      expect([stdoutStr(io), io.exitCode]).toEqual([out, 0])
    } finally {
      await ws.close()
    }
  })
})

// Every line of a session runs under one pid, its $$: a signal to it ends the
// line with 128 plus it, the next line's $?, and leaves its jobs running; a
// QUIT, which every shell ignores, does nothing. A nested shell is a process
// of its own, with a $$ of its own.
it("$$ names the session's shell", async () => {
  const ws = new Workspace({ '/m': [new RAMVFS(), MountMode.WRITE] }, { mode: MountMode.WRITE })
  try {
    const pid = stdoutStr(await ws.shell('echo $$')).trim()
    let io = await ws.shell('sleep 0.3 & echo before; kill $$; echo after')
    expect([stdoutStr(io), io.exitCode]).toEqual(['before\n', 143])
    io = await ws.shell(
      'echo $? $$; kill -QUIT $$; echo quit=$?; wait; echo job=$?; ' +
        `[ "$(bash -c 'echo $$')" != $$ ] && echo own; ` +
        "bash -c 'kill $$; echo no'; echo nested=$?",
    )
    expect(stdoutStr(io)).toBe(`143 ${pid}\nquit=0\njob=0\nown\nnested=143\n`)
  } finally {
    await ws.close()
  }
})

// kill -SIG -- -PGID signals every process of a group, as killpg(2) does: the
// session's shell leads one, which its jobs and nested shells are in. A shell
// hands a QUIT to the program it runs right now; a job ignores an INT too,
// which ends the line's own shell.
it('kill signals a process group', async () => {
  const ws = new Workspace({ '/m': [new RAMVFS(), MountMode.WRITE] }, { mode: MountMode.WRITE })
  try {
    let io = await ws.shell(
      '{ sleep 1; echo "q $?"; } & sleep 0.1; kill -QUIT -- -$$; ' +
        'wait $!; echo after=$?; kill -0 -- -$$; echo grp=$?; ' +
        "bash -c 'kill -0 -- -$$' 2>/dev/null; echo nested=$?; " +
        'kill -s TERM -- -999999; echo missing=$?',
    )
    expect(stdoutStr(io)).toBe('q 131\nafter=0\ngrp=0\nnested=1\nmissing=1\n')
    expect(stderrStr(io)).toBe('bash: line 1: kill: (-999999) - No such process\n')
    io = await ws.shell('{ sleep 1; echo "a $?" > /m/a; } & sleep 0.1; kill -INT -- -$$; echo no')
    expect([stdoutStr(io), io.exitCode]).toEqual(['', 130])
    io = await ws.shell('wait; cat /m/a')
    expect(stdoutStr(io)).toBe('a 130\n')
  } finally {
    await ws.close()
  }
})

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
    expect(ws.processTable.visible('owner').find((info) => info.id.pid === pid)?.state).toBe(
      'running',
    )
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
      'bash: line 1: kill: (999999) - No such process\nbash: line 1: kill: %9: no such job\n' +
        'bash: line 1: kill: abc: arguments must be process or job IDs\n',
    )
  } finally {
    await ws.close()
  }
})

// A pid is a number: kill and ps refuse any other operand in bash's and
// procps's words.
it('kill and ps refuse a pid that is no number', async () => {
  const ws = new Workspace({}, { sessionId: 's' })
  try {
    const killed = await ws.shell('kill ab12:3 :3', { sessionId: 's' })
    expect(killed.exitCode).toBe(1)
    expect(
      stderrStr(killed)
        .split('\n')
        .filter((l) => l !== ''),
    ).toEqual([
      'bash: line 1: kill: ab12:3: arguments must be process or job IDs',
      'bash: line 1: kill: :3: arguments must be process or job IDs',
    ])
    const picked = await ws.shell('ps -p ab12:3', { sessionId: 's' })
    expect(picked.exitCode).toBe(1)
    expect(stderrStr(picked)).toContain('process ID list syntax error')
  } finally {
    await ws.close()
  }
})
