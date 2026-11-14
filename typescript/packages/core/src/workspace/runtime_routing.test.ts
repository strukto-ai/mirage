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
import { Command, type Context } from '../commands/config.ts'
import { CommandSpec } from '../commands/spec/types.ts'
import { IOResult } from '../io/types.ts'
import type { Policy } from '../policy/base.ts'
import type { Deny, Route, RouteContext, ShellExplanation } from '../policy/types.ts'
import { Runtime } from '../runtime/base.ts'
import { SCRIPT_EVAL_TIMEOUT } from '../runtime/constants.ts'
import { QuickJsRuntime } from '../runtime/js/quickjs/runtime.ts'
import { LanguageRuntime } from '../runtime/language.ts'
import { isLineExecutor, LINE_EXECUTOR, type LineExecutorMixin } from '../runtime/mixin.ts'
import { MontyRuntime } from '../runtime/python/monty/index.ts'
import { runtimeForScript } from '../runtime/routing/index.ts'
import type { OutputFn, RunResult } from '../runtime/types.ts'
import { ScriptSource } from '../runtime/types.ts'
import { WorkspaceRuntime } from '../runtime/workspace.ts'
import { Channel, JobConsole } from '../shell/console/index.ts'
import { Limit, MountMode, VFSName, type PathSpec } from '../types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import type { WorkspaceOptions } from './workspace/types.ts'
import { Workspace } from './workspace/workspace.ts'
import { buildRuntime } from '../runtime/table.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

class NamedFakeRuntime extends LanguageRuntime {
  readonly language = 'python'
  constructor(readonly name: string) {
    super({ captures: ['python3', 'python'] })
  }
  interpret(): Promise<RunResult> {
    return Promise.resolve({
      stdout: ENC.encode(`ran-${this.name}\n`),
      stderr: new Uint8Array(),
      exitCode: 0,
    })
  }
}

function runtimeArgWorkspace(): Workspace {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: [new NamedFakeRuntime('alpha'), new NamedFakeRuntime('beta')],
    },
  )
}

