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

import { describe, expect, it, vi } from 'vitest'
import { CHECK_LINE, CHECK_MARK } from '../../machine/constants.ts'
import type * as machineConstants from '../../machine/constants.ts'
import { MachineHandle } from '../../machine/handle.ts'
import { MachineRuntime } from '../../runtime/machine/runtime.ts'
import type { RunResult } from '../../runtime/types.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { MachinePid } from '../types.ts'
import type { ProcessTable } from '../process/table.ts'
import { shownPid } from '../process/types.ts'
import { MachineTable } from './table.ts'
import type { MachineProcess } from './types.ts'

vi.mock('../../machine/constants.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof machineConstants>()),
  RUN_START_WAIT_SECONDS: 0.01,
}))

const DEC = new TextDecoder()

function tagOf(argv: readonly string[]): string {
  return (argv[5] ?? '').split('=')[1] ?? ''
}

class Box extends MachineHandle {
  static override readonly provider = 'box'
  readonly lines: string[] = []

  constructor(
    name: string,
    readonly code: number | null,
    readonly ran = true,
  ) {
    super(name)
  }

  connect(): Promise<void> {
    return this.code === null ? Promise.reject(new Error('no such box')) : Promise.resolve()
  }

  protected override execArgv(argv: readonly string[]): Promise<RunResult> {
    this.lines.push(argv.at(-1) ?? '')
    const stdout = new TextEncoder().encode(this.ran ? `${CHECK_MARK}\n` : '')
    return Promise.resolve({ stdout, stderr: null, exitCode: this.code ?? 0 })
  }
}

describe('MachineTable', () => {
  it('checks how far Mirage reaches each machine', async () => {
    const a = new Box('a', 0)
    const table = new MachineTable({
      a,
      b: new Box('b', 1),
      c: new Box('c', null),
      d: new Box('d', 1, false),
    })
    const found = await table.check(() => 7)
    expect(found.map((m) => [m.id.toString(), m.state, m.checkedAt])).toEqual([
      ['box:a', 'managed', 7],
      ['box:b', 'reachable', 7],
      ['box:c', 'unreachable', 7],
      ['box:d', 'unreachable', 7],
    ])
    expect(a.lines).toEqual([CHECK_LINE])
  })

  it('checks the one machine it names', async () => {
    const table = new MachineTable({ a: new Box('a', 0), b: new Box('b', 0) })
    expect((await table.check(() => 0, 'box:b')).map((m) => m.id.toString())).toEqual(['box:b'])
    expect(await table.check(() => 0, 'box:z')).toEqual([])
  })
})

/**
 * A box whose runs wait until a TERM reaches their program, each starting a
 * child the scan finds; `base` numbers its pids.
 */
class Sleeper extends MachineHandle {
  static override readonly provider = 'box'
  rows: MachineProcess[] = []
  readonly sent: [string | MachinePid, number][] = []
  private end: () => void = () => undefined
  private readonly stopped = new Promise<void>((resolve) => {
    this.end = resolve
  })

  constructor(
    name: string,
    readonly base = 412,
  ) {
    super(name)
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  finish(): void {
    this.end()
  }

  protected override async execArgv(
    argv: readonly string[],
    _stdin: unknown,
    _env: Record<string, string>,
    _cwd: string,
    _output: unknown,
    _errors: unknown,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const tag = tagOf(argv)
    this.rows = [
      { tag, pid: this.base, ppid: 1, started: 100, args: argv.slice(7).join(' ') },
      { tag, pid: this.base + 1, ppid: this.base, started: 101, args: 'train 2' },
    ]
    await Promise.race([
      this.stopped,
      new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve()
        })
      }),
    ])
    this.rows = []
    return { stdout: new Uint8Array(), stderr: null, exitCode: 143 }
  }

  override execLine(): Promise<RunResult> {
    const stdout = new TextEncoder().encode(`${String(this.base)} 100\n`)
    return Promise.resolve({ stdout, stderr: null, exitCode: 0 })
  }

  override status(workspace: string): Promise<MachineProcess[]> {
    return Promise.resolve(this.rows.filter((row) => row.tag.startsWith(`${workspace}:`)))
  }

  override signal(target: string | MachinePid, signum: number): Promise<boolean> {
    this.sent.push([target, signum])
    const root = typeof target === 'string' || target.pid === this.base
    if (signum === 15 && root) this.finish()
    return Promise.resolve(true)
  }
}

