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
import { Runtime } from '../runtime/base.ts'
import { LanguageRuntime } from '../runtime/language.ts'
import { VFSRuntime } from '../runtime/table.ts'
import {
  EVALUATOR,
  isLineExecutor,
  LINE_EXECUTOR,
  type Evaluator,
  type LineExecutor,
} from '../runtime/mixin.ts'
import type { EvalResult } from '../runtime/types.ts'
import { POLICY_EVAL_TIMEOUT, evaluatorOf, runtimeForLanguage } from '../runtime/routing/index.ts'
import type { RunArgs, RunResult } from '../runtime/types.ts'
import { MontyRuntime } from '../runtime/python/monty/index.ts'
import { QuickJsRuntime } from '../runtime/js/quickjs.ts'
import {
  DenyResult,
  parseVerdict,
  RouteDeny,
  RouteResult,
  ScriptSource,
} from '../runtime/routing/index.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Channel, JobConsole } from '../shell/console/index.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

class HangingEvaluator extends LanguageRuntime implements Evaluator {
  readonly [EVALUATOR] = true as const
  readonly language = 'python'
  readonly name = 'hang-eval'

  constructor() {
    super({ captures: ['python3'] })
  }

  run(): Promise<{ stdout: Uint8Array; stderr: null; exitCode: number }> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })
  }

  eval(): Promise<EvalResult> {
    return new Promise(() => undefined)
  }
}

class NamedEvaluator extends LanguageRuntime implements Evaluator {
  readonly [EVALUATOR] = true as const
  readonly language: 'python' | 'js'

  constructor(
    readonly name: string,
    language: 'python' | 'js',
  ) {
    super({ captures: [] })
    this.language = language
  }

  run(): Promise<{ stdout: Uint8Array; stderr: null; exitCode: number }> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })
  }

  eval(): Promise<EvalResult> {
    return Promise.resolve({
      value: null,
      stdout: new Uint8Array(),
      stderr: null,
      exitCode: 0,
      status: 'complete',
    })
  }
}

class NamedFakeRuntime extends LanguageRuntime {
  readonly language = 'python'
  constructor(readonly name: string) {
    super({ captures: ['python3', 'python'] })
  }
  run(_args: RunArgs): Promise<RunResult> {
    return Promise.resolve({
      stdout: ENC.encode(`ran-${this.name}\n`),
      stderr: new Uint8Array(),
      exitCode: 0,
    })
  }
}

async function runtimeArgWorkspace(): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(
    { '/': new RAMResource() },
    {
      mode: MountMode.EXEC,
      shellParser: parser,
      runtimes: [new NamedFakeRuntime('alpha'), new NamedFakeRuntime('beta'), 'vfs'],
    },
  )
}

