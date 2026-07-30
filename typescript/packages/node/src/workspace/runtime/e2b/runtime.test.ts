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

import { stdinRedirect, buildRuntime } from '@struktoai/mirage-core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeOptions } from '@struktoai/mirage-core'
import type { E2BConfig } from './config.ts'
import { E2BRuntime, type E2bSdk } from './runtime.ts'

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
}

class FakeSandbox {
  static connected: [string, Record<string, unknown>][] = []
  static last: FakeSandbox | null = null

  readonly sandboxId = 'sb-e2b'
  readonly commands = new FakeCommands()
  readonly files = new FakeFiles()

  static connect(sandboxId: string, params: Record<string, unknown>): Promise<FakeSandbox> {
    FakeSandbox.connected.push([sandboxId, params])
    FakeSandbox.last = new FakeSandbox()
    return Promise.resolve(FakeSandbox.last)
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

function makeRuntime(
  options: RuntimeOptions<E2BConfig> | Record<string, unknown> = {
    config: { sandboxId: 'sb-live' },
  },
): FakedE2BRuntime {
  return new FakedE2BRuntime(options)
}

beforeEach(() => {
  FakeSandbox.connected = []
  FakeSandbox.last = null
})

describe('E2BRuntime', () => {
  it('connect attaches by id with the apiKey', async () => {
    const runtime = makeRuntime({ config: { sandboxId: 'sb-live', apiKey: 'k-123' } })
    await runtime.connect()
    expect(FakeSandbox.connected).toEqual([['sb-live', { apiKey: 'k-123' }]])
  })

  it('sandboxId is required', () => {
    expect(() => makeRuntime({ config: {} })).toThrow('sandboxId')
  })

  it('threads env and cwd and reports real stderr', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    const result = await runtime.execLine('wc -l', null, { E: '1' }, '/workspace')
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('out:wc -l')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('warn')
    const sandbox = FakeSandbox.last ?? new FakeSandbox()
    expect(sandbox.commands.calls[0]).toEqual(['wc -l', { E: '1' }, '/workspace'])
  })

  it('a nonzero exit comes back as a result', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    const result = await runtime.execLine('exit 3', null, {}, '/workspace')
    expect(result.exitCode).toBe(3)
    expect(DEC.decode(result.stdout)).toBe('partial')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('boom-err')
  })

  it('redirects stdin through an uploaded file', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    const result = await runtime.execLine(
      'wc -l',
      new TextEncoder().encode('a\nb\n'),
      {},
      '/workspace',
    )
    expect(result.exitCode).toBe(0)
    const sandbox = FakeSandbox.last ?? new FakeSandbox()
    const [path] = [...sandbox.files.files.keys()]
    // Unique per invocation, so concurrent stdin lines never collide.
    expect(path).toMatch(/^\/tmp\/\.mirage_stdin_/)
    expect(DEC.decode(sandbox.files.files.get(path ?? ''))).toBe('a\nb\n')
    expect(sandbox.files.dirs).toEqual(['/tmp'])
    const [command, , cwd] = sandbox.commands.calls[0] ?? ['', undefined, undefined]
    expect(command).toBe(stdinRedirect('wc -l', path ?? ''))
    expect(command).toContain(`rm -f ${path ?? ''}`)
    expect(cwd).toBe('/workspace')
  })

  it("registers under the config name 'e2b'", () => {
    const runtime = buildRuntime('e2b', { config: { sandboxId: 'sb-live' } })
    expect(runtime).toBeInstanceOf(E2BRuntime)
    expect(runtime.captures).toEqual(['*'])
  })
})
