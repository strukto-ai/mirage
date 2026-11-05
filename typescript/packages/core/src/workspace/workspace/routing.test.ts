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
import type { CommandExplanation, ShellNode } from '../../policy/types.ts'
import { PythonRuntime } from '../../runtime/python/base.ts'
import { RemoteSandbox } from '../../runtime/sandbox/base.ts'
import { programsProbe } from '../../runtime/sandbox/constants.ts'
import type { RunResult } from '../../runtime/types.ts'
import { shellJoin } from '../../shell/join.ts'
import type { Action, Policy } from '../../policy/index.ts'
import { Limit, MountMode } from '../../types.ts'
import { Mount } from '../mount/spec.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import type { WorkspaceOptions } from './types.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// A python engine that answers its own name.
class Monty extends PythonRuntime {
  readonly name = 'monty'

  interpret(): Promise<RunResult> {
    return Promise.resolve({ stdout: ENC.encode('monty\n'), stderr: null, exitCode: 0 })
  }
}

// A box serving the workspace that holds `holds` of the interpreters and
// records every line it runs.
class Box extends RemoteSandbox {
  readonly name: string = 'box'
  probes = 0
  readonly lines: string[] = []

  constructor(
    readonly holds = 'python3\n',
    readonly serves = true,
    captures?: readonly string[],
  ) {
    super(captures === undefined ? {} : { captures })
  }

  protected override servesInterpreters(): boolean {
    return this.serves
  }

  override get fileEffectsDispatched(): boolean {
    return this.serves
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  protected execArgv(argv: readonly string[]): Promise<RunResult> {
    return this.execLine(shellJoin(argv))
  }

  override execLine(line: string): Promise<RunResult> {
    if (line === programsProbe()) {
      this.probes += 1
      return Promise.resolve({ stdout: ENC.encode(this.holds), stderr: null, exitCode: 0 })
    }
    this.lines.push(line)
    return Promise.resolve({ stdout: ENC.encode('box\n'), stderr: null, exitCode: 0 })
  }
}

function workspace(box: Box, options: WorkspaceOptions = {}): Workspace {
  return new Workspace(
    { '/ram': new RAMVFS() },
    { mode: MountMode.EXEC, runtimes: [box, new Monty(), 'workspace'], ...options },
  )
}

async function out(ws: Workspace, line: string): Promise<string> {
  return DEC.decode((await ws.shell(line)).stdout)
}

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const io = await ws.shell(line)
  return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
}

