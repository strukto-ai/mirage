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
import { Runtime } from '../../runtime/base.ts'
import { LINE_EXECUTOR, type LineExecutor } from '../../runtime/mixin.ts'
import { PythonRuntime } from '../../runtime/python/base.ts'
import type { Program, RunResult } from '../../runtime/types.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
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

class Gate extends Runtime implements LineExecutor {
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