describe('per-line runtime argument', () => {
  it('rebinds captured stages for the routed line only', async () => {
    const ws = await runtimeArgWorkspace()
    try {
      const routed = await ws.execute('python3 -c "x"', { runtime: 'beta' })
      expect(DEC.decode(routed.stdout)).toBe('ran-beta\n')
      const after = await ws.execute('python3 -c "x"')
      expect(DEC.decode(after.stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })

  it('nested evals inherit the runtime argument', async () => {
    const ws = await runtimeArgWorkspace()
    try {
      const io = await ws.execute('echo $(python3 -c "x")', { runtime: 'beta' })
      expect(DEC.decode(io.stdout)).toBe('ran-beta\n')
    } finally {
      await ws.close()
    }
  })

  it('never touches uncaptured stages', async () => {
    const ws = await runtimeArgWorkspace()
    try {
      const io = await ws.execute('echo plain-vfs', { runtime: 'beta' })
      expect(DEC.decode(io.stdout)).toBe('plain-vfs\n')
    } finally {
      await ws.close()
    }
  })

  it('fails loud on unknown runtimes and the vfs name', async () => {
    const ws = await runtimeArgWorkspace()
    try {
      await expect(ws.execute('python3 -c "x"', { runtime: 'nope' })).rejects.toThrow(
        /unknown runtime:/,
      )
      await expect(ws.execute('python3 -c "x"', { runtime: 'vfs' })).rejects.toThrow(
        /not a runtime you can select/,
      )
    } finally {
      await ws.close()
    }
  })
})

async function routedWorkspace(): Promise<Workspace> {
  const parser = await getTestParser()
  const alpha = new NamedFakeRuntime('alpha')
  alpha.script = (ctx) => !ctx.line.includes('big')
  return new Workspace(
    { '/': new RAMResource() },
    {
      mode: MountMode.EXEC,
      shellParser: parser,
      runtimes: [alpha, new NamedFakeRuntime('beta'), 'vfs'],
    },
  )
}

describe('routing ladder', () => {
  it('scripts filter capturers in list order', async () => {
    const ws = await routedWorkspace()
    try {
      const small = await ws.execute('python3 -c "small"')
      expect(DEC.decode(small.stdout)).toBe('ran-alpha\n')
      const big = await ws.execute('python3 -c "big job"')
      expect(DEC.decode(big.stdout)).toBe('ran-beta\n')
    } finally {
      await ws.close()
    }
  })

  it('runtime argument beats scripts', async () => {
    const ws = await routedWorkspace()
    try {
      const io = await ws.execute('python3 -c "big job"', { runtime: 'alpha' })
      expect(DEC.decode(io.stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })

  it('all capturers refusing is an admission failure, vfs stays open', async () => {
    const parser = await getTestParser()
    const alpha = new NamedFakeRuntime('alpha')
    alpha.script = () => false
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [alpha, 'vfs'] },
    )
    try {
      const denied = await ws.execute('python3 -c "x"')
      expect(denied.exitCode).toBe(126)
      expect(DEC.decode(denied.stderr)).toBe('python3: no runtime accepted this line\n')
      const open = await ws.execute('echo vfs-still-open')
      expect(DEC.decode(open.stdout)).toBe('vfs-still-open\n')
    } finally {
      await ws.close()
    }
  })

  it('a scripted vfs entry locks down refused lines', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new VFSRuntime({ script: (ctx) => !ctx.line.includes('/secret') })],
      },
    )
    try {
      const ok = await ws.execute('echo ok > /notes.txt && cat /notes.txt')
      expect(DEC.decode(ok.stdout)).toBe('ok\n')
      const denied = await ws.execute('cat /secret/creds')
      expect(denied.exitCode).toBe(126)
    } finally {
      await ws.close()
    }
  })

  it('the global policy names the runtime', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new NamedFakeRuntime('alpha'), new NamedFakeRuntime('beta'), 'vfs'],
        routePolicy: (ctx) => (ctx.line.includes('heavy') ? 'beta' : null),
      },
    )
    try {
      const heavy = await ws.execute('python3 -c "heavy"')
      expect(DEC.decode(heavy.stdout)).toBe('ran-beta\n')
      const light = await ws.execute('python3 -c "light"')
      expect(DEC.decode(light.stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })

  it('a hung policy script times out with a policy error', async () => {
    const parser = await getTestParser()
    const saved = POLICY_EVAL_TIMEOUT.seconds
    POLICY_EVAL_TIMEOUT.seconds = 0.1
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new HangingEvaluator(), 'vfs'],
        routePolicy: new ScriptSource('1'),
      },
    )
    try {
      await expect(ws.execute('echo hi')).rejects.toThrow(/policy script timed out after 0.1s/)
    } finally {
      POLICY_EVAL_TIMEOUT.seconds = saved
      await ws.close()
    }
  })

  it('a JS policy script selects the JS evaluator over an earlier python one', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new MontyRuntime(), new QuickJsRuntime(), 'vfs'],
        routePolicy: new ScriptSource(
          "ctx.command === 'node' ? {deny: 'js-engine-picked'} : null",
          'js',
        ),
      },
    )
    try {
      const denied = await ws.execute('node -e "1"')
      expect(denied.exitCode).toBe(126)
      expect(DEC.decode(denied.stderr)).toBe('node: Permission denied\n')
      expect(denied.refusal?.reason).toBe('js-engine-picked')
      const ok = await ws.execute('echo fine')
      expect(ok.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('evaluatorOf prefers a language match and falls back to the first', () => {
    const py = new NamedEvaluator('py-eval', 'python')
    const js = new NamedEvaluator('js-eval', 'js')
    expect(evaluatorOf([py, js], 'js')).toBe(js)
    expect(evaluatorOf([py, js], 'python')).toBe(py)
    expect(evaluatorOf([py, js])).toBe(py)
    expect(evaluatorOf([py], 'js')).toBe(py)
    expect(evaluatorOf([])).toBeNull()
  })

  it('one language attribute serves both doors', () => {
    // The eval door and the run door read the same Runtime.language, so
    // an engine cannot be picked as a js interpreter and a python
    // evaluator at once. Two attributes could disagree, and the
    // disagreement only showed up as an unexplained 127 or a policy
    // script evaluated on the wrong engine.
    const js = new NamedEvaluator('js-eval', 'js')
    expect(evaluatorOf([js], 'js')).toBe(js)
    expect(runtimeForLanguage([js], 'js')).toBe(js)
    expect(runtimeForLanguage([js], 'python')).toBeNull()
  })

  it('runtimeForLanguage is first-match with no cross-language fallback', () => {
    const monty = new MontyRuntime()
    const quickjs = new QuickJsRuntime()
    expect(runtimeForLanguage([monty, quickjs], 'python')).toBe(monty)
    expect(runtimeForLanguage([monty, quickjs], 'js')).toBe(quickjs)
    // Captures do not count (the marker captures python3 but is no
    // LanguageRuntime), and unlike evaluatorOf there is no any-language
    // fallback: a python program cannot run on a js engine.
    class CapturingMarker extends Runtime {
      readonly name = 'marker'
      constructor() {
        super({ captures: ['python3', 'python'] })
      }
    }
    expect(runtimeForLanguage([new CapturingMarker()], 'python')).toBeNull()
    expect(runtimeForLanguage([quickjs], 'python')).toBeNull()
    expect(runtimeForLanguage([], 'js')).toBeNull()
  })

  it('a JS policy script reads mounted content through the fs bridge', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new QuickJsRuntime(), 'vfs'],
        routePolicy: new ScriptSource(
          "const f = std.open('/deny.txt', 'r'); " +
            'const blocked = f !== null && f.readAsString().includes(ctx.command); ' +
            'if (f !== null) f.close(); ' +
            "blocked ? { deny: 'listed in /deny.txt' } : null",
        ),
      },
    )
    try {
      await ws.execute('echo node > /deny.txt')
      const denied = await ws.execute('node -e "1"')
      expect(denied.exitCode).toBe(126)
      expect(DEC.decode(denied.stderr)).toBe('node: Permission denied\n')
      expect(denied.refusal?.reason).toBe('listed in /deny.txt')
      const ok = await ws.execute('echo ok')
      expect(DEC.decode(ok.stdout)).toBe('ok\n')
      expect(ok.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('a deny verdict folds into the line result', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new NamedFakeRuntime('alpha'), 'vfs'],
        routePolicy: (ctx) => (ctx.command === 'python3' ? { deny: 'python3 is blocked' } : null),
      },
    )
    try {
      const denied = await ws.execute('python3 -c "x"')
      expect(denied.exitCode).toBe(126)
      expect(DEC.decode(denied.stderr)).toBe('python3: Permission denied\n')
      expect(denied.refusal?.reason).toBe('python3 is blocked')
      const ok = await ws.execute('echo ok')
      expect(DEC.decode(ok.stdout)).toBe('ok\n')
      expect(ok.exitCode).toBe(0)
      // The denied line is still a typed line: it records like any
      // other command, mirroring Python's finally path.
      const events = await ws.history()
      expect(events.map((e) => e.command)).toEqual(['python3 -c "x"', 'echo ok'])
      expect(events[0]?.exit_code).toBe(126)
    } finally {
      await ws.close()
    }
  })

  it('a runtime verdict object places the line', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new NamedFakeRuntime('alpha'), new NamedFakeRuntime('beta'), 'vfs'],
        routePolicy: () => ({ runtime: 'beta' }),
      },
    )
    try {
      const io = await ws.execute('python3 -c "x"')
      expect(DEC.decode(io.stdout)).toBe('ran-beta\n')
    } finally {
      await ws.close()
    }
  })

  it('a syntax error gates before the policy', async () => {
    const parser = await getTestParser()
    const calls: string[] = []
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new NamedFakeRuntime('alpha'), 'vfs'],
        routePolicy: (ctx) => {
          calls.push(ctx.line)
          return { deny: 'nothing runs' }
        },
      },
    )
    try {
      const io = await ws.execute('echo (')
      expect(io.exitCode).toBe(2)
      expect(DEC.decode(io.stderr)).toContain('syntax error')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('the typed arms parse like their wire dicts', async () => {
    expect(parseVerdict(new RouteResult('beta'))).toBe('beta')
    expect(() => parseVerdict(new DenyResult('not here'))).toThrow(RouteDeny)
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new NamedFakeRuntime('alpha'), new NamedFakeRuntime('beta'), 'vfs'],
        routePolicy: (ctx) =>
          ctx.line.includes('secret')
            ? new DenyResult('secrets stay put')
            : new RouteResult('beta'),
      },
    )
    try {
      const routed = await ws.execute('python3 -c "x"')
      expect(DEC.decode(routed.stdout)).toBe('ran-beta\n')
      const denied = await ws.execute('python3 -c "secret"')
      expect(denied.exitCode).toBe(126)
      expect(DEC.decode(denied.stderr)).toBe('python3: Permission denied\n')
      expect(denied.refusal?.reason).toBe('secrets stay put')
    } finally {
      await ws.close()
    }
  })

  it('an entry script answering a verdict shape fails loud', async () => {
    const parser = await getTestParser()
    const alpha = new NamedFakeRuntime('alpha')
    alpha.script = new ScriptSource("{'deny': 'nope'}")
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [alpha, new MontyRuntime(), 'vfs'],
      },
    )
    try {
      await expect(ws.execute('python3 -c "x"')).rejects.toThrow(/answer a boolean/)
    } finally {
      await ws.close()
    }
  })

  it('parseVerdict folds a Map verdict into the wire object', () => {
    expect(parseVerdict(new Map([['runtime', 'beta']]))).toBe('beta')
    expect(() => parseVerdict(new Map([['deny', 'nope']]))).toThrow(RouteDeny)
  })

  it('parseVerdict fails loud on bad verdict objects', () => {
    expect(() => parseVerdict({ runtme: 'beta' })).toThrow('unknown policy verdict keys')
    expect(() => parseVerdict({ runtime: 'beta', deny: 'no' })).toThrow('both place and deny')
    expect(() => parseVerdict({})).toThrow("needs a 'runtime' name")
    expect(() => parseVerdict(42)).toThrow('verdict dict, or null')
  })

  it('nested evals inherit the typed line decision', async () => {
    const ws = await routedWorkspace()
    try {
      const io = await ws.execute('echo big $(python3 -c "x")')
      expect(DEC.decode(io.stdout)).toBe('big ran-beta\n')
    } finally {
      await ws.close()
    }
  })

  it('a monty string script decides from parsed ctx', async () => {
    const parser = await getTestParser()
    const alpha = new NamedFakeRuntime('alpha')
    alpha.script = new ScriptSource(`
big = False
for c in ctx['commands']:
    for p in c['paths']:
        if p.startswith('/secret'):
            big = True
not big
`)
    // Config scripts run on the world's evaluator: a captures-empty
    // monty is a pure policy engine, so alpha stays python3's only
    // capturer and its refusal is still an admission failure.
    const engine = new MontyRuntime({ captures: [] })
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [alpha, engine, 'vfs'] },
    )
    try {
      await ws.execute("echo 'x = 1' > /fine.py")
      const ok = await ws.execute('python3 /fine.py')
      expect(DEC.decode(ok.stdout)).toBe('ran-alpha\n')
      const denied = await ws.execute('python3 /secret/x.py')
      expect(denied.exitCode).toBe(126)
    } finally {
      await ws.close()
    }
  })

  it('addRuntime appends, rebinds, and rejects duplicates', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new NamedFakeRuntime('alpha'), 'vfs'],
      },
    )
    try {
      ws.addRuntime(new NamedFakeRuntime('beta'))
      const first = await ws.execute('python3 -c "x"')
      expect(DEC.decode(first.stdout)).toBe('ran-alpha\n')
      const routed = await ws.execute('python3 -c "x"', { runtime: 'beta' })
      expect(DEC.decode(routed.stdout)).toBe('ran-beta\n')
      expect(() => ws.addRuntime(new NamedFakeRuntime('beta'))).toThrow(/duplicate runtime entry/)
    } finally {
      await ws.close()
    }
  })
})