describe('Router interpreters', () => {
  it('asks the box once on the first interpreter line and runs it there', async () => {
    const box = new Box()
    const ws = workspace(box)
    try {
      expect(await out(ws, 'echo hi')).toBe('hi\n')
      expect(box.probes).toBe(0)
      await ws.shell('cd /ram')
      expect(await out(ws, 'python3 -c x')).toBe('box\n')
      expect(await out(ws, 'python3 -c y')).toBe('box\n')
      expect(box.probes).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('keeps an interpreter the box lacks on its language runtime', async () => {
    const box = new Box('')
    const ws = workspace(box)
    try {
      expect(await out(ws, 'python3 -c x')).toBe('monty\n')
      expect(await out(ws, 'python3 -c y')).toBe('monty\n')
      expect(box.probes).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('never asks the box to explain a line', async () => {
    const box = new Box()
    const ws = workspace(box)
    try {
      await ws.explain('python3 -c x')
      expect(box.probes).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it("keeps an interpreter on Mirage's own root on its runtime", async () => {
    const box = new Box()
    const ws = workspace(box)
    try {
      await ws.shell("echo 'print(1)' > /hello.py")
      expect(await out(ws, 'python3 /hello.py')).toBe('monty\n')
      await ws.shell('cd /ram')
      expect(await out(ws, 'python3 -c x')).toBe('box\n')
      await ws.shell('cd /')
      expect(await out(ws, 'python3 -c x')).toBe('monty\n')
    } finally {
      await ws.close()
    }
  })
})

describe('Router split lines', () => {
  it.each<[string, string[]]>([
    ['cd /opt/app && make', []],
    ['cat /tmp/a | gcc -', ['gcc -']],
    ['gcc /opt/x.c -o /opt/x', ['gcc /opt/x.c -o /opt/x']],
    ['cd /ram && make', ['make']],
  ])('runs each command of %s on its capturer beside a sandbox', async (line, split) => {
    const box = new Box('')
    const ws = workspace(box)
    try {
      await ws.shell(line)
      expect(box.lines).toEqual(split)
    } finally {
      await ws.close()
    }
  })
})

const BINARY = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00])

describe('Router binaries', () => {
  it('runs a binary in the sandbox that serves the workspace', async () => {
    const box = new Box('')
    const ws = workspace(box)
    try {
      await ws.vfs.write('/ram/t', BINARY)
      await ws.shell('cd /ram && ./t a')
      expect(box.lines).toEqual(['./t a'])
    } finally {
      await ws.close()
    }
  })

  it.each<[boolean, MountMode]>([
    [false, MountMode.EXEC],
    [true, MountMode.WRITE],
  ])(
    'answers 126 for a binary without a serving sandbox or exec (serves %s, %s)',
    async (serves, mode) => {
      const box = new Box('', serves)
      const ws = new Workspace(
        { '/ram': new RAMVFS() },
        { mode, runtimes: [box, new Monty(), 'workspace'] },
      )
      try {
        await ws.vfs.write('/ram/t', BINARY)
        expect(await run(ws, 'cd /ram && ./t a')).toEqual([
          126,
          '',
          './t: cannot execute binary file: Exec format error\n',
        ])
        expect(box.lines).toEqual([])
      } finally {
        await ws.close()
      }
    },
  )
})

function runtimes(node: ShellNode | CommandExplanation): string[] {
  const found = node.type === 'command' ? [(node as CommandExplanation).runtime] : []
  for (const child of node.children) found.push(...runtimes(child))
  return found
}

describe('Router explain', () => {
  it('names the line runtime for every command it takes', async () => {
    const lined = new Box('', true, ['@line'])
    const ws = workspace(lined)
    try {
      expect(runtimes((await ws.explain('cd /ram && make')).node)).toEqual(['box', 'box'])
    } finally {
      await ws.close()
    }
  })
})

describe('Router probe', () => {
  it.each<[string, boolean]>([
    ['cat /ram/a.txt', false],
    ['cd /ram && ls /ram', false],
    ['echo python3', true],
    ['env python3 -c x', true],
    ['./t', true],
  ])('asks the box only when %s may run an interpreter (%s)', async (line, asks) => {
    const box = new Box()
    const ws = workspace(box)
    try {
      await ws.shell(line)
      expect(box.probes).toBe(asks ? 1 : 0)
    } finally {
      await ws.close()
    }
  })
})

describe('Router exec rule', () => {
  it.each<[string, string]>([
    ['python3 x.py', 'python3: x.py: not in EXEC mode\n'],
    ['python3 -c 1', "python3: root mount '/' is not in EXEC mode\n"],
  ])('keeps the mounts exec rule for an interpreter the box took: %s', async (line, said) => {
    const box = new Box()
    const ws = new Workspace(
      { '/ram': new RAMVFS() },
      { mode: MountMode.WRITE, runtimes: [box, new Monty(), 'workspace'] },
    )
    try {
      await ws.vfs.write('/ram/x.py', 'print(1)')
      await ws.shell('cd /ram')
      expect(await run(ws, line)).toEqual([126, '', said])
      expect(box.lines).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('keeps an interpreter on a root mount on its runtime', async () => {
    const box = new Box()
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: [box, new Monty(), 'workspace'] },
    )
    try {
      await ws.vfs.write('/x.py', 'print(1)')
      expect(await out(ws, 'python3 /x.py')).toBe('monty\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps an interpreter the box took in Mirage under a workspace route', async () => {
    class Keep implements Policy {
      preExecute(): Action {
        return { kind: 'route', runtime: 'workspace' }
      }
    }
    const box = new Box()
    const ws = workspace(box, { policies: [new Keep()] })
    try {
      await ws.shell('cd /ram')
      expect(await out(ws, 'python3 -c x')).toBe('monty\n')
    } finally {
      await ws.close()
    }
  })
})

describe('Router nested exec rule', () => {
  it.each(['bash b.sh', `c='python3 x.py'; eval "$c"`, './x.py', "echo 'python3 x.py' | sh"])(
    'keeps the exec rule for a nested interpreter the box took: %s',
    async (line) => {
      const box = new Box()
      const ws = new Workspace(
        { '/ram': new RAMVFS() },
        { mode: MountMode.WRITE, runtimes: [box, new Monty(), 'workspace'] },
      )
      try {
        await ws.vfs.write('/ram/x.py', '#!/usr/bin/env python3\nprint(1)\n')
        await ws.vfs.write('/ram/b.sh', 'python3 x.py\n')
        await ws.shell('cd /ram')
        await ws.shell('python3 -c 1')
        const [code, , err] = await run(ws, line)
        expect(code).toBe(126)
        expect(err.endsWith('not in EXEC mode\n')).toBe(true)
        expect(box.lines).toEqual([])
      } finally {
        await ws.close()
      }
    },
  )
})

describe('Router pins', () => {
  it('asks no box for a runtime argument', async () => {
    const box = new Box()
    const ws = workspace(box)
    try {
      await ws.shell('python3 -c x', { runtime: 'monty' })
      expect(box.probes).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('keeps a root interpreter off the box under a route policy', async () => {
    const box = new Box()
    const ws = workspace(box, { routePolicy: () => null })
    try {
      await ws.shell("echo 'print(1)' > /hello.py")
      expect(await out(ws, 'python3 /hello.py')).toBe('monty\n')
    } finally {
      await ws.close()
    }
  })
})

describe('Router interpreter options', () => {
  it.each<[string, string, boolean]>([
    ['/x', 'python3 -u /w/x.py', false],
    ['/x', 'python3 -X dev /w/x.py', false],
    ['/x', 'python3 -- /w/x.py', false],
    ['/x', 'python3 /w/x.py -c', false],
    ['/w', 'python3 -u /x/x.py', true],
  ])('reads the interpreter own options from %s: %s', async (cwd, line, ran) => {
    const box = new Box()
    const ws = new Workspace(
      {
        '/x': new Mount(new RAMVFS(), { mode: MountMode.EXEC }),
        '/w': new Mount(new RAMVFS(), { mode: MountMode.WRITE }),
      },
      { runtimes: [box, new Monty(), 'workspace'] },
    )
    try {
      await ws.vfs.write('/x/x.py', 'print(1)')
      await ws.vfs.write('/w/x.py', 'print(1)')
      await ws.shell('cd /x && python3 -c 1')
      box.lines.length = 0
      await ws.shell(`cd ${cwd}`)
      const [code, , err] = await run(ws, line)
      if (ran) {
        expect([code, box.lines]).toEqual([0, [line]])
      } else {
        expect([code, err]).toEqual([126, 'python3: /w/x.py: not in EXEC mode\n'])
        expect(box.lines).toEqual([])
      }
    } finally {
      await ws.close()
    }
  })
})

class Box2 extends Box {
  override readonly name = 'box2'
}

describe('Router review fixes', () => {
  it.each(['/hello.py', 'env python3 /hello.py', "sh -c 'python3 /hello.py'"])(
    "keeps an interpreter reached on Mirage's own root on its runtime: %s",
    async (line) => {
      const box = new Box()
      const ws = workspace(box)
      try {
        await ws.shell('cd /ram && python3 -c 1')
        await ws.vfs.write('/hello.py', ENC.encode('#!/usr/bin/env python3\nprint(1)\n'))
        await ws.shell('chmod +x /hello.py')
        box.lines.length = 0
        await ws.shell('cd /ram')
        expect(await out(ws, line)).toBe('monty\n')
        expect(box.lines).toEqual([])
      } finally {
        await ws.close()
      }
    },
  )

  it('chooses the root fallback per invocation, and explain agrees', async () => {
    const box = new Box()
    const ws = workspace(box)
    try {
      await ws.shell('cd /ram && python3 -c 1')
      await ws.shell('cd /')
      const line = 'python3 -c 1; cd /ram; python3 -c 2'
      const said = await ws.explain(line)
      expect(runtimes(said.node)).toEqual(['monty', '', 'box'])
      expect(await out(ws, line)).toBe('monty\nbox\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps an interpreter in Mirage when several sandboxes learned it', async () => {
    class Keep implements Policy {
      preExecute(): Action {
        return { kind: 'route', runtime: 'workspace' }
      }
    }
    const [first, second] = [new Box(), new Box2()]
    const kept = new Workspace(
      { '/ram': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: [first, second, new Monty(), 'workspace'],
        policies: [new Keep()],
      },
    )
    const rooted = new Workspace(
      { '/ram': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: [new Box(), new Box2(), new Monty(), 'workspace'] },
    )
    try {
      await kept.shell('cd /ram')
      expect(await out(kept, 'python3 -c x')).toBe('monty\n')
      expect([first.lines, second.lines]).toEqual([[], []])
      await rooted.shell('cd /ram && python3 -c 1')
      await rooted.shell('cd /')
      expect(await out(rooted, 'python3 -c x')).toBe('monty\n')
    } finally {
      await kept.close()
      await rooted.close()
    }
  })

  it("answers 126 for a binary on Mirage's own root", async () => {
    const box = new Box('')
    const ws = workspace(box)
    try {
      await ws.vfs.write('/t', BINARY)
      expect((await run(ws, '/t a'))[0]).toBe(126)
      expect(box.lines).toEqual([])
    } finally {
      await ws.close()
    }
  })
})

describe('Router linked scripts', () => {
  it.each<[string, string, string]>([
    ['/ram/link.py', '/hello.py', 'python3 /ram/link.py'],
    ['/entry.py', '/ram/app.py', 'python3 /entry.py'],
  ])(
    "keeps a script linked to or from Mirage's own root on its runtime: %s",
    async (link, target, line) => {
      const box = new Box()
      const ws = workspace(box)
      try {
        await ws.shell('cd /ram && python3 -c 1')
        await ws.vfs.write(target, ENC.encode('print(1)\n'))
        await ws.shell(`ln -s ${target} ${link}`)
        box.lines.length = 0
        expect(await out(ws, line)).toBe('monty\n')
        expect(box.lines).toEqual([])
      } finally {
        await ws.close()
      }
    },
  )
})

describe('Router linked script exec rule', () => {
  it("judges the script's link target", async () => {
    const box = new Box()
    const ws = new Workspace(
      {
        '/x': new Mount(new RAMVFS(), { mode: MountMode.EXEC }),
        '/w': new Mount(new RAMVFS(), { mode: MountMode.WRITE }),
      },
      { runtimes: [box, new Monty(), 'workspace'] },
    )
    try {
      await ws.vfs.write('/w/app.py', ENC.encode('print(1)'))
      await ws.shell('cd /x && python3 -c 1')
      await ws.shell('ln -s /w/app.py /x/link.py')
      box.lines.length = 0
      const [code, , err] = await run(ws, 'python3 /x/link.py')
      expect([code, err.includes('/w/app.py')]).toEqual([126, true])
      expect(box.lines).toEqual([])
    } finally {
      await ws.close()
    }
  })
})

describe('Router linked binaries', () => {
  it("answers 126 for a binary linked from Mirage's own root", async () => {
    const box = new Box('')
    const ws = workspace(box)
    try {
      await ws.vfs.write('/ram/t', BINARY)
      await ws.shell('ln -s /ram/t /entry')
      await ws.shell('cd /ram')
      expect((await run(ws, '/entry a'))[0]).toBe(126)
      expect(box.lines).toEqual([])
    } finally {
      await ws.close()
    }
  })
})

// A box that answers the interpreter probe after `delay` milliseconds.
class SlowProbeBox extends Box {
  constructor(readonly delay: number) {
    super()
  }

  override async execLine(line: string): Promise<RunResult> {
    if (line === programsProbe()) await new Promise((resolve) => setTimeout(resolve, this.delay))
    return super.execLine(line)
  }
}

describe('Router probe budget', () => {
  it("waits for the interpreter probe no longer than the line's budget", async () => {
    const box = new SlowProbeBox(1500)
    const ws = workspace(box, { commandLimits: { '@line': new Limit({ timeoutSeconds: 0.2 }) } })
    try {
      await ws.shell('cd /ram')
      const began = performance.now()
      const [code] = await run(ws, 'python3 -c x')
      expect([code, performance.now() - began < 1000]).toEqual([124, true])
    } finally {
      await ws.close()
    }
  })
})
