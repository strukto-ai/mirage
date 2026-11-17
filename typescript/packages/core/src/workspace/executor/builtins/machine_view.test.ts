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
import { SHELL_SPECS } from '../../../commands/spec/shell.ts'
import { ProcessTable } from '../../../execution/process/table.ts'
import { IOResult } from '../../../io/types.ts'
import { ExecutionNode } from '../../types.ts'
import { Runtime } from '../../../runtime/base.ts'
import { HOST } from '../../../runtime/constants.ts'
import { buildEntry } from '../../../runtime/table.ts'
import { MachineName } from '../../../execution/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { Workspace } from '../../workspace/workspace.ts'
import {
  inScope,
  machineScope,
  optionRefusal,
  permutedOptions,
  processScope,
  tellOnce,
  withMachine,
} from './machine_view.ts'

function table(...ids: string[]): ProcessTable {
  const processes = new ProcessTable({ workspaceId: 'w' } as never)
  processes.machineNames = () => ids
  return processes
}

describe('machine view', () => {
  it('answers for every machine without a name', () => {
    const scope = machineScope(table('docker:a', 'e2b:b'), null)
    expect(scope).toEqual({
      ids: ['docker:a', 'e2b:b'],
      picked: false,
      several: true,
      workspace: false,
      engines: [],
    })
  })

  it('picks one by name or id', () => {
    const processes = table('docker:a', 'e2b:b')
    expect(machineScope(processes, 'b')).toEqual({
      ids: ['e2b:b'],
      picked: true,
      several: false,
      workspace: false,
      engines: [],
    })
    expect(machineScope(processes, 'e2b:b')).toEqual({
      ids: ['e2b:b'],
      picked: true,
      several: false,
      workspace: false,
      engines: [],
    })
  })

  it('picks none for an unknown name', () => {
    expect(machineScope(table('docker:a'), 'nosuch')).toBeNull()
  })

  it('is empty without machines', () => {
    expect(machineScope(table(), null)).toEqual({
      ids: [],
      picked: false,
      several: false,
      workspace: false,
      engines: [],
    })
  })

  it('lets the workspace answer ahead of one machine', () => {
    expect(machineScope(table('docker:a'), null, true)).toEqual({
      ids: ['docker:a'],
      picked: false,
      several: true,
      workspace: true,
      engines: [],
    })
  })

  it('keeps the workspace alone to one row', () => {
    expect(machineScope(table(), null, true)).toEqual({
      ids: [],
      picked: false,
      several: false,
      workspace: true,
      engines: [],
    })
  })

  it('takes mirage as the workspace only where it answers', () => {
    const processes = table('docker:a')
    expect(machineScope(processes, 'mirage', true)).toEqual({
      ids: [],
      picked: true,
      several: false,
      workspace: true,
      engines: [],
    })
    expect(machineScope(processes, 'mirage')).toBeNull()
  })

  it("takes mirage as Mirage's own for a process search", () => {
    const processes = table('docker:a')
    expect(processScope(processes, 'mirage')).toEqual({
      ids: [],
      picked: true,
      several: false,
      workspace: true,
      engines: [],
    })
    expect(processScope(processes, 'a')?.ids).toEqual(['docker:a'])
    expect(processScope(processes, 'nosuch')).toBeNull()
  })

  it("keeps Mirage's own in scope unless another machine is picked", () => {
    const one = { ids: ['docker:a'], picked: false, several: false, workspace: false, engines: [] }
    expect(inScope(one, 'mirage')).toBe(true)
    expect(inScope(one, 'docker:a')).toBe(true)
    expect(inScope({ ...one, picked: true }, 'mirage')).toBe(false)
    const own = { ids: [], picked: true, several: false, workspace: true, engines: [] }
    expect(inScope(own, 'mirage')).toBe(true)
    expect(inScope(own, 'docker:a')).toBe(false)
    expect(inScope(one, 'monty_remote:py')).toBe(true)
    expect(inScope({ ...one, picked: true }, 'monty_remote:py')).toBe(false)
  })

  it('reads options that follow operands', () => {
    const parse = permutedOptions(SHELL_SPECS.pgrep as never, ['sleep', '-c', '-f'])
    expect(parse.operands).toEqual(['sleep'])
    expect([parse.flags.c, parse.flags.f]).toEqual([true, true])
  })

  it('reads every word after a double dash as an operand', () => {
    const named = permutedOptions(SHELL_SPECS.killall as never, ['--', 'sleep', '--signal', 'KILL'])
    expect(named.operands).toEqual(['sleep', '--signal', 'KILL'])
    expect(named.flags.s).toBeUndefined()
    const later = permutedOptions(SHELL_SPECS.pgrep as never, ['sleep', '--', '-c'])
    expect(later.operands).toEqual(['sleep', '-c'])
    expect(later.flags.c).toBeUndefined()
  })

  it('keeps a double dash an option takes as its value', () => {
    const parse = permutedOptions(SHELL_SPECS.pgrep as never, ['-d', '--', 'sleep', '-c'])
    expect(parse.operands).toEqual(['sleep'])
    expect([parse.flags.d, parse.flags.c]).toEqual(['--', true])
  })

  it('names the option it refuses', () => {
    const parse = permutedOptions(SHELL_SPECS.top as never, ['-Z'])
    expect(optionRefusal('top', parse, false)).toBe("top: invalid option -- 'Z'\n")
  })

  it('pads to the columns', () => {
    expect(withMachine('ab  ', 'm', 6)).toBe('ab      m')
  })

  it('tells a later error once, after what stderr holds', async () => {
    const enc = new TextEncoder()
    const down = 'free: e2b:down: machine did not answer\n'
    const gone = 'free: e2b:gone: machine did not answer\n'
    const cut = 'free: output truncated\n'
    const node = new ExecutionNode({ command: 'free', stderr: enc.encode(down) })
    const io = new IOResult({ stderr: enc.encode(down + cut) })
    await tellOnce(io, node, down + gone)
    await tellOnce(io, node, gone)
    expect(io.stderr).toEqual(enc.encode(down + cut + gone))
    expect(node.stderr).toEqual(enc.encode(down + gone))
    expect([io.exitCode, node.exitCode]).toEqual([1, 1])
  })
})

