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
import { MachineHandle } from '../../machine/handle.ts'
import { Runtime } from '../../runtime/base.ts'
import { LINE_EXECUTOR, type LineExecutorMixin } from '../../runtime/mixin.ts'
import { RemoteRuntime } from '../../runtime/machine/runtime.ts'
import { PythonRuntime } from '../../runtime/python/base.ts'
import type { Program, RunResult } from '../../runtime/types.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { logger } from './runtimes.ts'
import { Workspace } from './workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

interface Latch {
  promise: Promise<void>
  open: () => void
}

function latch(): Latch {
  let open: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

class Engine extends PythonRuntime {
  closed = 0
  entered = latch()
  release: Promise<void> = Promise.resolve()

  constructor(readonly name: string) {
    super()
  }

  async interpret(_engine: unknown, _program: Program, ctx: Context): Promise<RunResult> {
    this.entered.open()
    await new Promise<void>((resolve) => {
      void this.release.then(resolve)
      ctx.signal?.addEventListener('abort', () => {
        resolve()
      })
    })
    return { stdout: ENC.encode(`${this.name}\n`), stderr: null, exitCode: 0 }
  }

  override close(): Promise<void> {
    this.closed++
    return Promise.resolve()
  }
}

class Gate extends Runtime implements LineExecutorMixin {
  readonly [LINE_EXECUTOR] = true as const
  readonly name = 'gate'
  entered = latch()
  release = latch()

  constructor() {
    super({ captures: ['gate'] })
  }

  async runLine(): Promise<RunResult> {
    this.entered.open()
    await this.release.promise
    return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
  }
}

function workspace(...runtimes: Runtime[]): Workspace {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      runtimes: [...runtimes, 'workspace'],
    },
  )
}

async function python3(ws: Workspace, runtime?: string): Promise<[number, string, string]> {
  const io = await ws.shell('python3 -c x', runtime !== undefined ? { runtime } : {})
  return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
}

class Idle extends MachineHandle {
  static override readonly provider = 'idle'

  connect(): Promise<void> {
    return Promise.resolve()
  }

  protected execArgv(): Promise<RunResult> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })
  }
}

describe('the default world', () => {
  it.each([
    ['python3', '-c'],
    ['python', '-c'],
    ['node', '-e'],
    ['js', '-e'],
  ])('runs no %s', async (command, flag) => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.EXEC })
    try {
      const io = await ws.shell(`${command} ${flag} x`)
      expect([io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]).toEqual([
        127,
        '',
        `${command}: command not found\n`,
      ])
    } finally {
      await ws.close()
    }
  })
})

