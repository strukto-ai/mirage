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
import type { Context } from '../../commands/config.ts'
import { materialize } from '../../io/types.ts'
import { MachineHandle } from '../../machine/handle.ts'
import type { Policy } from '../../policy/base.ts'
import { Outcome, Scope } from '../../policy/index.ts'
import type { CommandContext, Route } from '../../policy/types.ts'
import { MachineRuntime } from '../../runtime/machine/runtime.ts'
import { Runtime } from '../../runtime/base.ts'
import { EXTERNAL_COMMANDS } from '../../runtime/constants.ts'
import { LanguageRuntime } from '../../runtime/language.ts'
import { PROCESS_EXECUTOR, type ProcessExecutorMixin } from '../../runtime/mixin.ts'
import type { RunResult } from '../../runtime/types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { parse, syntaxRefusal } from '../../shell/parse/parse.ts'
import { Workspace } from '../workspace/workspace.ts'
import { parserAliases } from './command_dispatch.ts'

const DEC = new TextDecoder()

function makeWs(mounts: Record<string, RAMVFS> = { '/data': new RAMVFS() }): Workspace {
  return new Workspace(mounts, {
    mode: MountMode.WRITE,
  })
}

function text(bytes: Uint8Array | null): string {
  return bytes === null ? '' : DEC.decode(bytes)
}

describe('the empty operand', () => {
  it('is removed by nothing, rm -f included', async () => {
    // rm -f silences the empty name's ENOENT, and the bookkeeping after a
    // clean rm used to purge the node table under its `virtual`, the
    // working directory, taking every link there with it.
    const ws = makeWs()
    await ws.shell('mkdir -p /data/d; echo x > /data/d/f; ln -s f /data/d/l')
    const r = await ws.shell("cd /data/d && rm -rf ''")
    expect(r.exitCode).toBe(0)
    expect(ws.namespace.isLink('/data/d/l')).toBe(true)
    expect(text((await ws.shell('cat /data/d/f')).stdout)).toBe('x\n')
  })

  it('routes nowhere, so the line is not cross-mount', async () => {
    // Its `virtual` is the working directory, here the root mount, which
    // used to make the line span mounts it never names.
    const ws = makeWs()
    await ws.shell('echo a > /data/a.txt')
    const r = await ws.shell("cd / && cat '' /data/a.txt")
    expect(r.exitCode).toBe(1)
    expect(text(r.stdout)).toBe('a\n')
    expect(text(r.stderr)).toBe("cat: '': No such file or directory\n")
  })

  it('does not fan out over the mounts under the cwd', async () => {
    const ws = makeWs({ '/base': new RAMVFS(), '/base/inner': new RAMVFS() })
    for (const [line, err] of [
      ["du ''", 'du: invalid zero-length file name\n'],
      ["find ''", "find: '': No such file or directory\n"],
    ] as const) {
      const r = await ws.shell(`cd /base && ${line}`)
      expect(r.exitCode).toBe(1)
      expect(text(r.stdout)).toBe('')
      expect(text(r.stderr)).toBe(err)
    }
  })
})

describe('a link loop', () => {
  it('fails its operand, not the line', async () => {
    const ws = makeWs()
    await ws.shell(
      'echo a > /data/a.txt; echo b > /data/b.txt; ln -s /data/l2 /data/l1; ln -s /data/l1 /data/l2',
    )
    const r = await ws.shell('cat /data/a.txt /data/l1 /data/b.txt')
    expect(r.exitCode).toBe(1)
    expect(text(r.stdout)).toBe('a\nb\n')
    expect(text(r.stderr)).toBe('cat: /data/l1: Too many levels of symbolic links\n')
  })
})

