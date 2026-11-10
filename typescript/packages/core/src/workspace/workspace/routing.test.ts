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
import {
  Outcome,
  Scope,
  type Action,
  type CommandContext,
  type CommandExplanation,
  type Route,
  type ShellNode,
} from '../../policy/types.ts'
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

function whole(...policies: Policy[]): Workspace {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: { a: new Box('a'), b: new Box('b') },
      runtimes: [new MachineRuntime({ captures: ['@line'], machine: 'a' })],
      policies,
    },
  )
}

class ProgramOnB implements Policy {
  preCommand(ctx: CommandContext): Route | null {
    return ctx.command === 'hostname' ? { kind: 'route', machine: 'b' } : null
  }
}

class WrapperApart implements Policy {
  preCommand(ctx: CommandContext): Route | null {
    if (ctx.command === 'nohup') return { kind: 'route', machine: 'a' }
    return ctx.command === 'hostname' ? { kind: 'route', machine: 'b' } : null
  }
}

class Answers implements Policy {
  constructor(
    private readonly command: string,
    private readonly answer: Action,
  ) {}

  preCommand(ctx: CommandContext): Action | null {
    return ctx.command === this.command ? this.answer : null
  }
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

class HostnameOnMonty implements Policy {
  preCommand(ctx: CommandContext): Route | null {
    return ctx.command === 'hostname' ? { kind: 'route', runtime: 'monty' } : null
  }
}

class EvalOnB implements Policy {
  preCommand(ctx: CommandContext): Route | null {
    return ctx.command === 'eval' ? { kind: 'route', machine: 'b' } : null
  }
}

function* commands(node: ShellNode | CommandExplanation): Generator<CommandExplanation> {
  for (const child of node.children) {
    if ('command' in child) yield child
    yield* commands(child)
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

  it('keeps the machine a command route names for the lines it runs', async () => {
    const ws = workspace(new EvalOnB())
    try {
      const said = await ws.shell('hostname; eval hostname; hostname')
      expect(DEC.decode(said.stdout)).toBe('a\nb\na\n')
    } finally {
      await ws.close()
    }
  })

  it('refuses a line run whole when a route places a command off it', async () => {
    const ws = whole(new ShortOnB())
    try {
      expect(DEC.decode((await ws.shell('hostname; hostname')).stdout)).toBe('a\n')
      const said = await ws.shell('hostname; hostname -s')
      expect([said.exitCode, DEC.decode(said.stdout)]).toEqual([126, ''])
      expect(said.refusal?.reason.startsWith('ShortOnB routes hostname elsewhere')).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('explains a line run whole refused for a route', async () => {
    const ws = whole(new ShortOnB())
    try {
      const kept = await ws.explain('hostname; hostname')
      expect([kept.outcome, kept.exitCode]).toEqual([Outcome.ALLOW, 0])
      const said = await ws.explain('hostname; hostname -s')
      const run = await ws.shell('hostname; hostname -s')
      expect([said.outcome, said.exitCode]).toEqual([Outcome.DENY, 126])
      expect(said.refusal).toEqual(run.refusal)
      expect(said.stderr).toBe(DEC.decode(run.stderr))
    } finally {
      await ws.close()
    }
  })

  it('keeps a line run whole under a route that moves nothing', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: { a: new Box('a') },
        runtimes: [new MachineRuntime({ captures: ['@line'], machine: 'a' }), 'monty'],
        policies: [new HostnameOnMonty()],
      },
    )
    try {
      expect(DEC.decode((await ws.shell('hostname')).stdout)).toBe('a\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps a route to where a line run whole runs', async () => {
    const ws = whole(new OnA())
    try {
      expect(DEC.decode((await ws.shell('hostname -s')).stdout)).toBe('a\n')
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

  it('explains a wrapper where its program is placed', async () => {
    const ws = workspace(new ProgramOnB())
    try {
      const said = await ws.explain('nohup hostname')
      expect([...commands(said.node)].map((c) => [c.command, c.machine])).toEqual([
        ['nohup', 'box:b'],
        ['hostname', 'box:b'],
      ])
    } finally {
      await ws.close()
    }
  })

  it('explains a shell line under a wrapper as moving nothing', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: { a: new Box('a'), b: new Box('b') },
        runtimes: [new MachineRuntime({ captures: ['nohup', 'hostname'], machine: 'a' })],
        policies: [new ProgramOnB()],
      },
    )
    try {
      const said = await ws.explain('nohup sh -c hostname')
      const [first] = [...commands(said.node)]
      expect([first?.command, first?.machine]).toEqual(['nohup', 'box:a'])
      expect(DEC.decode((await ws.shell('nohup sh -c hostname')).stdout)).toBe('a\n')
    } finally {
      await ws.close()
    }
  })

  it('explains a wrapper whose routes disagree as refused', async () => {
    const ws = workspace(new WrapperApart())
    try {
      const said = await ws.explain('nohup hostname; echo after')
      const nodes = [...commands(said.node)]
      const wrapper = nodes.find((c) => c.command === 'nohup')
      const run = await ws.shell('nohup hostname')
      expect([wrapper?.outcome, wrapper?.exitCode]).toEqual([Outcome.DENY, 126])
      expect(wrapper?.refusal).toEqual(run.refusal)
      expect(wrapper?.stderr).toBe(DEC.decode(run.stderr))
      const echo = nodes.find((c) => c.command === 'echo')
      expect([echo?.outcome, echo?.exitCode]).toEqual([Outcome.ALLOW, 0])
    } finally {
      await ws.close()
    }
  })

  it.each([
    ['nohup', { kind: 'ask', reason: 'sign-off' }, Outcome.ASK],
    ['hostname', { kind: 'ask', reason: 'sign-off' }, Outcome.ASK],
    ['nohup', { kind: 'deny', reason: 'no' }, Outcome.DENY],
  ] as const)(
    'keeps what stops a wrapper before its routes: %s %j',
    async (name, answer, outcome) => {
      const ws = workspace(new Answers(name, answer), new WrapperApart())
      try {
        const said = await ws.explain('nohup hostname')
        const nodes = [...commands(said.node)]
        const stopped = nodes.find((c) => c.command === name)
        const wrapper = nodes.find((c) => c.command === 'nohup')
        const run = await ws.shell('nohup hostname')
        expect(stopped?.outcome).toBe(outcome)
        expect(stopped?.refusal?.reason).toBe(answer.reason)
        expect(run.refusal?.reason).toBe(answer.reason)
        expect(wrapper?.outcome).toBe(name === 'nohup' ? outcome : Outcome.ALLOW)
      } finally {
        await ws.close()
      }
    },
  )

  it('explains disagreeing routes as refused once an approval is given', async () => {
    const ws = workspace(
      new Answers('nohup', { kind: 'ask', reason: 'sign-off' }),
      new WrapperApart(),
    )
    try {
      const first = await ws.shell('nohup hostname')
      await ws.decisions.answer(first.refusal?.askId ?? '', Outcome.ALLOW, Scope.SESSION)
      const said = await ws.explain('nohup hostname')
      const wrapper = [...commands(said.node)].find((c) => c.command === 'nohup')
      const run = await ws.shell('nohup hostname')
      expect([wrapper?.outcome, wrapper?.exitCode]).toEqual([Outcome.DENY, 126])
      expect(wrapper?.refusal).toEqual(run.refusal)
    } finally {
      await ws.close()
    }
  })

  it('explains the machine a routed eval runs its line on', async () => {
    const ws = workspace(new EvalOnB())
    try {
      const said = await ws.explain('hostname; eval hostname')
      expect([...commands(said.node)].map((c) => [c.command, c.machine])).toEqual([
        ['hostname', 'box:a'],
        ['eval', ''],
        ['hostname', 'box:b'],
      ])
    } finally {
      await ws.close()
    }
  })
})