describe('removeRuntime', () => {
  it('swaps engines as remove then add and keeps a removed instance out', async () => {
    const alpha = new Engine('alpha')
    const ws = workspace(alpha, new Engine('beta'))
    try {
      expect(await python3(ws)).toEqual([0, 'alpha\n', ''])
      await ws.removeRuntime('alpha')
      expect(await python3(ws)).toEqual([0, 'beta\n', ''])
      expect(alpha.closed).toBe(1)
      expect(() => ws.addRuntime(alpha)).toThrow(/construct a new one/)
    } finally {
      await ws.close()
    }
    expect(alpha.closed).toBe(1)
  })

  it('waits for a running line before closing the runtime', async () => {
    const alpha = new Engine('alpha')
    const gate = latch()
    alpha.release = gate.promise
    const ws = workspace(alpha)
    try {
      const line = python3(ws)
      await alpha.entered.promise
      let removed = false
      const removing = ws.removeRuntime('alpha').then(() => {
        removed = true
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect([removed, alpha.closed]).toEqual([false, 0])
      gate.open()
      expect(await line).toEqual([0, 'alpha\n', ''])
      await removing
      expect(alpha.closed).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('refuses a line that resolved the runtime before its removal', async () => {
    const alpha = new Engine('alpha')
    const gate = new Gate()
    const ws = workspace(gate, alpha)
    try {
      const line = ws.shell('gate; python3 -c x', { runtime: 'alpha' })
      await gate.entered.promise
      await ws.removeRuntime('alpha')
      gate.release.open()
      const io = await line
      expect(io.exitCode).toBe(1)
      expect(DEC.decode(io.stderr)).toBe('python3: alpha: runtime was removed from the workspace\n')
    } finally {
      await ws.close()
    }
  })

  it('close settles a removal and closes the runtime once', async () => {
    const alpha = new Engine('alpha')
    alpha.release = new Promise<void>(() => undefined)
    const ws = workspace(alpha)
    const line = ws.shell('python3 -c x').then(
      () => 'finished',
      (err: unknown) => (err instanceof Error ? err.name : String(err)),
    )
    await alpha.entered.promise
    const removing = ws.removeRuntime('alpha')
    await Promise.resolve()
    await ws.close()
    await removing
    expect(await line).toBe('AbortError')
    expect(alpha.closed).toBe(1)
  })

  it('refuses the removed python workspace option', () => {
    expect(() => new Workspace({}, { python: { denyPackages: ['requests'] } } as never)).toThrow(
      /'python' workspace option was removed/,
    )
  })
})

class Box extends Runtime implements LineExecutorMixin {
  readonly [LINE_EXECUTOR] = true as const
  override readonly reach = 'remote'

  constructor(
    readonly name: string,
    ...captures: string[]
  ) {
    super({ captures: captures.length > 0 ? captures : ['@external'] })
  }

  runLine(): Promise<RunResult> {
    return Promise.resolve({ stdout: ENC.encode(`${this.name}\n`), stderr: null, exitCode: 0 })
  }
}

describe('addRuntime', () => {
  it.each([
    [() => [new Engine('a')], () => [new Box('b1'), new Box('b2')], ['b1', 'b2', 'a', 'workspace']],
    [() => [new Engine('a'), new Box('b1')], () => [new Box('b2')], ['a', 'b1', 'b2', 'workspace']],
    [
      () => [new Engine('a')],
      () => [new Engine('b'), new Box('b1')],
      ['b1', 'a', 'workspace', 'b'],
    ],
    [() => [new Gate(), new Engine('a')], () => [new Box('b1')], ['gate', 'b1', 'a', 'workspace']],
    [() => [new Gate()], () => [new Box('b1')], ['gate', 'workspace', 'b1']],
  ] as [() => Runtime[], () => Runtime[], string[]][])(
    'places an added sandbox after the last sandbox or before the languages (%#)',
    async (listed, added, order) => {
      const ws = workspace(...listed())
      try {
        for (const entry of added()) ws.addRuntime(entry)
        expect(ws.runtimes().map((r) => r.name)).toEqual(order)
      } finally {
        await ws.close()
      }
    },
  )

  it('runs a python3 captured on an added sandbox there', async () => {
    const ws = workspace(new Engine('monty'))
    try {
      ws.addRuntime(new Box('box', 'python3'))
      expect(await python3(ws)).toEqual([0, 'box\n', ''])
    } finally {
      await ws.close()
    }
  })
})

describe('shadowed captures', () => {
  it('logs a capture that never wins', async () => {
    const said: string[] = []
    logger.warn = (message) => said.push(message)
    const ws = workspace(new Engine('a'), new Engine('b'))
    try {
      ws.addRuntime(new Box('box', 'python3'))
      expect(said).toEqual([
        "runtime 'b' runs 'python3' only when a route names it: 'a', listed before it, takes it",
        "runtime 'b' runs 'python' only when a route names it: 'a', listed before it, takes it",
        "runtime 'a' runs 'python3' only when a route names it: 'box', listed before it, takes it",
        "runtime 'b' runs 'python3' only when a route names it: 'box', listed before it, takes it",
        "runtime 'b' runs 'python' only when a route names it: 'a', listed before it, takes it",
      ])
    } finally {
      delete logger.warn
      await ws.close()
    }
  })

  it('logs a capture only while no route policy can reach it', async () => {
    const said: string[] = []
    logger.warn = (message) => said.push(message)
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: [new Engine('a'), new Engine('b'), 'workspace'],
        routePolicy: (ctx) => (ctx.line.includes('fast') ? 'b' : null),
      },
    )
    try {
      expect(said).toEqual([])
      ws.policies.place(null)
      ws.addRuntime(new Box('box', 'python'))
      expect(said[0]).toBe(
        "runtime 'a' runs 'python' only when a route names it: 'box', listed before it, takes it",
      )
    } finally {
      delete logger.warn
      await ws.close()
    }
  })

  it('leaves a native entry another workspace holds on its own machines', async () => {
    const runtime = new RemoteRuntime({ captures: ['uname'], machine: 'box' })
    const first = new Idle('box')
    const ws = new Workspace(
      { '/d': new RAMVFS() },
      { mode: MountMode.EXEC, machines: { box: first }, runtimes: [runtime] },
    )
    try {
      expect(
        () =>
          new Workspace(
            { '/d': new RAMVFS() },
            { mode: MountMode.EXEC, machines: { box: new Idle('box') }, runtimes: [runtime] },
          ),
      ).toThrow('already bound')
      expect(runtime.handle({} as Context)).toBe(first)
    } finally {
      await ws.close()
    }
  })
})