class ShellsOut extends LanguageRuntime {
  readonly language = 'python'
  readonly name = 'shellsout'
  constructor() {
    super({ captures: ['python3'] })
  }
  async interpret(_engine: unknown, _program: unknown, ctx: Context): Promise<RunResult> {
    const nested = await ctx.shell?.('printenv TOKEN')
    return { stdout: await materialize(nested?.stdout ?? null), stderr: null, exitCode: 0 }
  }
}

// A run starts as its output is read, after dispatch returned, and the lines
// it shells out still run under its prefix assignment.
describe('a prefix assignment', () => {
  it.each(['TOKEN=one python3 -c x', 'TOKEN=one python3 -c x | cat'])(
    'reaches the lines %s shells out',
    async (line) => {
      const ws = new Workspace(
        { '/data': new RAMVFS() },
        { mode: MountMode.EXEC, runtimes: [new ShellsOut()] },
      )
      try {
        expect(text((await ws.shell(line)).stdout)).toBe('one\n')
        expect(text((await ws.shell('echo "[$TOKEN]"')).stdout)).toBe('[]\n')
      } finally {
        await ws.close()
      }
    },
  )
})

// Pinned against bash 5.2.37: a name stays reserved only inside the text its
// alias put there, a trailing blank's chained one included. Spans are in the
// line as typed, which a continuation shifts.
it.each([
  [
    'echo F; fi',
    [['fi', 0, 10]],
    "bash: -c: line 1: syntax error near unexpected token `fi'\nbash: -c: line 1: `echo F; fi'\n",
  ],
  ['echo F; fi', [['fi', 0, 7]], null],
  [
    'echo C; fi echo F',
    [
      ['c', 0, 11],
      ['fi', 11, 17],
    ],
    null,
  ],
  [
    'echo C; echo F; fi',
    [
      ['c', 0, 8],
      ['fi', 8, 18],
    ],
    "bash: -c: line 1: syntax error near unexpected token `fi'\nbash: -c: line 1: `echo C; echo F; fi'\n",
  ],
  [
    'echo F \\\n; fi',
    [['fi', 0, 13]],
    "bash: -c: line 2: syntax error near unexpected token `fi'\nbash: -c: line 2: `; fi'\n",
  ],
  ['echo F \\\n; fi', [['fi', 0, 10]], null],
] as [string, [string, number, number][], string | null][])(
  'reads %j with alias text %j as %j',
  (line, spans, stderr) => {
    const owners = Array.from(
      { length: line.length },
      (_, at) =>
        new Set(spans.filter(([, start, end]) => start <= at && at < end).map(([name]) => name)),
    )
    const aliases = parserAliases(line, new Set(spans.map(([name]) => name)), owners)
    const io = syntaxRefusal(parse(line, aliases), 'bash: -c: ', 1, true)
    expect(io === null ? null : new TextDecoder().decode(io.stderr as Uint8Array)).toBe(stderr)
  },
)

class Box extends Runtime implements ProcessExecutorMixin {
  readonly [PROCESS_EXECUTOR] = true as const
  readonly name: string = 'box'
  readonly ran: string[][] = []
  constructor(captures: string[] = [EXTERNAL_COMMANDS]) {
    super({}, captures)
  }
  runProcess(_engine: unknown, _paths: unknown, texts: string[]): Promise<RunResult> {
    this.ran.push([...texts])
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })
  }
}

const WRAPPERS = ['nohup', 'nice', 'stdbuf', 'setsid', 'ionice']

async function withBox(
  profile: Record<string, unknown>,
  run: (ws: Workspace, box: Box) => Promise<void>,
): Promise<void> {
  const box = new Box()
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC, runtimes: [box] })
  try {
    ws.createSession('s', { profile })
    await run(ws, box)
  } finally {
    await ws.close()
  }
}