/** A box whose runs report no pid, as when nothing could write there. */
class Unreported extends Sleeper {
  override execLine(): Promise<RunResult> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })
  }
}

/** A box whose runs start a child and exit before any scan. */
class Leaver extends Sleeper {
  protected override execArgv(argv: readonly string[]): Promise<RunResult> {
    const tag = tagOf(argv)
    this.rows = [{ tag, pid: this.base + 1, ppid: 1, started: 101, args: 'daemon' }]
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })
  }
}

/** A leaver whose machine stops answering signals. */
class Unreachable extends Leaver {
  override signal(): Promise<boolean> {
    return Promise.reject(new Error('connection lost'))
  }
}

/** A box whose program exits on WINCH, its whole run gone before the signal's delivery answers. */
class Quitter extends Sleeper {
  table: ProcessTable | null = null
  private quit: () => void = () => undefined
  private readonly quitted = new Promise<void>((resolve) => {
    this.quit = resolve
  })

  override finish(): void {
    this.quit()
  }

  protected override async execArgv(argv: readonly string[]): Promise<RunResult> {
    this.rows = [{ tag: tagOf(argv), pid: this.base, ppid: 1, started: 100, args: 'q' }]
    await this.quitted
    this.rows = []
    return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
  }

  override async signal(target: string | MachinePid, signum: number): Promise<boolean> {
    this.sent.push([target, signum])
    this.finish()
    const table = this.table
    for (let i = 0; table !== null && i < 500; i++) {
      if (!table.live().some((p) => p.record.machinePid !== null)) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return true
  }
}

/** A leaver whose machine answers a signal only while a row shows. */
class Gone extends Leaver {
  override signal(target: string | MachinePid, signum: number): Promise<boolean> {
    this.sent.push([target, signum])
    return Promise.resolve(this.rows.length > 0)
  }
}

/** A box whose program ends on the one signal it handles. */
class Handler extends Sleeper {
  constructor(
    name: string,
    readonly handles: number,
  ) {
    super(name)
  }

  override signal(target: string | MachinePid, signum: number): Promise<boolean> {
    this.sent.push([target, signum])
    if (signum === this.handles) this.finish()
    return Promise.resolve(true)
  }
}

/** A leaver whose first scan loses the connection. */
class Dropping extends Leaver {
  private dropped = false

  override status(workspace: string): Promise<MachineProcess[]> {
    if (this.dropped) return super.status(workspace)
    this.dropped = true
    return Promise.reject(new Error('connection lost'))
  }
}

/** A box that shares one container with every other `Shared`. */
class Shared extends Sleeper {
  static readonly boxes: Shared[] = []

  constructor(name: string, base?: number) {
    super(name, base)
    Shared.boxes.push(this)
  }

  override status(workspace: string): Promise<MachineProcess[]> {
    return Promise.resolve(
      Shared.boxes.flatMap((box) => box.rows).filter((row) => row.tag.startsWith(`${workspace}:`)),
    )
  }
}

async function started(box: Sleeper): Promise<void> {
  const deadline = Date.now() + 5000
  while (box.rows.length === 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
}

function sleepers(boxes: Record<string, Sleeper>): Workspace {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: boxes,
      runtimes: [new MachineRuntime({ captures: ['train'], machine: Object.keys(boxes)[0] ?? '' })],
    },
  )
}

