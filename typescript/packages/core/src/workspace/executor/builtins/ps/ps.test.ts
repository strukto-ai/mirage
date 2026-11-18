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
import { SessionProfile } from '../../../../policy/profile.ts'
import { MachineName } from '../../../../execution/types.ts'
import { JobTable } from '../../../../execution/job/index.ts'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace.ts'
import { handlePs } from './ps.ts'
import { pendingRun } from '../../../../../tests/workspace/fixtures/job_runners.ts'
import { FIRST_PID } from '../../../../execution/process/constants.ts'

const HEADER = `${'PID'.padStart(7)} ${'MACHINE'.padEnd(31)} CMD`

function row(pid: number, command: string, machine = 'mirage'): string {
  return `${String(pid).padStart(7)} ${machine.padEnd(31)} ${command}`
}

function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

function buildWs(): Workspace {
  return new Workspace({ '/m': [new RAMVFS(), MountMode.WRITE] }, { mode: MountMode.WRITE })
}

describe('handlePs', () => {
  it('lists only running jobs', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const task = pendingRun(abort)
    const job = await jt.submit({ command: 'sleep', run: task, abort, cwd: '/' })
    const [out] = await handlePs(jt, ['ps'])
    expect(decode(out as Uint8Array)).toBe(`${HEADER}\n${row(job.pid, 'sleep')}\n`)
  })

  it.each([
    [['-C', 'sleep']],
    [['-Csleep']],
    [['-C', 'nosuch,sleep']],
    [['-C', 'nosuch sleep']],
    [['-C', 'nosuch', '-C', 'sleep']],
  ])('selects by command name: %j', async (args) => {
    const jt = new JobTable()
    const abort = new AbortController()
    const job = await jt.submit({ command: 'sleep', run: pendingRun(abort), abort, cwd: '/' })
    const other = new AbortController()
    await jt.submit({ command: 'foo 1', run: pendingRun(other), abort: other, cwd: '/' })
    const [out, io] = await handlePs(jt, ['ps', ...args])
    expect([decode(out as Uint8Array), io.exitCode]).toEqual([
      `${HEADER}\n${row(job.pid, 'sleep')}\n`,
      0,
    ])
  })

  it('adds a name selection to a pid selection', async () => {
    const jt = new JobTable()
    const abort = new AbortController()
    const job = await jt.submit({ command: 'sleep', run: pendingRun(abort), abort, cwd: '/' })
    const other = new AbortController()
    const foo = await jt.submit({
      command: 'foo 1',
      run: pendingRun(other),
      abort: other,
      cwd: '/',
    })
    const [out] = await handlePs(jt, ['ps', '-C', 'foo', '-p', String(job.pid), '-o', 'pid,comm'])
    expect(
      decode(out as Uint8Array)
        .split('\n')
        .slice(1, 3),
    ).toEqual([`${String(job.pid).padStart(7)} sleep`, `${String(foo.pid).padStart(7)} foo`])
  })

  // procps keeps 15 characters of a command's name and compares a -C name cut
  // the same way; a path or another case is no match.
  it.each([
    ['abcdefghijklmnopqrst', true],
    ['abcdefghijklmno', true],
    ['abcdefghijklmnop', true],
    ['/bin/abcdefghijklmnopqrst', false],
    ['ABCDEFGHIJKLMNO', false],
    ['abcdefghijklmn', false],
  ] as const)('compares the name procps keeps: %s', async (name, found) => {
    const jt = new JobTable()
    const abort = new AbortController()
    await jt.submit({
      command: '/bin/abcdefghijklmnopqrst 30',
      run: pendingRun(abort),
      abort,
      cwd: '/',
    })
    const [out, io] = await handlePs(jt, ['ps', '-C', name, '-o', 'comm'])
    const rows = found ? ['COMMAND', 'abcdefghijklmno', ''] : ['COMMAND', '']
    expect([decode(out as Uint8Array).split('\n'), io.exitCode]).toEqual([rows, found ? 0 : 1])
  })

  // The kernel keeps 15 bytes of a program's name; procps shows a character
  // the cut splits as one ? per byte, and a -C name whose own cut splits one
  // selects nothing (procps-ng 4.0.4, LANG=C.UTF-8).
  it.each([
    ['abcdefghijklm\u{1F600}A 30', 'abcdefghijklm??', 'abcdefghijklm??'],
    ['abcdefghijklm\u{1F600}A 30', 'abcdefghijklm\u{1F600}A', null],
    ['abcdefghijklm\u{1F600}A 30', 'abcdefghijklm\u{1F600}B', null],
    ['abcdefghijklm\u{1F600}A 30', 'abcdefghijklm\u{1F600}', null],
    ['abc\u{1F600} 30', 'abc\u{1F600}', 'abc\u{1F600}'],
    ['abcdefghijklmn\u{1F600} 30', 'abcdefghijklmn', null],
    ['abcdefghij\u{1F600}XYZ 30', 'abcdefghij\u{1F600}XYZ', 'abcdefghij\u{1F600}X'],
    ['abcdefghij\u{1F600}XYZ 30', 'abcdefghij\u{1F600}XY', 'abcdefghij\u{1F600}X'],
  ] as const)('cuts a name at 15 bytes: %s -C %s', async (command, name, shown) => {
    const jt = new JobTable()
    const abort = new AbortController()
    await jt.submit({ command, run: pendingRun(abort), abort, cwd: '/' })
    const [out, io] = await handlePs(jt, ['ps', '-C', name, '-o', 'comm='])
    expect([decode((out ?? new Uint8Array()) as Uint8Array), io.exitCode]).toEqual(
      shown === null ? ['', 1] : [`${shown}\n`, 0],
    )
  })

  // A program's name is its first word with the quotes removed, as the
  // shell ran it.
  it.each(['"sleep" 30', "'sleep' 30", 's"le"ep 30', '/bin/"sleep" 30', '\\sleep 30'])(
    'names a program by its unquoted word: %s',
    async (command) => {
      const jt = new JobTable()
      const abort = new AbortController()
      await jt.submit({ command, run: pendingRun(abort), abort, cwd: '/' })
      const [out, io] = await handlePs(jt, ['ps', '-C', 'sleep', '-o', 'comm='])
      expect([decode(out as Uint8Array), io.exitCode]).toEqual(['sleep\n', 0])
    },
  )

  // A process a scan found carries the machine's arguments as read, so its
  // first word is the program's name as it stands, quotes and backslashes
  // and all.
  it.each([
    ['foo\\bar 1', 'foo\\bar'],
    ["it's 1", "it's"],
    ['/opt/"q" 1', '"q"'],
  ] as const)('names a found process by its word as read: %s', async (command, name) => {
    const jt = new JobTable()
    const abort = new AbortController()
    const job = await jt.submit({ command, run: pendingRun(abort), abort, cwd: '/' })
    if (job.process == null) throw new Error('the job has no process')
    job.process.setMachinePid({ pid: 4242, started: 1 })
    const [out, io] = await handlePs(jt, ['ps', '-C', name, '-o', 'comm='])
    expect([decode(out as Uint8Array), io.exitCode]).toEqual([`${name}\n`, 0])
  })

  it('prints its header alone when no job is running', async () => {
    const jt = new JobTable()
    const [out, io] = await handlePs(jt, ['ps'])
    expect([decode(out as Uint8Array), io.exitCode]).toEqual([`${HEADER}\n`, 1])
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
        const commands = rows.slice(1).map((line) => line.slice(40))
        expect(commands).toEqual(expect.arrayContaining(['ps', 'cat']))
      } finally {
        await ws.close()
      }
    },
  )
})