// A wrapper a runtime outside Mirage runs execs its program there, so the
// program is admitted as `env`, `timeout` and `command` have theirs admitted.
describe('a wrapper run outside Mirage', () => {
  it.each([
    'nohup python3 -c x',
    'nice -n 5 python3 -c x',
    'stdbuf -oL python3 -c x',
    'setsid -w python3 -c x',
    'ionice -c 3 python3 -c x',
    'nohup nice python3 -c x',
    'nohup python3 -c x & wait $!',
    'nohup time python3 -c x',
    'nohup nice time -p python3 -c x',
    'nohup time env python3 -c x',
  ])('runs no program the allow list leaves out: %s', async (line) => {
    await withBox(
      { commands: { allow: [...WRAPPERS, 'wait', 'time', 'env'] } },
      async (ws, box) => {
        const bare = await ws.shell('python3 -c x', { sessionId: 's' })
        const io = await ws.shell(line, { sessionId: 's' })
        expect(bare.exitCode).toBe(126)
        expect([io.exitCode, text(io.stderr)]).toEqual([126, text(bare.stderr)])
        expect(box.ran).toEqual([])
      },
    )
  })

  it('admits every wrapper it runs', async () => {
    await withBox({ commands: { allow: ['nohup', 'python3'] } }, async (ws, box) => {
      const io = await ws.shell('nohup nice python3 -c x', { sessionId: 's' })
      expect(io.exitCode).toBe(126)
      expect(text(io.stderr).startsWith('nice: ')).toBe(true)
      expect(box.ran).toEqual([])
    })
  })

  it.each([
    'nohup python3 -c x',
    'nohup --help',
    'nohup -- python3 -c x',
    'nice --ad 5 python3 -c x',
  ])('runs a listed program: %s', async (line) => {
    await withBox({ commands: { allow: ['nohup', 'nice', 'python3'] } }, async (ws, box) => {
      const io = await ws.shell(line, { sessionId: 's' })
      expect(io.exitCode).toBe(0)
      expect(box.ran).toEqual([line.split(' ')])
    })
  })

  it("reads its program's operands", async () => {
    const profile = { commands: { deny: [{ reason: 'secret', paths: ['/data/secret.py'] }] } }
    await withBox(profile, async (ws, box) => {
      const bare = await ws.shell('cd /data && python3 secret.py', { sessionId: 's' })
      const io = await ws.shell('cd /data && nohup python3 secret.py', { sessionId: 's' })
      expect(bare.exitCode).not.toBe(0)
      expect(text(bare.stderr)).not.toBe('')
      expect([io.exitCode, text(io.stderr)]).toEqual([bare.exitCode, text(bare.stderr)])
      expect(box.ran).toEqual([])
    })
  })

  // The pass asks about the program where it stands under the wrapper, and
  // the gate finds that answer there rather than asking again.
  it('asks about its program once', async () => {
    await withBox(
      { commands: { ask: [{ reason: 'nod', commands: ['python3'] }] } },
      async (ws, box) => {
        const line = 'nohup python3 -c x'
        const held = await ws.shell(line, { sessionId: 's' })
        expect(held.exitCode).toBe(126)
        const pending = ws.decisions.pending()
        expect(pending).toHaveLength(1)
        await ws.decisions.answer(pending[0]?.id ?? '', Outcome.ALLOW, Scope.ONCE)
        const ran = await ws.shell(line, { sessionId: 's' })
        expect(ran.exitCode).toBe(0)
        expect(box.ran).toEqual([['nohup', 'python3', '-c', 'x']])
        expect(ws.decisions.pending()).toEqual([])
      },
    )
  })

  // The box resolves a path on its own disk, which the gate cannot read, so an
  // allow list, which names only what it can read, refuses it.
  it.each([
    [{ commands: { allow: ['nohup'] } }, true],
    [{ commands: { deny: [{ reason: 'r', commands: ['rm'] }] } }, false],
    [{}, false],
  ])('runs a path only without an allow list: %j', async (profile, refused) => {
    await withBox(profile, async (ws, box) => {
      const io = await ws.shell('nohup /usr/bin/env python3 -c x', { sessionId: 's' })
      if (refused) {
        expect([io.exitCode, text(io.stderr)]).toEqual([126, '/usr/bin/env: Permission denied\n'])
        expect(box.ran).toEqual([])
      } else {
        expect(io.exitCode).toBe(0)
        expect(box.ran).toEqual([['nohup', '/usr/bin/env', 'python3', '-c', 'x']])
      }
    })
  })

  // GNU env splits -S into a command line the gate cannot read, and the
  // machine runs its own pip, not the session's function of that name.
  it.each([
    ['', "nohup time env --split-string='python3 -c x'", 'env'],
    ['', "nohup time env -S 'python3 -c x'", 'env'],
    ['pip() { echo harmless; }', 'nohup time pip --version', 'pip'],
  ])('admits what the machine runs: %s %s', async (setup, line, refused) => {
    await withBox({ commands: { allow: ['nohup', 'time', 'env', 'echo'] } }, async (ws, box) => {
      if (setup !== '') await ws.shell(setup, { sessionId: 's' })
      const io = await ws.shell(line, { sessionId: 's' })
      expect([io.exitCode, text(io.stderr)]).toEqual([126, `${refused}: Permission denied\n`])
      expect(box.ran).toEqual([])
    })
  })
})

