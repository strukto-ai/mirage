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
import { RemoteRuntime } from '../../runtime/machine/runtime.ts'
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
      runtimes: [new RemoteRuntime({ captures: ['hostname'], machine: 'a' }), 'workspace'],
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
      runtimes: [new RemoteRuntime({ captures: ['@line'], machine: 'a' })],
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

class MontyOnB implements Policy {
  preExecute(): Route {
    return { kind: 'route', runtime: 'monty', machine: 'b' }
  }
}

function withMonty(...policies: Policy[]): Workspace {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: { a: new Box('a'), b: new Box('b') },
      runtimes: [new RemoteRuntime({ captures: ['hostname'], machine: 'a' }), 'monty', 'workspace'],
      policies,
    },
  )
}

class HostnameOnMontyOnB implements Policy {
  preCommand(ctx: CommandContext): Route | null {
    return ctx.command === 'hostname' ? { kind: 'route', runtime: 'monty', machine: 'b' } : null
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
      expect(said.decision?.reason.startsWith('ShortOnB routes hostname elsewhere')).toBe(true)
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
      expect(said.decision).toEqual(run.decision)
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
        runtimes: [new RemoteRuntime({ captures: ['@line'], machine: 'a' }), 'monty'],
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
      expect(said.decision?.reason).toContain('ShortOnB on machine b')
      expect(said.decision?.reason).toContain('OnA on machine a')
    } finally {
      await ws.close()
    }
  })

  it('explains the machine each command runs on', async () => {
    const ws = workspace(new ShortOnB())
    try {
      const said = await ws.explain('hostname; hostname -s; ls')
      expect([...commands(said.node)].map((c) => [c.command, c.runtime, c.machine])).toEqual([
        ['hostname', 'remote:a', 'box:a'],
        ['hostname', 'remote:a', 'box:b'],
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
        runtimes: [new RemoteRuntime({ captures: ['nohup', 'hostname'], machine: 'a' })],
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
      expect(wrapper?.decision).toEqual(run.decision)
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
        expect(stopped?.decision?.reason).toBe(answer.reason)
        expect(run.decision?.reason).toBe(answer.reason)
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
      await ws.decisions.answer(first.decision?.askId ?? '', Outcome.ALLOW, Scope.SESSION)
      const said = await ws.explain('nohup hostname')
      const wrapper = [...commands(said.node)].find((c) => c.command === 'nohup')
      const run = await ws.shell('nohup hostname')
      expect([wrapper?.outcome, wrapper?.exitCode]).toEqual([Outcome.DENY, 126])
      expect(wrapper?.decision).toEqual(run.decision)
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

  it('refuses a route to a machine its runtime does not run on', async () => {
    const refusal = "runtime 'monty' runs on the workspace's machine"
    let ws = withMonty(new MontyOnB())
    try {
      await expect(ws.shell('hostname')).rejects.toThrow(RouteError)
      await expect(ws.shell('hostname')).rejects.toThrow(refusal)
    } finally {
      await ws.close()
    }
    ws = withMonty()
    try {
      await expect(ws.shell('hostname', { runtime: 'monty', machine: 'b' })).rejects.toThrow(
        refusal,
      )
    } finally {
      await ws.close()
    }
  })

  it('refuses a route to a machine when no remote runtime runs on one', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: { b: new Box('b') },
        runtimes: ['monty', 'workspace'],
        policies: [new OnB()],
      },
    )
    try {
      await expect(ws.shell('echo hi')).rejects.toThrow("machine 'b' takes the remote runtime")
    } finally {
      await ws.close()
    }
  })

  it("keeps the line's machine for a command routed to a local runtime", async () => {
    const ws = withMonty(new HostnameOnMonty())
    try {
      const said = await ws.shell('hostname', { machine: 'b' })
      expect([said.exitCode, DEC.decode(said.stdout)]).toEqual([0, 'b\n'])
    } finally {
      await ws.close()
    }
  })

  it('explains a command route to a machine its runtime does not run on as a RouteError', async () => {
    const ws = withMonty(new HostnameOnMontyOnB())
    try {
      await expect(ws.explain('hostname')).rejects.toThrow(RouteError)
    } finally {
      await ws.close()
    }
  })

  // Each remote entry is named for its machine, so a workspace holds one per
  // machine and each program goes to the entry that captures it.
  it('gives each machine a remote entry of its own', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: { a: new Box('a'), b: new Box('b') },
        runtimes: [
          new RemoteRuntime({ captures: ['python3'], machine: 'a' }),
          new RemoteRuntime({ captures: ['node'], machine: 'b' }),
        ],
      },
    )
    try {
      expect(ws.runtimes().map((r) => r.name)).toEqual(['remote:a', 'remote:b', 'workspace'])
      const said = await ws.shell('python3 x.py; node x.js; python3 x.py | node')
      expect(DEC.decode(said.stdout)).toBe('a\nb\nb\n')
      const named = await ws.shell('node x.js', { runtime: 'remote:b' })
      expect(DEC.decode(named.stdout)).toBe('b\n')
      await expect(ws.shell('node x.js', { runtime: 'remote' })).rejects.toThrow(
        /ambiguous runtime: 'remote'/,
      )
    } finally {
      await ws.close()
    }
  })

  // A program two remote entries both capture goes to the first listed, on
  // every line, after an entry is added, and to the next once it is removed.
  it('keeps what two remote entries capture on the first', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: { a: new Box('a'), b: new Box('b'), c: new Box('c') },
        runtimes: [new RemoteRuntime({ machine: 'a' }), new RemoteRuntime({ machine: 'b' })],
      },
    )
    try {
      expect(DEC.decode((await ws.shell('train; train')).stdout)).toBe('a\na\n')
      ws.addRuntime(new RemoteRuntime({ machine: 'c' }))
      expect(ws.runtimes().map((r) => r.name)).toEqual([
        'remote:a',
        'remote:b',
        'remote:c',
        'workspace',
      ])
      expect(DEC.decode((await ws.shell('train')).stdout)).toBe('a\n')
      await ws.removeRuntime('remote:a')
      expect(DEC.decode((await ws.shell('train')).stdout)).toBe('b\n')
    } finally {
      await ws.close()
    }
  })

  // A stage's one program records its own words, expanded, as bash's exec
  // does, so each pass of a loop names what it ran.
  it("records each loop pass's program with its expanded words", async () => {
    const ws = workspace()
    try {
      const said = await ws.shell('for i in 1 2; do hostname -s$i | cat; done')
      expect(DEC.decode(said.stdout)).toBe('a\na\n')
      const commands = (await ws.processes()).map((p) => p.command)
      expect(commands.filter((c) => c.startsWith('hostname'))).toEqual([
        'hostname -s1',
        'hostname -s2',
      ])
    } finally {
      await ws.close()
    }
  })

  // What a program reads from another names the process writing it: the stage
  // before it as its stdin, a `<( )` by the descriptor it got, a `$( )` as its
  // arguments.
  it('names the processes a program reads from', async () => {
    const ws = workspace()
    try {
      const read = new Map<string, unknown>()
      for (const [line, reader] of [
        ['hostname | hostname', 'hostname'],
        ['hostname <(hostname); true', 'hostname /dev/fd/63'],
        ['hostname "$(hostname)"; true', 'hostname a'],
      ] as const) {
        expect(DEC.decode((await ws.shell(line)).stdout)).toBe('a\n')
        const ran = new Map((await ws.processes()).map((p) => [p.id.pid, p]))
        const program = [...ran.values()]
          .filter((p) => p.command === reader && p.runtime !== null)
          .at(-1)
        const named = (pid: number) => ran.get(pid)?.command
        read.set(line, [
          program?.stdin == null ? null : named(program.stdin),
          Object.fromEntries(
            Object.entries(program?.fd ?? {}).map(([fd, pid]) => [fd, named(pid)]),
          ),
          (program?.argv ?? []).map(named),
        ])
      }
      expect(Object.fromEntries(read)).toEqual({
        'hostname | hostname': ['hostname', {}, []],
        'hostname <(hostname); true': [null, { 63: 'hostname' }, []],
        'hostname "$(hostname)"; true': [null, {}, ['hostname']],
      })
    } finally {
      await ws.close()
    }
  })

  // A forked shell's last program runs in the shell's place, as bash execs it
  // there: a subshell's and a substitution's leave no shell between it and the
  // line, a line's own stays its session's `$$`.
  it("runs a forked shell's last program as the shell", async () => {
    const ws = workspace()
    try {
      for (const line of ['(true; hostname); true', 'x=$(hostname); echo $x'])
        expect(DEC.decode((await ws.shell(line)).stdout)).toBe('a\n')
      const shell = Number(DEC.decode((await ws.shell('echo $$')).stdout))
      const programs = (await ws.processes()).filter((p) => p.runtime !== null && p.line !== null)
      expect(programs.map((p) => [p.command, p.parent])).toEqual([
        ['hostname', shell],
        ['hostname', shell],
      ])
      await ws.shell('hostname')
      const line = (await ws.processes()).filter((p) => p.command === 'hostname').at(-1)
      expect(line?.parent).toBe(shell)
    } finally {
      await ws.close()
    }
  })
})