describe('job builtins honor the process profile', () => {
  it('ps and kill reach other sessions as far as the profile says', async () => {
    const ws = buildWs()
    ws.createSession('a')
    ws.createSession('b')
    ws.createSession('audit', { profile: { processes: { list: 'workspace' } } })
    ws.createSession('ops', { profile: { processes: 'workspace' } })
    const count = "ps | grep -c 'sleep 30$'"
    const stop = "kill $(ps | grep 'sleep 30$' | awk '{print $1}'); echo rc=$?"
    try {
      const pid = stdoutStr(await ws.shell('sleep 30 & echo $!', { sessionId: 'a' })).trim()
      expect(stdoutStr(await ws.shell(count, { sessionId: 'b' }))).toBe('0\n')
      expect(stdoutStr(await ws.shell(count, { sessionId: 'audit' }))).toBe('1\n')
      const io = await ws.shell(stop, { sessionId: 'audit' })
      expect([stdoutStr(io), new TextDecoder().decode(io.stderr)]).toEqual([
        'rc=1\n',
        `bash: line 1: kill: (${pid}) - Operation not permitted\n`,
      ])
      expect(stdoutStr(await ws.shell(stop, { sessionId: 'ops' }))).toBe('rc=0\n')
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
      await ws.processTable.drain()
      expect(stdoutStr(await ws.shell(`ps -p ${String(pid)} -o pid=; echo absent=$?`))).toBe(
        'absent=1\n',
      )
    } finally {
      await ws.close()
    }
  },
)

it('ps lays columns out as procps does', async () => {
  const ws = buildWs()
  try {
    const pid = stdoutStr(await ws.shell('sleep 30 & echo $!')).trim()
    const shell = stdoutStr(await ws.shell('echo $$')).trim()
    const at = pid.padStart(7)
    const cases: [string, string | null][] = [
      [
        `ps -o pid,ppid,cmd -p ${pid}`,
        `    PID    PPID CMD\n${at} ${shell.padStart(7)} sleep 30\n`,
      ],
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
// runs as the session leader procps marks with `s`; the session's profile is
// both its owner and its group.
it('ps lists the session leader with its owner', async () => {
  const ws = new Workspace(
    { '/m': [new RAMVFS(), MountMode.WRITE] },
    {
      mode: MountMode.WRITE,
      profiles: { admin: SessionProfile({}) },
      profile: 'admin',
    },
  )
  try {
    const line = 'ps -o pid,ppid,pgid,sid,stat,user,uid,group,gid,cmd -p $$'
    expect(stdoutStr(await ws.shell(line))).toBe(
      '    PID    PPID    PGID     SID STAT USER       UID GROUP      GID CMD\n' +
        `${String(FIRST_PID)}       0 ${String(FIRST_PID)} ${String(FIRST_PID)} Rs   admin     1000 admin     1000 ${line}\n`,
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
      profiles: {
        admin: SessionProfile({ processes: 'workspace' }),
        reader: SessionProfile({}),
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
  [['-C'], 'list of command names must follow -C'],
  [['-C', ''], 'list of command names must follow -C'],
  [['-C', 'sleep,,foo'], 'improper list'],
  [['-C', ','], 'improper list'],
  [['-C', ' '], 'improper list'],
  [['--command', 'sleep'], 'unknown gnu long option'],
  [['-K'], 'unsupported SysV option'],
  [['--bogus'], 'unknown gnu long option'],
  [['bogus'], 'unsupported option (BSD syntax)'],
] as const)('ps refuses %j in procps words', async (args, message) => {
  const [out, io] = await handlePs(new JobTable(), ['ps', ...args])
  expect(out).toBeNull()
  expect([io.exitCode, decode(io.stderr as Uint8Array)]).toEqual([
    1,
    `error: ${message}\n${PS_USAGE}`,
  ])
})

// ps names the machine a program a runtime runs is on, and its pid there once
// known: a host program's from its start, a machine's from a scan.
it.each([false, true])('ps shows where a program runs (host %s)', async (host) => {
  const ws = new Workspace({}, { sessionId: 's' })
  try {
    await ws.shell('sleep 30 &', { sessionId: 's' })
    const process = ws.jobTable.get(1, 's')?.process
    if (process == null) throw new Error('the job has no process')
    process.oneCommand = true
    if (host) {
      expect(process.take(null)).toBe(true)
      process.setMachinePid({ pid: 4242, started: 1 })
    } else {
      expect(process.take(new MachineName('docker', 'tools'))).toBe(true)
    }
    const machine = host ? ws.processTable.machine.toString() : 'docker:tools'
    const own = stdoutStr(await ws.shell('ps', { sessionId: 's' })).split('\n')
    expect(own[0]).toBe(HEADER)
    expect(own).toContain(row(host ? 4242 : process.record.id.pid, 'sleep 30', machine))
    await ws.shell('kill %1', { sessionId: 's' })
  } finally {
    await ws.close()
  }
})

it('ps is a program of its own on a longer line', async () => {
  const ws = buildWs()
  try {
    const last = stdoutStr(await ws.shell('echo a; ps -o pid=,cmd=')).split('\n')
    const shell = stdoutStr(await ws.shell('echo $$')).trim()
    expect(last[1]?.trim()).toBe(`${shell} ps -o pid=,cmd=`)
    const first = stdoutStr(await ws.shell('ps -o ppid=,stat=,cmd=; echo b')).split('\n')
    expect(first.slice(0, 2).map((row) => row.trim().split(/\s+/).slice(0, 3))).toEqual([
      ['0', 'Ss', 'ps'],
      [shell, 'R', 'ps'],
    ])
    expect(first[1]?.trim().endsWith('ps -o ppid=,stat=,cmd=')).toBe(true)
  } finally {
    await ws.close()
  }
})

describe('ps under wrappers', () => {
  it.each([
    ['ps -o ni,pri,priority,opri,comm', '  0  19  20  80 ps\n'],
    ['nice ps -o ni,comm', ' 10 ps\n'],
    ['nice -n 5 nohup ps -o ni,pri,priority,opri,comm', '  5  14  25  85 ps\n'],
    ["nice -n 3 sh -c 'ps -o ni,comm'", '  3 ps\n'],
  ])('shows the niceness its wrappers gave it: %s', async (line, out) => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
    try {
      const io = await ws.shell(line)
      expect(stdoutStr(io).split('\n').slice(1).join('\n')).toBe(out)
    } finally {
      await ws.close()
    }
  })

  it('leads its own group and session under setsid', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
    try {
      const io = await ws.shell('setsid ps -o pid=,pgid=,sid=,comm=')
      const [pid, pgid, sid, comm] = stdoutStr(io)
        .split(/\s+/)
        .filter((w) => w !== '')
      expect([pgid, sid, comm]).toEqual([pid, pid, 'ps'])
    } finally {
      await ws.close()
    }
  })

  it.each([
    ['nice -n 7 sleep 3 & sleep 0.2; ps -o ni=,comm=; kill %1', '7 sleep'],
    ['nohup sleep 3 & sleep 0.2; ps -o ni=,comm=; kill %1', '0 sleep'],
  ])('shows a wrapped job as its program: %s', async (line, out) => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
    try {
      const io = await ws.shell(line)
      const rows = stdoutStr(io)
        .split('\n')
        .map((row) => row.trim().split(/\s+/).join(' '))
      expect(rows).toContain(out)
      await ws.shell('wait')
    } finally {
      await ws.close()
    }
  })

  it('shows a setsid job leading its own group and session', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
    try {
      const io = await ws.shell(
        'setsid sleep 3 & p=$!; sleep 0.2; ps -o pid=,pgid=,sid= -p $p; kill $p',
      )
      const [pid, pgid, sid] = stdoutStr(io)
        .split(/\s+/)
        .filter((w) => w !== '')
      expect([pgid, sid]).toEqual([pid, pid])
      await ws.shell('wait')
    } finally {
      await ws.close()
    }
  })
})

it("puts a setsid job's children in its session", async () => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
  try {
    const io = await ws.shell(
      "setsid sh -c 'sleep 3 & wait' & sleep 0.3; ps -o pid=,pgid=,sid=,comm=; kill %1",
    )
    const rows = stdoutStr(io)
      .split('\n')
      .map((row) => row.trim().split(/\s+/))
    const sh = rows.find((row) => row[3] === 'sh')
    const sleep = rows.find((row) => row[3] === 'sleep')
    expect([sh?.[1], sh?.[2]]).toEqual([sh?.[0], sh?.[0]])
    expect([sleep?.[1], sleep?.[2]]).toEqual([sh?.[0], sh?.[0]])
    await ws.shell('wait')
  } finally {
    await ws.close()
  }
})