class Named extends MachineHandle {
  static override readonly provider = 'box'

  connect(): Promise<void> {
    return Promise.resolve()
  }

  protected override execArgv(): Promise<RunResult> {
    return Promise.resolve({
      stdout: new TextEncoder().encode(`${this.name}\n`),
      stderr: null,
      exitCode: 0,
    })
  }
}

class HostnameOn implements Policy {
  constructor(private readonly machine: string) {}

  preCommand(ctx: CommandContext): Route | null {
    return ctx.command === 'hostname' ? { kind: 'route', machine: this.machine } : null
  }
}

// The wrapper goes with its program, so a route answering for the program
// places them both, as it places the program run alone.
describe('a wrapper whose program is routed', () => {
  it.each(['a', 'b'])('runs where the program goes: %s', async (machine) => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: { a: new Named('a'), b: new Named('b') },
        runtimes: [new MachineRuntime({ captures: ['hostname'], machine: 'a' }), 'workspace'],
        policies: [new HostnameOn(machine)],
      },
    )
    try {
      expect(text((await ws.shell('hostname')).stdout)).toBe(`${machine}\n`)
      const io = await ws.shell('nohup hostname')
      expect([io.exitCode, text(io.stdout)]).toEqual([0, `${machine}\n`])
    } finally {
      await ws.close()
    }
  })

  it('reaches the runtime with its words', async () => {
    const box = new Box()
    const other = new OtherBox()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: [box, other], policies: [new HostnameTo('other')] },
    )
    try {
      const io = await ws.shell('nohup nice -n 5 hostname -s')
      expect(io.exitCode).toBe(0)
      expect(other.ran).toEqual([['nohup', 'nice', '-n', '5', 'hostname', '-s']])
      expect(box.ran).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('runs in Mirage when the route says so', async () => {
    const box = new Box()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: [box, 'monty'], policies: [new PythonOnMonty()] },
    )
    try {
      const io = await ws.shell("nohup python3 -c 'print(1)'")
      expect([io.exitCode, text(io.stdout)]).toEqual([0, '1\n'])
      expect(box.ran).toEqual([])
    } finally {
      await ws.close()
    }
  })
})

class Routes implements Policy {
  constructor(private readonly routes: Record<string, Route>) {}

  preCommand(ctx: CommandContext): Route | null {
    return this.routes[ctx.command] ?? null
  }
}

const TWO_TOOLS = String.raw`nohup find / -maxdepth 0 -exec tool_a {} \; -exec tool_b {} \;`

function routedWs(routes: Record<string, Route>): Workspace {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: { a: new Named('a'), b: new Named('b') },
      runtimes: [new MachineRuntime({ captures: ['find', 'hostname'], machine: 'a' }), 'workspace'],
      policies: [new Routes(routes)],
    },
  )
}

