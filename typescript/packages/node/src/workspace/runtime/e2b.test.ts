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

import { buildRuntime } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { E2BRuntime, type E2BRuntimeOptions, type E2bSdk } from './e2b.ts'

const DEC = new TextDecoder()

class FakeExitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`exit ${String(exitCode)}`)
  }
}

class FakeCommands {
  calls: [string, Record<string, string> | undefined, string | undefined][] = []

  run(command: string, opts?: { envs?: Record<string, string>; cwd?: string }) {
    this.calls.push([command, opts?.envs, opts?.cwd])
    if (command.includes('$HOME')) {
      return Promise.resolve({ stdout: '/home/user', stderr: '', exitCode: 0 })
    }
    if (command.includes('exit 3')) {
      return Promise.reject(new FakeExitError(3, 'partial', 'boom-err'))
    }
    return Promise.resolve({ stdout: `out:${command}`, stderr: 'warn', exitCode: 0 })
  }
}

class FakeFiles {
  files = new Map<string, Uint8Array>()
  dirs: string[] = []

  makeDir(path: string): Promise<boolean> {
    this.dirs.push(path)
    return Promise.resolve(true)
  }

  async write(path: string, data: Blob): Promise<void> {
    this.files.set(path, new Uint8Array(await data.arrayBuffer()))
  }

  read(path: string, opts: { format: string }): Promise<Uint8Array> {
    expect(opts.format).toBe('bytes')
    return Promise.resolve(this.files.get(path) ?? new Uint8Array())
  }
}

class FakeSandbox {
  static created: Record<string, unknown>[] = []
  static connected: [string, Record<string, unknown>][] = []
  static killed = 0
  static last: FakeSandbox | null = null

  readonly sandboxId = 'sb-e2b'
  readonly commands = new FakeCommands()
  readonly files = new FakeFiles()

  static create(params: Record<string, unknown>): Promise<FakeSandbox> {
    FakeSandbox.created.push(params)
    FakeSandbox.last = new FakeSandbox()
    return Promise.resolve(FakeSandbox.last)
  }

  static connect(sandboxId: string, params: Record<string, unknown>): Promise<FakeSandbox> {
    FakeSandbox.connected.push([sandboxId, params])
    FakeSandbox.last = new FakeSandbox()
    return Promise.resolve(FakeSandbox.last)
  }

  kill(): Promise<boolean> {
    FakeSandbox.killed += 1
    return Promise.resolve(true)
  }
}

class FakedE2BRuntime extends E2BRuntime {
  protected override loadSdk(): Promise<E2bSdk> {
    return Promise.resolve({
      Sandbox: FakeSandbox,
      CommandExitError: FakeExitError,
    } as unknown as E2bSdk)
  }
}

function makeRuntime(options: E2BRuntimeOptions = {}): FakedE2BRuntime {
  FakeSandbox.created = []
  FakeSandbox.connected = []
  FakeSandbox.killed = 0
  FakeSandbox.last = null
  return new FakedE2BRuntime(options)
}

describe('E2BRuntime', () => {
  it('maps template, env, and apiKey onto create params', async () => {
    const runtime = makeRuntime({
      template: 'mirage-base',
      env: { A: '1' },
      apiKey: 'k-123',
    })
    const sandboxId = await runtime.createSandbox()
    expect(sandboxId).toBe('sb-e2b')
    expect(FakeSandbox.created[0]).toEqual({
      apiKey: 'k-123',
      template: 'mirage-base',
      envs: { A: '1' },
    })
  })

  it('sandboxParams merge last with snake_case keys camelized', async () => {
    const runtime = makeRuntime({
      template: 'mirage-base',
      sandboxParams: { template: 'override', timeout_ms: 600 },
    })
    await runtime.createSandbox()
    const params = FakeSandbox.created[0] ?? {}
    expect(params.template).toBe('override')
    expect(params.timeoutMs).toBe(600)
  })

  it('image fails loud', () => {
    expect(() => makeRuntime({ image: 'python:3.12' })).toThrow('template')
  })

  it('resources fail loud', () => {
    expect(() => makeRuntime({ resources: { cpu: 2 } })).toThrow('template')
  })

  it('threads env and cwd and reports real stderr', async () => {
    const runtime = makeRuntime()
    await runtime.createSandbox()
    const result = await runtime.execLine('wc -l', null, { E: '1' }, '/workspace')
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('out:wc -l')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('warn')
    const sandbox = FakeSandbox.last ?? new FakeSandbox()
    expect(sandbox.commands.calls[0]).toEqual(['wc -l', { E: '1' }, '/workspace'])
  })

  it('a nonzero exit comes back as a result, not a throw', async () => {
    const runtime = makeRuntime()
    await runtime.createSandbox()
    const result = await runtime.execLine('exit 3', null, {}, '/workspace')
    expect(result.exitCode).toBe(3)
    expect(DEC.decode(result.stdout)).toBe('partial')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('boom-err')
  })

  it('redirects stdin through an uploaded file', async () => {
    const runtime = makeRuntime()
    await runtime.createSandbox()
    const result = await runtime.execLine(
      'wc -l',
      new TextEncoder().encode('a\nb\n'),
      {},
      '/workspace',
    )
    expect(result.exitCode).toBe(0)
    const sandbox = FakeSandbox.last ?? new FakeSandbox()
    expect(DEC.decode(sandbox.files.files.get('/tmp/.mirage_stdin'))).toBe('a\nb\n')
    expect(sandbox.files.dirs).toEqual(['/tmp'])
    const [command, , cwd] = sandbox.commands.calls[0] ?? ['', undefined, undefined]
    expect(command).toBe('( wc -l ) < /tmp/.mirage_stdin')
    expect(cwd).toBe('/workspace')
  })

  it('derives the default workspace root from the sandbox $HOME', async () => {
    const runtime = makeRuntime()
    await runtime.createSandbox()
    expect(await runtime.defaultWorkspaceRoot()).toBe('/home/user/workspace')
  })

  it('a reattached sandbox survives close', async () => {
    const runtime = makeRuntime({ sandboxId: 'sb-live', apiKey: 'k-123' })
    await runtime.connectSandbox('sb-live')
    expect(FakeSandbox.connected).toEqual([['sb-live', { apiKey: 'k-123' }]])
    await runtime.close()
    expect(FakeSandbox.killed).toBe(0)
  })

  it('close kills only an owned sandbox', async () => {
    const runtime = makeRuntime()
    await runtime.createSandbox()
    runtime.ownedSandbox = true
    await runtime.close()
    expect(FakeSandbox.killed).toBe(1)
  })

  it("registers under the config name 'e2b'", () => {
    const runtime = buildRuntime('e2b', { template: 'mirage-base' })
    expect(runtime).toBeInstanceOf(E2BRuntime)
    expect(runtime.captures).toEqual(['*'])
  })
})
