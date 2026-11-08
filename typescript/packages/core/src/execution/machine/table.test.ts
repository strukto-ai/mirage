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
import { CHECK_LINE, PROCESS } from '../../machine/constants.ts'
import { MachineHandle } from '../../machine/handle.ts'
import { NativeRuntime } from '../../runtime/native/runtime.ts'
import type { RunResult } from '../../runtime/types.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { MachinePid } from '../types.ts'
import { MachineTable } from './table.ts'
import type { MachineProcess } from './types.ts'

const DEC = new TextDecoder()

class Box extends MachineHandle {
  static override readonly provider = 'box'
  readonly lines: string[] = []

  constructor(
    name: string,
    readonly code: number | null,
  ) {
    super(name)
  }

  connect(): Promise<void> {
    return this.code === null ? Promise.reject(new Error('no such box')) : Promise.resolve()
  }

  protected override execArgv(argv: readonly string[]): Promise<RunResult> {
    this.lines.push(argv.at(-1) ?? '')
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: this.code ?? 0 })
  }
}

describe('MachineTable', () => {
  it('checks how far Mirage reaches each machine', async () => {
    const a = new Box('a', 0)
    const table = new MachineTable({ a, b: new Box('b', 1), c: new Box('c', null) })
    const found = await table.check(() => 7)
    expect(found.map((m) => [m.id.toString(), m.state, m.checkedAt])).toEqual([
      ['box:a', 'managed', 7],
      ['box:b', 'reachable', 7],
      ['box:c', 'unreachable', 7],
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
  private readonly ended = new Promise<void>((resolve) => {
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
    env: Record<string, string>,
    _cwd: string,
    _output: unknown,
    _errors: unknown,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const tag = env[PROCESS] ?? ''
    this.rows = [
      { tag, pid: this.base, ppid: 1, started: 100, args: argv.join(' ') },
      { tag, pid: this.base + 1, ppid: this.base, started: 101, args: 'train 2' },
    ]
    await Promise.race([
      this.ended,
      new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve()
        })
      }),
    ])
    this.rows = []
    return { stdout: new Uint8Array(), stderr: null, exitCode: 143 }
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
      runtimes: [new NativeRuntime({ captures: ['train'], machine: Object.keys(boxes)[0] ?? '' })],
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
      const said = DEC.decode((await ws.shell('ps f -o pid,ppid,machine,mpid,cmd')).stdout)
      const rows = said
        .trimEnd()
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
      expect(rows[0]).toEqual(['PID', 'PPID', 'MACHINE', 'MPID', 'CMD'])
      expect(rows.slice(1).map((row) => row.slice(1, 5))).toEqual([
        ['0', '-', '-', 'ps'],
        [shell, 'box:a', '412', '\\_'],
        [String(pid), 'box:a', '413', '\\_'],
      ])
      expect(rows[2]?.[0]).toBe(String(pid))
      const found = ws.processTable.records().at(-1)
      expect([found?.runtime, found?.parent]).toEqual([null, pid])
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
    const box = new Sleeper('a')
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
    const b = new Sleeper('b', 500)
    const ws = sleepers({ a, b })
    try {
      const pid = DEC.decode((await ws.shell('train 1 & echo $!')).stdout).trim()
      await started(a)
      let said = await ws.shell('ps -p 412 -o pid=; kill -0 412; echo $?')
      expect(DEC.decode(said.stdout).trim().split(/\s+/)).toEqual([pid, '0'])
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
      b.rows = b.rows.slice(0, 1).map((row) => ({ ...row, pid: 412, started: 9, args: 'x' }))
      said = await ws.shell('kill 412')
      expect(said.exitCode).toBe(1)
      expect(DEC.decode(said.stderr)).toBe('bash: line 1: kill: 412: ambiguous job spec\n')
    } finally {
      a.finish()
      b.finish()
      await ws.close()
    }
  })
})