// One process runs the wrapper and its programs, so routes answering for them
// have to agree, as two policies placing one line do.
describe('routes under one wrapper', () => {
  it.each<[Record<string, Route>, string]>([
    [
      {
        tool_a: { kind: 'route', machine: 'a' },
        tool_b: { kind: 'route', machine: 'b' },
      },
      TWO_TOOLS,
    ],
    [
      {
        nice: { kind: 'route', machine: 'b' },
        hostname: { kind: 'route', runtime: 'machine' },
      },
      'nohup nice hostname',
    ],
    [
      {
        nohup: { kind: 'route', machine: 'a' },
        hostname: { kind: 'route', machine: 'b' },
      },
      'nohup hostname',
    ],
  ])('refuse the line when they disagree: %j', async (routes, line) => {
    const ws = routedWs(routes)
    try {
      const io = await ws.shell(line)
      expect([io.exitCode, text(io.stdout)]).toEqual([126, ''])
      expect(io.decision?.reason.startsWith('policies place the line on different runtimes')).toBe(
        true,
      )
    } finally {
      await ws.close()
    }
  })

  it('place the wrapper when they agree', async () => {
    const ws = routedWs({
      tool_a: { kind: 'route', machine: 'b' },
      tool_b: { kind: 'route', machine: 'b' },
    })
    try {
      const io = await ws.shell(TWO_TOOLS)
      expect([io.exitCode, text(io.stdout)]).toEqual([0, 'b\n'])
    } finally {
      await ws.close()
    }
  })
})

class OtherBox extends Box {
  override readonly name: string = 'other'
  constructor() {
    super(['hostname'])
  }
}

class HostnameTo implements Policy {
  constructor(private readonly runtime: string) {}

  preCommand(ctx: CommandContext): Route | null {
    return ctx.command === 'hostname' ? { kind: 'route', runtime: this.runtime } : null
  }
}

class PythonOnMonty implements Policy {
  preCommand(ctx: CommandContext): Route | null {
    return ctx.command === 'python3' ? { kind: 'route', runtime: 'monty' } : null
  }
}

describe('a path no file of Mirage answers', () => {
  it.each([
    [{ commands: { allow: ['echo'] } }, true],
    [{ commands: { deny: [{ reason: 'r', commands: ['rm'] }] } }, false],
    [{}, false],
  ])('goes to the external runtime: %j', async (profile, isRefused) => {
    await withBox(profile, async (ws, box) => {
      const io = await ws.shell('/opt/tool a', { sessionId: 's' })
      if (isRefused) {
        expect([io.exitCode, text(await materialize(io.stderr))]).toEqual([
          126,
          '/opt/tool: Permission denied\n',
        ])
        expect(box.ran).toEqual([])
      } else {
        expect(io.exitCode).toBe(0)
        expect(box.ran).toEqual([['/opt/tool', 'a']])
      }
    })
  })

  it('runs in Mirage when Mirage holds the file', async () => {
    await withBox({}, async (ws, box) => {
      await ws.shell("echo 'echo hi' > /data/s.sh")
      const io = await ws.shell('/data/s.sh')
      expect([io.exitCode, text(io.stdout)]).toEqual([0, 'hi\n'])
      expect(box.ran).toEqual([])
    })
  })

  it('leaves a relative path to the shell', async () => {
    await withBox({}, async (ws, box) => {
      const io = await ws.shell('./tool a')
      expect(io.exitCode).toBe(127)
      expect(box.ran).toEqual([])
    })
  })

  it("is the shell's without an external runtime", async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: ['workspace'] },
    )
    try {
      const io = await ws.shell('/opt/tool a')
      expect(io.exitCode).toBe(127)
      expect(text(await materialize(io.stderr))).toContain('No such file or directory')
    } finally {
      await ws.close()
    }
  })
})