describe('per-line runtime argument', () => {
  it('rebinds captured stages for the routed line only', async () => {
    const ws = runtimeArgWorkspace()
    try {
      const routed = await ws.shell('python3 -c "x"', { machine: 'beta' })
      expect(DEC.decode(routed.stdout)).toBe('ran-beta\n')
      const after = await ws.shell('python3 -c "x"')
      expect(DEC.decode(after.stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })

  it('nested evals inherit the runtime argument', async () => {
    const ws = runtimeArgWorkspace()
    try {
      const io = await ws.shell('echo $(python3 -c "x")', { machine: 'beta' })
      expect(DEC.decode(io.stdout)).toBe('ran-beta\n')
    } finally {
      await ws.close()
    }
  })

  it("leaves its caller's route to a nested line", async () => {
    const ws = runtimeArgWorkspace()
    try {
      ws.registry.mountForPrefix('/').register(
        new Command({
          name: 'nested',
          spec: new CommandSpec({}),
          vfs: VFSName.RAM,
          fn: async () => {
            await ws.shell('echo inner')
            return [new Uint8Array(), new IOResult()]
          },
        }),
      )
      const io = await ws.shell('nested; python3 -c "x"', { machine: 'beta' })
      expect(DEC.decode(io.stdout)).toBe('ran-beta\n')
    } finally {
      await ws.close()
    }
  })

  it('never touches uncaptured stages', async () => {
    const ws = runtimeArgWorkspace()
    try {
      const io = await ws.shell('echo plain-workspace', { machine: 'beta' })
      expect(DEC.decode(io.stdout)).toBe('plain-workspace\n')
    } finally {
      await ws.close()
    }
  })

  it('fails loud on unknown runtimes and the workspace name', async () => {
    const ws = runtimeArgWorkspace()
    try {
      await expect(ws.shell('python3 -c "x"', { machine: 'nope' })).rejects.toThrow(
        /unknown machine:/,
      )
      await expect(ws.shell('python3 -c "x"', { machine: 'workspace' })).rejects.toThrow(
        /not a machine you can select/,
      )
    } finally {
      await ws.close()
    }
  })
})

function routedWorkspace(): Workspace {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: [new NamedFakeRuntime('alpha'), new NamedFakeRuntime('beta')],
      routePolicy: (ctx) => (ctx.line.includes('big') ? 'beta' : null),
    },
  )
}

const ROUTE_NODE = [
  'def pre_execute(ctx):',
  '    if any(c["command"] == "node" for c in ctx["commands"]):',
  '        name = open("/route.txt").read().strip()',
  '        return {"kind": "route", "machine": name}',
  '',
].join('\n')

describe('routing ladder', () => {
  it('a route moves a line between capturers', async () => {
    const ws = routedWorkspace()
    try {
      const small = await ws.shell('python3 -c "small"')
      expect(DEC.decode(small.stdout)).toBe('ran-alpha\n')
      const big = await ws.shell('python3 -c "big job"')
      expect(DEC.decode(big.stdout)).toBe('ran-beta\n')
    } finally {
      await ws.close()
    }
  })

  it('runtime argument beats the route', async () => {
    const ws = routedWorkspace()
    try {
      const io = await ws.shell('python3 -c "big job"', { machine: 'alpha' })
      expect(DEC.decode(io.stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })

  it('the global policy names the runtime', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [new NamedFakeRuntime('alpha'), new NamedFakeRuntime('beta')],
        routePolicy: (ctx) => (ctx.line.includes('heavy') ? 'beta' : null),
      },
    )
    try {
      const heavy = await ws.shell('python3 -c "heavy"')
      expect(DEC.decode(heavy.stdout)).toBe('ran-beta\n')
      const light = await ws.shell('python3 -c "light"')
      expect(DEC.decode(light.stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })

  it('a hung route program times out with a routing error', async () => {
    const saved = SCRIPT_EVAL_TIMEOUT.seconds
    SCRIPT_EVAL_TIMEOUT.seconds = 0.5
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [new NamedFakeRuntime('alpha')],
        routePolicy: {
          script: new ScriptSource(
            'def pre_execute(ctx):\n    while True:\n        pass\n',
            'python',
          ),
          runtime: 'monty',
        },
      },
    )
    try {
      await expect(ws.shell('echo hi')).rejects.toThrow(/route_policy timed out after 0.5s/)
    } finally {
      SCRIPT_EVAL_TIMEOUT.seconds = saved
      await ws.close()
    }
  })

  it('runtimeForScript picks by machine and language, first match', () => {
    const monty = new MontyRuntime()
    const quickjs = new QuickJsRuntime()
    const fake = new NamedFakeRuntime('fake')
    expect(runtimeForScript([fake, quickjs, monty], 'in_process', null, 'python')).toBe(fake)
    expect(runtimeForScript([fake, quickjs, monty], 'in_process', 'monty', 'python')).toBe(monty)
    expect(runtimeForScript([monty, quickjs], 'in_process', null, 'js')).toBe(quickjs)
    expect(runtimeForScript([monty, quickjs], 'in_process', 'quickjs', 'js')).toBe(quickjs)
    expect(runtimeForScript([monty, quickjs], 'in_process', 'pyodide', 'js')).toBeNull()
    expect(runtimeForScript([monty], 'host', null, 'python')).toBeNull()
    // Captures do not count (the marker captures python3 but is no
    // LanguageRuntime), and there is no any-language
    // fallback: a python program cannot run on a js engine.
    class CapturingMarker extends Runtime {
      readonly name = 'marker'
      constructor() {
        super({ captures: ['python3', 'python'] })
      }
    }
    expect(runtimeForScript([new CapturingMarker()], 'in_process', null, 'python')).toBeNull()
    expect(runtimeForScript([quickjs], 'in_process', null, 'python')).toBeNull()
    expect(runtimeForScript([], 'in_process', null, 'js')).toBeNull()
  })

  it('a route program reads mounted content as the session', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [new MontyRuntime({ captures: [] }), new QuickJsRuntime()],
        // The runtime name comes from a mounted file; a read that missed
        // would fail the program and the line.
        routePolicy: { script: new ScriptSource(ROUTE_NODE, 'python'), runtime: 'monty' },
      },
    )
    try {
      await ws.shell('echo quickjs > /route.txt')
      const placed = await ws.shell('node -e "console.log(1)"')
      expect(placed.exitCode).toBe(0)
      expect(DEC.decode(placed.stdout)).toBe('1\n')
      const ok = await ws.shell('echo ok')
      expect(DEC.decode(ok.stdout)).toBe('ok\n')
      expect(ok.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it("a policy's deny folds into the line result", async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [new NamedFakeRuntime('alpha')],
        policies: [
          {
            preExecute: (ctx) =>
              ctx.commands.some((c) => c.command === 'python3')
                ? { kind: 'deny', reason: 'python3 is blocked' }
                : null,
          },
        ],
      },
    )
    try {
      const denied = await ws.shell('python3 -c "x"')
      expect(denied.exitCode).toBe(126)
      expect(DEC.decode(denied.stderr)).toBe('python3: Permission denied\n')
      expect(denied.decision?.reason).toBe('python3 is blocked')
      const ok = await ws.shell('echo ok')
      expect(DEC.decode(ok.stdout)).toBe('ok\n')
      expect(ok.exitCode).toBe(0)
      // The denied line is still a typed line: it records like any
      // other command, mirroring Python's finally path.
      const events = await ws.history()
      expect(events.filter((e) => e.type === 'command').map((e) => e.command)).toEqual([
        'python3 -c "x"',
        'echo ok',
      ])
      expect(events.filter((e) => e.type === 'result').map((e) => e.exit_code)).toEqual([126, 0])
    } finally {
      await ws.close()
    }
  })

  it('a runtime name places the line', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [new NamedFakeRuntime('alpha'), new NamedFakeRuntime('beta')],
        routePolicy: () => 'beta',
      },
    )
    try {
      const io = await ws.shell('python3 -c "x"')
      expect(DEC.decode(io.stdout)).toBe('ran-beta\n')
    } finally {
      await ws.close()
    }
  })

  it('a syntax error gates before the policy', async () => {
    const calls: string[] = []
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [new NamedFakeRuntime('alpha')],
        routePolicy: (ctx) => {
          calls.push(ctx.line)
          return null
        },
      },
    )
    try {
      const io = await ws.shell('echo (')
      expect(io.exitCode).toBe(2)
      expect(DEC.decode(io.stderr)).toContain('syntax error')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it("a coded route policy places beside a policy's deny", async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [new NamedFakeRuntime('alpha'), new NamedFakeRuntime('beta')],
        routePolicy: () => 'beta',
        policies: [
          {
            preExecute: (ctx) =>
              ctx.line.includes('secret') ? { kind: 'deny', reason: 'secrets stay put' } : null,
          },
        ],
      },
    )
    try {
      const routed = await ws.shell('python3 -c "x"')
      expect(DEC.decode(routed.stdout)).toBe('ran-beta\n')
      const denied = await ws.shell('python3 -c "secret"')
      expect(denied.exitCode).toBe(126)
      expect(DEC.decode(denied.stderr)).toBe('python3: Permission denied\n')
      expect(denied.decision?.reason).toBe('secrets stay put')
    } finally {
      await ws.close()
    }
  })

  it('nested evals inherit the typed line decision', async () => {
    const ws = routedWorkspace()
    try {
      const io = await ws.shell('echo big $(python3 -c "x")')
      expect(DEC.decode(io.stdout)).toBe('big ran-beta\n')
    } finally {
      await ws.close()
    }
  })

  it('addRuntime appends, rebinds, and rejects duplicates', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [new NamedFakeRuntime('alpha')],
      },
    )
    try {
      ws.addMachine('beta', new NamedFakeRuntime('beta'))
      const first = await ws.shell('python3 -c "x"')
      expect(DEC.decode(first.stdout)).toBe('ran-alpha\n')
      const routed = await ws.shell('python3 -c "x"', { machine: 'beta' })
      expect(DEC.decode(routed.stdout)).toBe('ran-beta\n')
      expect(() => ws.addMachine('beta', new NamedFakeRuntime('beta'))).toThrow(/duplicate machine/)
    } finally {
      await ws.close()
    }
  })
})