/** An engine in Mirage's process, on the workspace's own reach. */
class OwnReach extends Runtime {
  readonly name = 'engine'
  override readonly reach = 'workspace'

  constructor() {
    super({}, ['hold'])
  }
}

/** An engine in Mirage's process, on the process reach. */
class ProcessReach extends Runtime {
  readonly name = 'engine'

  constructor() {
    super({}, ['hold'])
  }
}

async function shown(ws: Workspace, line: string): Promise<string> {
  return (await ws.shell(line)).stdoutText
}

describe('an engine', () => {
  it("lists no machine on the workspace's reach", async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, machines: [new OwnReach()] },
    )
    try {
      expect(await shown(ws, 'nproc')).toBe('1\n')
      expect(await shown(ws, 'hostname')).toBe('mirage\n')
      expect(await shown(ws, 'free')).not.toContain('in_process')
    } finally {
      await ws.close()
    }
  })

  it('lists a remote monty as an engine', async () => {
    const [, remote] = buildEntry('py', { provider: 'monty_remote', url: 'http://127.0.0.1:1' })
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, machines: [new ProcessReach(), remote] },
    )
    try {
      expect(await shown(ws, 'nproc')).toContain('1  monty_remote:py\n')
    } finally {
      await ws.close()
    }
  })

  it('answers as the workspace, never as the server', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, machines: [new ProcessReach()] },
    )
    try {
      expect(await shown(ws, 'nproc')).toBe('1  mirage\n1  in_process:engine\n')
      expect(await shown(ws, 'nproc --machine engine')).toBe('1\n')
      expect(await shown(ws, 'hostname')).toBe('mirage\nmirage\n')
      expect(await shown(ws, 'lscpu')).toBe(
        '             mirage         in_process:engine\n' +
          'Byte Order:  Little Endian  Little Endian\n' +
          'CPU(s):      1              1\n',
      )
      expect(await shown(ws, 'free')).toContain('in_process:engine')
      expect(await shown(ws, 'uptime')).toBe('')
    } finally {
      await ws.close()
    }
  })
})

/** A runtime whose programs run on the host, under its entry's name. */
class HostRun extends Runtime {
  readonly name = 'run'

  constructor() {
    super({}, ['perl'])
  }

  override get machine(): MachineName {
    return new MachineName(HOST, this.name)
  }
}

it('has a script read the engine programs run on by default', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, machines: [new ProcessReach(), new HostRun()] },
  )
  try {
    expect(await shown(ws, 'echo $(hostname) $(nproc)')).toBe('mirage 1\n')
    expect(await shown(ws, 'hostname')).toMatch(/^mirage\nmirage\n/)
  } finally {
    await ws.close()
  }
})