describe('vfs runtime overrides', () => {
  it('explicit captures restrict the workspace', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new NamedFakeRuntime('alpha'), new VFSRuntime({ captures: ['echo'] })],
      },
    )
    try {
      const ok = await ws.execute('echo listed')
      expect(DEC.decode(ok.stdout)).toBe('listed\n')
      const denied = await ws.execute('ls /')
      expect(denied.exitCode).toBe(126)
      expect(DEC.decode(denied.stderr)).toBe('ls: no runtime accepted this line\n')
      const py = await ws.execute('python3 -c "x"')
      expect(DEC.decode(py.stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })

  it('explicit captures restrict under routing', async () => {
    const parser = await getTestParser()
    const alpha = new NamedFakeRuntime('alpha')
    alpha.script = () => true
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [alpha, new VFSRuntime({ captures: ['echo'] })],
      },
    )
    try {
      const ok = await ws.execute('echo routed-ok')
      expect(DEC.decode(ok.stdout)).toBe('routed-ok\n')
      const denied = await ws.execute('ls /')
      expect(denied.exitCode).toBe(126)
    } finally {
      await ws.close()
    }
  })
})

describe('script context', () => {
  it('a script sees its own stage on pipelines', async () => {
    const parser = await getTestParser()
    const alpha = new NamedFakeRuntime('alpha')
    alpha.script = (ctx) => ctx.command === 'python3'
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [alpha, 'vfs'] },
    )
    try {
      const io = await ws.execute('echo lead | python3 -c "x"')
      expect(io.exitCode).toBe(0)
      expect(DEC.decode(io.stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })

  it('empty declared captures serve nothing', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new NamedFakeRuntime('alpha'), new VFSRuntime({ captures: [] })],
      },
    )
    try {
      const denied = await ws.execute('ls /')
      expect(denied.exitCode).toBe(126)
      const py = await ws.execute('python3 -c "x"')
      expect(DEC.decode(py.stdout)).toBe('ran-alpha\n')
    } finally {
      await ws.close()
    }
  })
})