class HeavyOnBeta implements Policy {
  preExecute(ctx: RouteContext): Route | null {
    return ctx.line.includes('heavy') ? { kind: 'route', machine: 'beta' } : null
  }
}

class NoSecrets implements Policy {
  preExecute(ctx: RouteContext): Deny | null {
    return ctx.line.includes('secret') ? { kind: 'deny', reason: 'secrets stay put' } : null
  }
}

/** The machine each top-level command of an explained line would run on. */
function machinesOf(said: ShellExplanation): string[] {
  return said.node.children.flatMap((node) => ('command' in node ? [node.machine] : []))
}

function placed(options: Partial<WorkspaceOptions>): Workspace {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: [new NamedFakeRuntime('alpha'), new NamedFakeRuntime('beta')],
      ...options,
    },
  )
}

describe('the placement stage', () => {
  it('a coded policy places the line', async () => {
    const ws = placed({ policies: [new HeavyOnBeta()] })
    try {
      expect(DEC.decode((await ws.shell('python3 -c "heavy"')).stdout)).toBe('ran-beta\n')
      expect(DEC.decode((await ws.shell('python3 -c "light"')).stdout)).toBe('ran-alpha\n')
      // The caller's runtime argument is its own placement.
      const own = await ws.shell('python3 -c "heavy"', { machine: 'alpha' })
      expect(DEC.decode(own.stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })

  it('a deny outranks a route', async () => {
    const ws = placed({ routePolicy: () => 'beta', policies: [new NoSecrets()] })
    try {
      const denied = await ws.shell('python3 -c "secret"')
      expect([denied.exitCode, DEC.decode(denied.stderr)]).toEqual([
        126,
        'python3: Permission denied\n',
      ])
      expect([denied.decision?.reason, denied.decision?.policy]).toEqual([
        'secrets stay put',
        'NoSecrets',
      ])
      // A deny holds whoever placed the line, the caller included.
      expect((await ws.shell('python3 -c "secret"', { machine: 'beta' })).exitCode).toBe(126)
      expect(DEC.decode((await ws.shell('python3 -c "x"')).stdout)).toBe('ran-beta\n')
    } finally {
      await ws.close()
    }
  })

  it('two placements that disagree refuse the line', async () => {
    const ws = placed({ routePolicy: () => 'alpha', policies: [new HeavyOnBeta()] })
    try {
      const refused = await ws.shell('python3 -c "heavy"')
      expect(refused.exitCode).toBe(126)
      expect(refused.decision?.reason).toBe(
        'policies place the line on different machines: ' +
          'RoutePolicy on alpha, HeavyOnBeta on beta',
      )
      expect(DEC.decode((await ws.shell('python3 -c "light"')).stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })

  it('explain names the policy that placed the line', async () => {
    const ws = placed({
      routePolicy: (ctx) => (ctx.line.includes('heavy') ? 'beta' : null),
      policies: [new NoSecrets()],
    })
    try {
      const heavy = await ws.explain('python3 -c "heavy"')
      expect(heavy.answers).toEqual([{ kind: 'route', machine: 'beta', policy: 'RoutePolicy' }])
      expect([machinesOf(heavy), heavy.exitCode]).toEqual([['beta'], 0])
      const light = await ws.explain('python3 -c "light"')
      expect([light.answers, machinesOf(light)]).toEqual([[], ['alpha']])
      // A placement deny refuses the line in the words the run would
      // print, and places none of it.
      const secret = await ws.explain('python3 -c "secret"; echo x')
      expect(secret.answers).toEqual([
        { kind: 'deny', reason: 'secrets stay put', policy: 'NoSecrets' },
      ])
      expect([secret.exitCode, secret.stderr]).toEqual([126, 'python3: Permission denied\n'])
      expect(machinesOf(secret)).toEqual(['', ''])
    } finally {
      await ws.close()
    }
  })

  it('admission comes before placement', async () => {
    const seen: string[] = []
    const ws = placed({
      routePolicy: (ctx) => {
        seen.push(ctx.line)
        return null
      },
    })
    try {
      ws.createSession('agent', {
        profile: { commands: { deny: [{ reason: 'no deletes', commands: ['rm'] }] } },
      })
      const rm = await ws.shell('rm /x', { sessionId: 'agent' })
      expect([rm.exitCode, DEC.decode(rm.stderr)]).toEqual([126, 'rm: Permission denied\n'])
      expect(rm.decision?.reason).toBe('no deletes')
      expect(seen).toEqual([])
      const echo = await ws.shell('echo ok', { sessionId: 'agent' })
      expect(echo.exitCode).toBe(0)
      expect(seen).toEqual(['echo ok'])
    } finally {
      await ws.close()
    }
  })
})

describe('the workspace itself', () => {
  it('is never a machine entry', () => {
    expect(
      () => new Workspace({ '/': new RAMVFS() }, { machines: [new WorkspaceRuntime()] }),
    ).toThrow(/reserved for the workspace/)
    expect(
      () => new Workspace({ '/': new RAMVFS() }, { machines: { x: new WorkspaceRuntime() } }),
    ).toThrow(/not a machine/)
  })

  it('an allow list narrows what it runs', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [new NamedFakeRuntime('alpha')],
        profiles: { narrow: { commands: { allow: ['echo', 'python3'] } } },
        profile: 'narrow',
      },
    )
    try {
      const ok = await ws.shell('echo listed')
      expect(DEC.decode(ok.stdout)).toBe('listed\n')
      const denied = await ws.shell('ls /')
      expect(denied.exitCode).toBe(126)
      expect(DEC.decode(denied.stderr)).toBe('ls: Permission denied\n')
      const py = await ws.shell('python3 -c "x"')
      expect(DEC.decode(py.stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })
})

class LineBox extends Runtime implements LineExecutorMixin {
  readonly [LINE_EXECUTOR] = true as const
  readonly name = 'sandbox'
  declare captures: readonly string[]
  lines: [string, Uint8Array | null, string][] = []

  constructor() {
    super({ captures: ['nvidia-smi'] })
  }

  runLine(_e: unknown, _p: PathSpec[], _t: string[], ctx: Context): Promise<RunResult> {
    const line = ctx.flags.c as string
    this.lines.push([line, ctx.stdin as Uint8Array | null, ctx.cwd.virtual])
    return Promise.resolve({ stdout: ENC.encode(`box:${line}`), stderr: null, exitCode: 0 })
  }
}

describe('whole-line runtimes', () => {
  it("puts what the runtime read in its line's report", async () => {
    // A runtime's reads are the line's: they reach the workspace's ledger
    // and the observer's account of the line, as a command's do.
    class ReadingBox extends LineBox {
      override async runLine(
        _e: unknown,
        _p: PathSpec[],
        _t: string[],
        ctx: Context,
      ): Promise<RunResult> {
        if (ctx.vfs === undefined) throw new Error('no files')
        return { stdout: await ctx.vfs.read('/f.txt'), stderr: null, exitCode: 0 }
      }
    }
    const box = new ReadingBox()
    box.captures = ['@line']
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.EXEC, machines: [box] })
    try {
      await ws.vfs.write('/f.txt', 'hi\n')
      const mark = ws.records.length
      const result = await ws.shell('anything')
      expect(DEC.decode(result.stdout)).toBe('hi\n')
      expect(ws.records.slice(mark).map((r) => [r.op, r.path])).toEqual([['read', '/f.txt']])
      const logged = await ws.observer.events()
      const line = logged.findIndex((e) => e.command === 'anything')
      const after = logged.find((e) => e.parent !== undefined && e.parent === logged[line]?.id)
      expect([after?.type, after?.vfs, after?.path]).toEqual(['vfs', 'read', '/f.txt'])
    } finally {
      await ws.close()
    }
  })

  it('hands a runtime that failed to post_execute as its result', async () => {
    // A failed run is still the line's result: a policy reading
    // post_execute sees its status, what it wrote and its error.
    class BrokenBox extends LineBox {
      override async runLine(
        _e: unknown,
        _p: PathSpec[],
        _t: string[],
        _ctx: Context,
        _output?: OutputFn,
        errors?: OutputFn,
      ): Promise<RunResult> {
        await errors?.(ENC.encode('warning\n'))
        throw new Error('box broke')
      }
    }
    const seen: [number, string][] = []
    const box = new BrokenBox()
    box.captures = ['@line']
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [box],
        policies: [
          {
            postExecute: (ctx) => {
              seen.push([ctx.exitCode, JSON.stringify(ctx.results)])
              return null
            },
          },
        ],
      },
    )
    try {
      const result = await ws.shell('anything')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toBe('warning\nbox broke')
      expect(seen).toHaveLength(1)
      expect(seen[0]?.[0]).toBe(1)
      expect(seen[0]?.[1]).toContain('warning\\nbox broke')
    } finally {
      await ws.close()
    }
  })

  it('stops a run past its deadline before its runtime settles', async () => {
    // Settling may wait for the run, so the deadline stops it first.
    let running: Promise<void> = Promise.resolve()
    class SettlingBox extends LineBox {
      override runLine(
        _e: unknown,
        _p: PathSpec[],
        _t: string[],
        ctx: Context,
      ): Promise<RunResult> {
        running = new Promise<void>((resolve) => {
          ctx.signal?.addEventListener('abort', () => {
            resolve()
          })
        })
        return new Promise<RunResult>(() => undefined)
      }

      override settle(): Promise<void> {
        return running
      }
    }
    const box = new SettlingBox()
    box.captures = ['@line']
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [box],
        commandLimits: { '@line': new Limit({ timeoutSeconds: 0.2 }) },
      },
    )
    try {
      const result = await ws.shell('anything')
      expect(result.exitCode).toBe(124)
      expect(DEC.decode(result.stderr)).toContain('line: timed out after 0.2s')
    } finally {
      await ws.close()
    }
  }, 10_000)

  it('cuts a program whose runtime ignores its stop at the line deadline', async () => {
    class Deaf extends LanguageRuntime {
      readonly language = 'python'
      readonly name = 'deaf'
      constructor() {
        super({ captures: ['python3'] })
      }
      async interpret(
        _engine: unknown,
        _program: unknown,
        _ctx: Context,
        output?: OutputFn,
      ): Promise<RunResult> {
        await output?.(ENC.encode('a\n'))
        return new Promise<RunResult>(() => undefined)
      }
    }
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [new Deaf()],
        commandLimits: { '@line': new Limit({ timeoutSeconds: 0.2 }) },
      },
    )
    try {
      const result = await ws.shell('python3 -c x | cat')
      expect(result.exitCode).toBe(124)
      expect(DEC.decode(result.stderr)).toContain('line: timed out after 0.2s')
    } finally {
      await ws.close()
    }
  }, 30_000)

  it('keeps what an aborted runtime read on the books', async () => {
    // The runtime finished its read before the line was aborted: the read
    // happened, so it reaches the ledger and the line's record all the same.
    let readDone = (): void => undefined
    const reading = new Promise<void>((resolve) => {
      readDone = resolve
    })
    class StallingBox extends LineBox {
      override async runLine(
        _e: unknown,
        _p: PathSpec[],
        _t: string[],
        ctx: Context,
      ): Promise<RunResult> {
        if (ctx.vfs === undefined) throw new Error('no files')
        await ctx.vfs.read('/f.txt')
        readDone()
        return new Promise<RunResult>(() => undefined)
      }
    }
    const box = new StallingBox()
    box.captures = ['@line']
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.EXEC, machines: [box] })
    try {
      await ws.vfs.write('/f.txt', 'hi\n')
      const mark = ws.records.length
      const stop = new AbortController()
      const running = ws.shell('anything', { signal: stop.signal })
      await reading
      stop.abort()
      await expect(running).rejects.toMatchObject({ name: 'AbortError' })
      expect(ws.records.slice(mark).map((r) => [r.op, r.path])).toEqual([['read', '/f.txt']])
      const logged = await ws.observer.events()
      const line = logged.findIndex((e) => e.command === 'anything')
      expect(line).toBeGreaterThanOrEqual(0)
      const after = logged.find((e) => e.parent !== undefined && e.parent === logged[line]?.id)
      expect([after?.type, after?.vfs, after?.path]).toEqual(['vfs', 'read', '/f.txt'])
    } finally {
      await ws.close()
    }
  })

  it('a named capture keeps the pipeline and redirect in Mirage', async () => {
    const box = new LineBox()
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.EXEC, machines: [box] })
    try {
      const result = await ws.shell('nvidia-smi -L | grep box > /out.txt')
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('')
      expect(box.lines[0]?.[0]).toBe('nvidia-smi -L')
      const saved = await ws.shell('cat /out.txt')
      expect(DEC.decode(saved.stdout)).toBe('box:nvidia-smi -L\n')
    } finally {
      await ws.close()
    }
  })

  it('an "@line" capture claims any line and stdin arrives', async () => {
    const box = new LineBox()
    box.captures = ['@line']
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.EXEC, machines: [box] })
    try {
      const result = await ws.shell('ls / && echo done', { stdin: ENC.encode('fed') })
      expect(DEC.decode(result.stdout)).toBe('box:ls / && echo done')
      expect(DEC.decode(box.lines[0]?.[1] ?? new Uint8Array())).toBe('fed')
    } finally {
      await ws.close()
    }
  })

  it('a route to the workspace keeps a line in Mirage', async () => {
    const box = new LineBox()
    box.captures = ['@line']
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [box],
        routePolicy: (ctx) => (ctx.line.includes('keep-out') ? 'workspace' : null),
      },
    )
    try {
      const taken = await ws.shell('echo captured')
      const kept = await ws.shell('echo keep-out')
      expect(DEC.decode(taken.stdout)).toBe('box:echo captured')
      expect(DEC.decode(kept.stdout)).toBe('keep-out\n')
      expect(kept.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('the runtime argument places the whole line', async () => {
    const box = new LineBox()
    box.captures = ['@line']
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: [box],
        routePolicy: () => 'workspace',
      },
    )
    try {
      const refused = await ws.shell('echo hi')
      const forced = await ws.shell('echo hi', { machine: 'sandbox' })
      expect(DEC.decode(refused.stdout)).toBe('hi\n')
      expect(DEC.decode(forced.stdout)).toBe('box:echo hi')
    } finally {
      await ws.close()
    }
  })

  it('a sink receives the line the runtime served', async () => {
    const box = new LineBox()
    box.captures = ['@line']
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.EXEC, machines: [box] })
    const console_ = new JobConsole()
    try {
      // The runtime buffers and never touches the sink itself, so
      // without the drain a streaming caller reads nothing at all.
      const result = await ws.shell('echo hi', { sink: console_ })
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('')
      expect(DEC.decode(await console_.snapshot(Channel.STDOUT))).toBe('box:echo hi')
    } finally {
      await ws.close()
    }
  })

  it('the workspace entry is a pure routing marker', async () => {
    // A workspace-resolved line runs on the workspace executor inline; the
    // entry is a marker with no line entry point to call.
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.EXEC, machines: [buildRuntime('pyodide')] },
    )
    try {
      expect(isLineExecutor(new WorkspaceRuntime())).toBe(false)
      expect(ws.engines().some((entry) => entry instanceof WorkspaceRuntime)).toBe(false)
      const result = await ws.shell('echo through-workspace')
      expect(DEC.decode(result.stdout)).toBe('through-workspace\n')
      expect(result.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })
})
