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

import { buildRuntime, stdinRedirect } from '@struktoai/mirage-core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeOptions } from '@struktoai/mirage-core'
import type { DaytonaConfig } from './config.ts'
import { DaytonaRuntime, type DaytonaSdk } from './runtime.ts'

const DEC = new TextDecoder()

class FakeProcess {
  calls: [string, string | undefined, Record<string, string> | undefined][] = []

  executeCommand(command: string, cwd?: string, env?: Record<string, string>) {
    this.calls.push([command, cwd, env])
    return Promise.resolve({ exitCode: 0, result: `out:${command}` })
  }
}

class FakeFs {
  files = new Map<string, Buffer>()
  folders: string[] = []

  createFolder(path: string, _mode: string): Promise<void> {
    this.folders.push(path)
    return Promise.resolve()
  }

  uploadFile(data: Buffer, path: string): Promise<void> {
    this.files.set(path, data)
    return Promise.resolve()
  }
}

class FakeSandbox {
  readonly id = 'sb-77'
  readonly process = new FakeProcess()
  readonly fs = new FakeFs()
}

class FakeClient {
  static configs: (object | undefined)[] = []
  static fetched: string[] = []
  static disposed = 0
  static last: FakeSandbox | null = null

  constructor(readonly config?: object) {
    FakeClient.configs.push(config)
  }

  get(sandboxId: string): Promise<FakeSandbox> {
    FakeClient.fetched.push(sandboxId)
    FakeClient.last = new FakeSandbox()
    return Promise.resolve(FakeClient.last)
  }

  [Symbol.asyncDispose](): Promise<void> {
    FakeClient.disposed += 1
    return Promise.resolve()
  }
}

class FakedDaytonaRuntime extends DaytonaRuntime {
  protected override loadSdk(): Promise<DaytonaSdk> {
    return Promise.resolve({ Daytona: FakeClient } as unknown as DaytonaSdk)
  }
}

function makeRuntime(
  options: RuntimeOptions<DaytonaConfig> | Record<string, unknown> = {
    config: { sandboxId: 'sb-live' },
  },
): FakedDaytonaRuntime {
  return new FakedDaytonaRuntime(options)
}

beforeEach(() => {
  FakeClient.configs = []
  FakeClient.fetched = []
  FakeClient.disposed = 0
  FakeClient.last = null
})

describe('DaytonaRuntime', () => {
  it('connect gets the user sandbox by id', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    expect(FakeClient.fetched).toEqual(['sb-live'])
  })

  it('sandboxId is required', () => {
    expect(() => makeRuntime({ config: {} })).toThrow('sandboxId')
  })

  it('the apiKey reaches the client', async () => {
    const runtime = makeRuntime({ config: { sandboxId: 'sb-live', apiKey: 'k-123' } })
    await runtime.connect()
    expect(FakeClient.configs[0]).toEqual({ apiKey: 'k-123' })
  })

  it('redirects stdin through an uploaded file', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    const result = await runtime.execLine(
      'wc -l',
      new TextEncoder().encode('a\nb\n'),
      { E: '1' },
      '/workspace',
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBeNull()
    const sandbox = FakeClient.last ?? new FakeSandbox()
    const [path] = [...sandbox.fs.files.keys()]
    // Unique per invocation, so concurrent stdin lines never collide.
    expect(path).toMatch(/^\/tmp\/\.mirage_stdin_/)
    expect(DEC.decode(sandbox.fs.files.get(path ?? ''))).toBe('a\nb\n')
    const [command, cwd, env] = sandbox.process.calls[0] ?? ['', undefined, undefined]
    expect(command).toBe(stdinRedirect('wc -l', path ?? ''))
    expect(command).toContain(`rm -f ${path ?? ''}`)
    expect(cwd).toBe('/workspace')
    expect(env).toEqual({ E: '1' })
  })

  it('close releases the client, never the sandbox', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    await runtime.close()
    // The fake exposes no delete at all: close only drops the client.
    expect(FakeClient.disposed).toBe(1)
  })

  it("registers under the config name 'daytona'", () => {
    const runtime = buildRuntime('daytona', { config: { sandboxId: 'sb-live' } })
    expect(runtime).toBeInstanceOf(DaytonaRuntime)
    expect(runtime.captures).toEqual(['*'])
  })
})