class LineBox extends Runtime implements LineExecutor {
  readonly [LINE_EXECUTOR] = true as const
  readonly name = 'sandbox'
  declare captures: readonly string[]
  lines: [string, Uint8Array | null, string][] = []

  constructor() {
    super({ captures: ['nvidia-smi'] })
  }

  runLine(
    line: string,
    stdin: Uint8Array | null,
    _env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    this.lines.push([line, stdin, cwd])
    return Promise.resolve({ stdout: ENC.encode(`box:${line}`), stderr: null, exitCode: 0 })
  }
}

describe('whole-line runtimes', () => {
  it('a captured command sends the raw line wholesale', async () => {
    const parser = await getTestParser()
    const box = new LineBox()
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [box, 'vfs'] },
    )
    try {
      const result = await ws.execute('nvidia-smi -L | grep GPU > /out.txt')
      expect(DEC.decode(result.stdout)).toBe('box:nvidia-smi -L | grep GPU > /out.txt')
      expect(box.lines[0]?.[0]).toBe('nvidia-smi -L | grep GPU > /out.txt')
    } finally {
      await ws.close()
    }
  })

  it('a "*" capture claims any line and stdin arrives', async () => {
    const parser = await getTestParser()
    const box = new LineBox()
    box.captures = ['*']
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [box, 'vfs'] },
    )
    try {
      const result = await ws.execute('ls / && echo done', { stdin: ENC.encode('fed') })
      expect(DEC.decode(result.stdout)).toBe('box:ls / && echo done')
      expect(DEC.decode(box.lines[0]?.[1] ?? new Uint8Array())).toBe('fed')
    } finally {
      await ws.close()
    }
  })

  it('a refused line falls to the workspace, never 126', async () => {
    const parser = await getTestParser()
    const box = new LineBox()
    box.captures = ['*']
    box.script = (ctx) => !ctx.line.includes('keep-out')
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [box, 'vfs'] },
    )
    try {
      const taken = await ws.execute('echo captured')
      const kept = await ws.execute('echo keep-out')
      expect(DEC.decode(taken.stdout)).toBe('box:echo captured')
      expect(DEC.decode(kept.stdout)).toBe('keep-out\n')
      expect(kept.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('the runtime argument places the whole line', async () => {
    const parser = await getTestParser()
    const box = new LineBox()
    box.captures = ['*']
    box.script = () => false
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [box, 'vfs'] },
    )
    try {
      const refused = await ws.execute('echo hi')
      const forced = await ws.execute('echo hi', { runtime: 'sandbox' })
      expect(DEC.decode(refused.stdout)).toBe('hi\n')
      expect(DEC.decode(forced.stdout)).toBe('box:echo hi')
    } finally {
      await ws.close()
    }
  })

  it('a sink receives the line the runtime served', async () => {
    const parser = await getTestParser()
    const box = new LineBox()
    box.captures = ['*']
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [box, 'vfs'] },
    )
    const console_ = new JobConsole()
    try {
      // The runtime buffers and never touches the sink itself, so
      // without the drain a streaming caller reads nothing at all.
      const result = await ws.execute('echo hi', { sink: console_ })
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('')
      expect(DEC.decode(await console_.snapshot(Channel.STDOUT))).toBe('box:echo hi')
    } finally {
      await ws.close()
    }
  })

  it('the vfs entry is a pure routing marker', async () => {
    // A vfs-resolved line runs on the workspace executor inline; the
    // entry is a marker with no line door to call.
    const parser = await getTestParser()
    const vfs = new VFSRuntime()
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: ['pyodide', vfs] },
    )
    try {
      expect(isLineExecutor(vfs)).toBe(false)
      const result = await ws.execute('echo through-vfs')
      expect(DEC.decode(result.stdout)).toBe('through-vfs\n')
      expect(result.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })
})