describe('MachineTable scans', () => {
  it('shows what a program started on its machine', async () => {
    const box = new Sleeper('a')
    const ws = sleepers({ a: box })
    try {
      const pid = Number(DEC.decode((await ws.shell('train 1 & echo $!')).stdout))
      const shell = DEC.decode((await ws.shell('echo $$')).stdout).trim()
      await started(box)
      const said = DEC.decode((await ws.shell('ps f -o pid,ppid,machine,cmd')).stdout)
      const rows = said
        .trimEnd()
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
      expect(pid).toBe(412)
      expect(rows[0]).toEqual(['PID', 'PPID', 'MACHINE', 'CMD'])
      expect(rows.slice(1).map((row) => row.slice(1, 4))).toEqual([
        ['0', 'mirage', 'ps'],
        [shell, 'box:a', '\\_'],
        ['412', 'box:a', '\\_'],
      ])
      expect([rows[2]?.[0], rows[3]?.[0]]).toEqual(['412', '413'])
      const [program, found] = ws.processTable.records().slice(-2)
      expect([found?.runtime, found?.parent]).toEqual([null, program?.id.pid])
      const killed = await ws.shell(`kill -USR1 413; kill -0 ${String(pid)}; echo $?`)
      expect(DEC.decode(killed.stdout)).toBe('0\n')
      expect(box.sent).toEqual([[{ pid: 413, started: 101, exited: null }, 10]])
      expect((await ws.shell(`kill ${String(pid)}; wait ${String(pid)}`)).exitCode).toBe(143)
      expect(box.sent.at(-1)).toEqual([{ pid: 412, started: 100, exited: null }, 15])
      await ws.shell('ps')
      expect(ws.processTable.live().map((p) => p.record.id.pid)).not.toContain(found?.id.pid)
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it('signals a program no scan placed by its tag', async () => {
    const box = new Unreported('a')
    const ws = sleepers({ a: box })
    try {
      const pid = DEC.decode((await ws.shell('train 1 & echo $!')).stdout).trim()
      await started(box)
      expect((await ws.shell(`kill ${pid}; wait ${pid}`)).exitCode).toBe(143)
      expect(box.sent).toEqual([[`${ws.workspaceId}:${pid}`, 15]])
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it('names by a machine pid the process whose program has it', async () => {
    const a = new Sleeper('a')
    const b = new Sleeper('b')
    const ws = sleepers({ a, b })
    try {
      const pid = DEC.decode((await ws.shell('train 1 & echo $!')).stdout).trim()
      await started(a)
      expect(pid).toBe('412')
      let said = await ws.shell('ps -p 412 -o pid=; kill -0 412; echo $?')
      expect(DEC.decode(said.stdout).trim().split(/\s+/)).toEqual(['412', '0'])
      ws.createSession('other')
      said = await ws.shell('kill -0 412', { sessionId: 'other' })
      expect(DEC.decode(said.stderr)).toBe('bash: line 1: kill: (412) - No such process\n')
      said = await ws.shell('kill 999; wait 413')
      expect(DEC.decode(said.stderr).trimEnd().split('\n')).toEqual([
        'bash: line 1: kill: (999) - No such process',
        'bash: line 1: wait: pid 413 is not a child of this shell',
      ])
      await ws.shell('train 1 &', { machine: 'b' })
      await started(b)
      said = await ws.shell('kill 412')
      expect(said.exitCode).toBe(1)
      expect(DEC.decode(said.stderr)).toBe('bash: line 1: kill: 412: ambiguous job spec\n')
      said = await ws.shell('wait 412')
      expect(DEC.decode(said.stderr)).toBe('bash: line 1: wait: 412: ambiguous job spec\n')
      expect((await ws.shell('kill -m a 412')).exitCode).toBe(0)
      expect(a.sent.at(-1)).toEqual([{ pid: 412, started: 100, exited: null }, 15])
      expect((await ws.shell('wait -m box:a 412')).exitCode).toBe(143)
      expect(b.sent).toEqual([])
    } finally {
      a.finish()
      b.finish()
      await ws.close()
    }
  })

  it('answers wait for a machine pid once its program ended', async () => {
    const box = new Sleeper('a')
    const ws = sleepers({ a: box })
    try {
      const pid = Number(DEC.decode((await ws.shell('train 1 & echo $!')).stdout).trim())
      await started(box)
      await ws.shell('ps')
      box.finish()
      await vi.waitFor(() => {
        expect(ws.processTable.live().map((p) => shownPid(p.record))).not.toContain(pid)
      })
      const said = await ws.shell('wait 412')
      expect([said.exitCode, DEC.decode(said.stderr)]).toEqual([143, ''])
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it('leaves the session room to fork past what a scan found', async () => {
    const box = new Sleeper('a')
    const ws = sleepers({ a: box })
    ws.createSession('capped', { profile: { processes: { max: 3 } } })
    try {
      await ws.shell('train 1 &', { sessionId: 'capped' })
      await started(box)
      await ws.shell('ps', { sessionId: 'capped' })
      const found = ws.processTable
        .live()
        .map((p) => p.record)
        .filter((r) => r.sessionId === 'capped' && r.runtime === null)
      expect(found.map((r) => r.machinePid?.pid)).toEqual([413])
      const said = await ws.shell('(echo room)', { sessionId: 'capped' })
      expect([DEC.decode(said.stdout), said.exitCode]).toEqual(['room\n', 0])
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it('finds what an ended program left running', async () => {
    const box = new Leaver('a')
    const ws = sleepers({ a: box })
    try {
      expect((await ws.shell('train 1')).exitCode).toBe(0)
      const said = await ws.shell('ps -o pid=,args=')
      const rows = DEC.decode(said.stdout)
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
      expect(rows).toContainEqual(['413', 'daemon'])
      box.rows = []
      await ws.shell('ps')
      expect(ws.processTable.live().map((p) => p.record.machinePid?.pid)).not.toContain(413)
    } finally {
      await ws.close()
    }
  })

  it("leaves a closed session's programs to none that reuses its id", async () => {
    const box = new Leaver('a')
    const ws = sleepers({ a: box })
    try {
      const old = await ws.session('agent')
      expect((await old.shell('train 1')).exitCode).toBe(0)
      await ws.closeSession('agent')
      const reused = await ws.session('agent')
      const said = await reused.shell('ps -o pid=,args=')
      expect(DEC.decode(said.stdout)).not.toContain('daemon')
      expect((await reused.shell('kill 413')).exitCode).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('reaches a parent before its child with a group signal', async () => {
    const box = new Sleeper('a')
    const ws = sleepers({ a: box })
    try {
      await ws.shell('( train 1; true ) &')
      await started(box)
      await ws.shell('kill -QUIT -- -$$')
      expect(box.sent.map(([target, signum]) => [(target as MachinePid).pid, signum])).toEqual([
        [412, 3],
        [413, 3],
      ])
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it('reaches a parent first with a forwarded group signal', async () => {
    const box = new Sleeper('a')
    const ws = sleepers({ a: box })
    try {
      await ws.shell('train 1 &')
      await started(box)
      await ws.processTable.scan()
      const found = ws.processTable.records().find((record) => record.machinePid !== null)
      await ws.processTable.signalGroup(found?.group ?? 0, 28)
      expect(box.sent.map(([target, signum]) => [(target as MachinePid).pid, signum])).toEqual([
        [412, 28],
        [413, 28],
      ])
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it('leaves what a scan no longer sees out of that ps', async () => {
    const box = new Sleeper('a')
    const ws = sleepers({ a: box })
    try {
      await ws.shell('train 1 &')
      await started(box)
      expect(DEC.decode((await ws.shell('ps -o pid')).stdout)).toContain('413')
      box.rows = box.rows.slice(0, 1)
      expect(DEC.decode((await ws.shell('ps -o pid')).stdout)).not.toContain('413')
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it("reaches a shell's program with a group signal as sent", async () => {
    const box = new Sleeper('a')
    const ws = sleepers({ a: box })
    try {
      await ws.shell('( train 1; true ) &')
      await started(box)
      expect((await ws.shell('kill -QUIT -- -$$')).exitCode).toBe(0)
      expect(box.sent.map(([target, signum]) => [JSON.stringify(target), signum]).sort()).toEqual(
        [
          [JSON.stringify({ pid: 412, started: 100, exited: null }), 3],
          [JSON.stringify({ pid: 413, started: 101, exited: null }), 3],
        ].sort(),
      )
      const said = await ws.shell('jobs')
      expect(DEC.decode(said.stdout)).toBe('[1]+  Running                 ( train 1; true ) &\n')
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it('reaches a program with a kept signal as sent', async () => {
    const box = new Sleeper('a')
    const ws = sleepers({ a: box })
    try {
      await ws.shell('train 1 &')
      await started(box)
      expect((await ws.shell('kill -WINCH %1')).exitCode).toBe(0)
      expect(box.sent.map(([, signum]) => signum)).toEqual([28])
      box.sent.length = 0
      expect((await ws.shell('kill -WINCH -- -$$')).exitCode).toBe(0)
      const sent = box.sent.map(([target, signum]) => [
        typeof target === 'string' ? target : target.pid,
        signum,
      ])
      expect(sent).toEqual([
        [412, 28],
        [413, 28],
      ])
      expect(DEC.decode((await ws.shell('jobs')).stdout)).toBe(
        '[1]+  Running                 train 1 &\n',
      )
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it('keeps what a scan found when a signal goes unanswered', async () => {
    const box = new Unreachable('a')
    const ws = sleepers({ a: box })
    try {
      expect((await ws.shell('train 1')).exitCode).toBe(0)
      expect(DEC.decode((await ws.shell('ps -o args=')).stdout)).toContain('daemon')
      expect((await ws.shell('kill -WINCH 413')).exitCode).toBe(1)
      expect(DEC.decode((await ws.shell('ps -o args=')).stdout)).toContain('daemon')
    } finally {
      await ws.close()
    }
  })

  it('reports a kept signal sent to a group that then ends', async () => {
    const box = new Quitter('a')
    const ws = sleepers({ a: box })
    box.table = ws.processTable
    try {
      await ws.shell('timeout 30 train 1 &')
      await started(box)
      const listed = DEC.decode((await ws.shell('ps -o pgid=,pid=')).stdout)
      const group = listed
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find((row) => row[1] === '412')?.[0]
      const said = await ws.shell(`kill -WINCH -- -${group ?? ''}`)
      expect([said.exitCode, DEC.decode(said.stderr)]).toEqual([0, ''])
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it('fails a kept signal to a group gone by its scan', async () => {
    const box = new Gone('a')
    const ws = sleepers({ a: box })
    try {
      expect((await ws.shell('train 1')).exitCode).toBe(0)
      const listed = DEC.decode((await ws.shell('ps -o pgid=,pid=')).stdout)
      const group = listed
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find((row) => row[1] === '413')?.[0]
      box.rows = []
      const said = await ws.shell(`kill -WINCH -- -${group ?? ''}`)
      expect(said.exitCode).toBe(1)
      expect(DEC.decode(said.stderr)).toContain('No such process')
    } finally {
      await ws.close()
    }
  })

  it('sends a foreground timeout to the program it runs', async () => {
    const box = new Handler('a', 10)
    const ws = sleepers({ a: box })
    try {
      const said = await ws.shell('timeout --foreground -s USR1 0.1 train 1')
      expect(said.exitCode).toBe(124)
      expect(box.sent.map(([, signum]) => signum)).toEqual([10])
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it('ends the shell a foreground timeout runs', async () => {
    const box = new Handler('a', 10)
    const ws = sleepers({ a: box })
    try {
      const said = await ws.shell(
        "timeout --foreground -s KILL 0.1 sh -c 'train 1; echo after; sleep 30'",
      )
      expect(said.exitCode).toBe(137)
      expect(DEC.decode(said.stdout)).not.toContain('after')
    } finally {
      box.finish()
      await ws.close()
    }
  }, 5000)

  it("leaves a foreground timeout's shell's background program", async () => {
    const box = new Handler('a', 10)
    const ws = sleepers({ a: box })
    try {
      const said = await ws.shell("timeout --foreground -s USR1 0.2 sh -c 'train 1 & sleep 30'")
      expect(said.exitCode).toBe(124)
      expect(box.sent).toEqual([])
    } finally {
      box.finish()
      await ws.close()
    }
  }, 5000)

  it.each(['', '--foreground '])(
    'waits past the grace for a program that handles QUIT %s',
    async (how) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      const box = new Handler('a', 0)
      const ws = sleepers({ a: box })
      try {
        let done = false
        const run = ws.shell(`timeout ${how}-s QUIT 0.1 train 1`).finally(() => {
          done = true
        })
        const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
        while (box.rows.length === 0) await turn()
        await vi.advanceTimersByTimeAsync(12_000)
        for (let left = 20; left > 0; left--) await turn()
        expect(done).toBe(false)
        expect(new Set(box.sent.map(([, signum]) => signum))).toEqual(
          new Set(how === '' ? [3, 18] : [3]),
        )
        box.finish()
        vi.useRealTimers()
        expect((await run).exitCode).toBe(124)
      } finally {
        vi.useRealTimers()
        box.finish()
        await ws.close()
      }
    },
  )

  it('keeps the status of a program that handled a timeout signal', async () => {
    const box = new Handler('a', 10)
    const ws = sleepers({ a: box })
    try {
      const said = await ws.shell('timeout -p --foreground -s USR1 0.1 train 1')
      expect(said.exitCode).toBe(143)
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it.each(['', '--foreground '])('forwards a kept timeout signal %s', async (how) => {
    const box = new Handler('a', 28)
    const ws = sleepers({ a: box })
    try {
      const said = await ws.shell(`timeout ${how}-s WINCH 0.1 train 1`)
      expect(said.exitCode).toBe(124)
      expect(new Set(box.sent.map(([, signum]) => signum))).toEqual(
        new Set(how === '' ? [28, 18] : [28]),
      )
    } finally {
      box.finish()
      await ws.close()
    }
  })

  it('tries an ended run again after a failed scan', async () => {
    const box = new Dropping('a')
    const ws = sleepers({ a: box })
    try {
      expect((await ws.shell('train 1')).exitCode).toBe(0)
      expect(DEC.decode((await ws.shell('ps -o args=')).stdout)).not.toContain('daemon')
      expect(DEC.decode((await ws.shell('ps -o args=')).stdout)).toContain('daemon')
    } finally {
      await ws.close()
    }
  })

  it('lists each process once for two entries on one container', async () => {
    const a = new Shared('a')
    const b = new Shared('b', 512)
    const ws = sleepers({ a, b })
    try {
      await ws.shell('train 1 &')
      await ws.shell('train 2 &', { machine: 'b' })
      await started(a)
      await started(b)
      const said = DEC.decode((await ws.shell('ps -o machine=,pid=,args=')).stdout)
      const found = said
        .split('\n')
        .map((line) => line.trim().split(/\s+/).slice(0, 2))
        .filter((row) => row.length === 2 && row[0] !== 'mirage')
      expect(found.sort()).toEqual([
        ['box:a', '412'],
        ['box:a', '413'],
        ['box:b', '512'],
        ['box:b', '513'],
      ])
    } finally {
      a.finish()
      b.finish()
      await ws.close()
      Shared.boxes.length = 0
    }
  })

  it('keeps a handle in one workspace at a time', async () => {
    const box = new Sleeper('a')
    const workspace = () =>
      new Workspace({ '/': new RAMVFS() }, { mode: MountMode.EXEC, machines: { a: box } })
    const first = workspace()
    expect(workspace).toThrow('already in another workspace')
    await first.close()
    await workspace().close()
  })

  it('leaves a handle free when its workspace fails to build', async () => {
    const box = new Sleeper('a')
    expect(
      () =>
        new Workspace(
          { '/': new RAMVFS() },
          { mode: MountMode.EXEC, machines: { a: box, b: { provider: 'nope' } } },
        ),
    ).toThrow('nope')
    expect(
      () =>
        new Workspace(
          { '/': new RAMVFS() },
          {
            mode: MountMode.EXEC,
            machines: { a: box },
            runtimes: [new MachineRuntime({ machine: 'c' }), 'workspace'],
          },
        ),
    ).toThrow("unknown machine: 'c'")
    await new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.EXEC, machines: { a: box } },
    ).close()
  })
})
