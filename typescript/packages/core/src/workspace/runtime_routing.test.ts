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
import { VfsRuntime, type RunArgs, type Runtime, type RunResult } from './executor/runtime.ts'
import { ScriptSource, type RouteScript } from './executor/route/index.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

class NamedFakeRuntime implements Runtime {
  readonly captures = ['python3', 'python']
  script?: RouteScript
  constructor(readonly name: string) {}
  attach(): void {
    // wiring is a no-op for the fake
  }
  run(_args: RunArgs): Promise<RunResult> {
    return Promise.resolve({
      stdout: ENC.encode(`ran-${this.name}\n`),
      stderr: new Uint8Array(),
      exitCode: 0,
    })
  }
  close(): Promise<void> {
    return Promise.resolve()
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
      expect(DEC.decode(denied.stderr)).toBe('mirage: python3: no runtime accepted this line\n')
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
        runtimes: [new VfsRuntime((ctx) => !ctx.line.includes('/secret'))],
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

  it('the global route names the runtime', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.EXEC,
        shellParser: parser,
        runtimes: [new NamedFakeRuntime('alpha'), new NamedFakeRuntime('beta'), 'vfs'],
        route: (ctx) => (ctx.line.includes('heavy') ? 'beta' : null),
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
    const ws = new Workspace(
      { '/': new RAMResource() },
      { mode: MountMode.EXEC, shellParser: parser, runtimes: [alpha, 'vfs'] },
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
        runtimes: [new NamedFakeRuntime('alpha'), new VfsRuntime({ captures: ['echo'] })],
      },
    )
    try {
      const ok = await ws.execute('echo listed')
      expect(DEC.decode(ok.stdout)).toBe('listed\n')
      const denied = await ws.execute('ls /')
      expect(denied.exitCode).toBe(126)
      expect(DEC.decode(denied.stderr)).toBe('mirage: ls: no runtime accepted this line\n')
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
        runtimes: [alpha, new VfsRuntime({ captures: ['echo'] })],
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
        runtimes: [new NamedFakeRuntime('alpha'), new VfsRuntime({ captures: [] })],
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
