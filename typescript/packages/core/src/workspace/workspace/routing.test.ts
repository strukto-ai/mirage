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
import { MachineHandle } from '../../machine/handle.ts'
import type { Policy } from '../../policy/base.ts'
import type { CommandContext, CommandExplanation, Route, ShellNode } from '../../policy/types.ts'
import { MachineRuntime } from '../../runtime/machine/runtime.ts'
import { RouteError } from '../../runtime/routing/index.ts'
import type { RunResult } from '../../runtime/types.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from './workspace.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

class Box extends MachineHandle {
  static override readonly provider = 'box'

  connect(): Promise<void> {
    return Promise.resolve()
  }

  protected override execArgv(): Promise<RunResult> {
    return Promise.resolve({ stdout: ENC.encode(`${this.name}\n`), stderr: null, exitCode: 0 })
  }
}

function workspace(...policies: Policy[]): Workspace {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: { a: new Box('a'), b: new Box('b') },
      runtimes: [new MachineRuntime({ captures: ['hostname'], machine: 'a' }), 'workspace'],
      policies,
    },
  )
}

class OnB implements Policy {
  preExecute(): Route {
    return { kind: 'route', machine: 'b', reason: 'the other box' }
  }
}

class ShortOnB implements Policy {
  preCommand(ctx: CommandContext): Route | null {
    return ctx.argv.includes('-s') ? { kind: 'route', machine: 'b' } : null
  }
}

class OnA implements Policy {
  preCommand(): Route {
    return { kind: 'route', machine: 'a' }
  }
}

function* commands(node: ShellNode): Generator<CommandExplanation> {
  for (const child of node.children) {
    if ('command' in child) yield child
    else yield* commands(child)
  }
}

describe('routing on machines', () => {
  it('runs a line on the machine it names', async () => {
    const ws = workspace()
    try {
      expect(DEC.decode((await ws.shell('hostname')).stdout)).toBe('a\n')
      expect(DEC.decode((await ws.shell('hostname', { machine: 'b' })).stdout)).toBe('b\n')
      await expect(ws.shell('hostname', { machine: 'c' })).rejects.toThrow(RouteError)
      await expect(ws.shell('hostname', { machine: 'c' })).rejects.toThrow("unknown machine: 'c'")
    } finally {
      await ws.close()
    }
  })

  it('places a line on a machine a route names', async () => {
    const ws = workspace(new OnB())
    try {
      expect(DEC.decode((await ws.shell('hostname')).stdout)).toBe('b\n')
    } finally {
      await ws.close()
    }
  })

  it('places one command on the machine its command route names', async () => {
    const ws = workspace(new ShortOnB())
    try {
      const said = await ws.shell('hostname; hostname -s; hostname')
      expect(DEC.decode(said.stdout)).toBe('a\nb\na\n')
    } finally {
      await ws.close()
    }
  })

  it('refuses a command two routes disagree on', async () => {
    const ws = workspace(new ShortOnB(), new OnA())
    try {
      const said = await ws.shell('hostname -s')
      expect(said.exitCode).toBe(126)
      expect(said.refusal?.reason).toContain('ShortOnB on machine b')
      expect(said.refusal?.reason).toContain('OnA on machine a')
    } finally {
      await ws.close()
    }
  })

  it('explains the machine each command runs on', async () => {
    const ws = workspace(new ShortOnB())
    try {
      const said = await ws.explain('hostname; hostname -s; ls')
      expect([...commands(said.node)].map((c) => [c.command, c.runtime, c.machine])).toEqual([
        ['hostname', 'machine', 'box:a'],
        ['hostname', 'machine', 'box:b'],
        ['ls', '', ''],
      ])
    } finally {
      await ws.close()
    }
  })
})
