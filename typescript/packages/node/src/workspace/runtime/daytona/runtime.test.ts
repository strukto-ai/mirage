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
import type { RemoteSandboxOptions } from '@struktoai/mirage-core'
import { DaytonaRuntime, type DaytonaSdk } from './runtime.ts'

const DEC = new TextDecoder()

class FakeProcess {
  calls: [string, string | undefined, Record<string, string> | undefined][] = []

  executeCommand(command: string, cwd?: string, env?: Record<string, string>) {
    this.calls.push([command, cwd, env])
    const result = command.includes('$HOME') ? '/home/daytona' : `out:${command}`
    return Promise.resolve({ exitCode: 0, result })
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

  downloadFile(path: string): Promise<Buffer> {
    return Promise.resolve(this.files.get(path) ?? Buffer.alloc(0))
  }
}

class FakeSandbox {
  readonly id = 'sb-77'
  readonly process = new FakeProcess()
  readonly fs = new FakeFs()
}

class FakeClient {
  static created: object[] = []
  static fetched: string[] = []
  static deleted: object[] = []
  static disposed = 0
  static last: FakeSandbox | null = null

  constructor(readonly config?: object) {}

  create(params: object): Promise<FakeSandbox> {
    FakeClient.created.push(params)
    FakeClient.last = new FakeSandbox()
    return Promise.resolve(FakeClient.last)
  }

  get(sandboxId: string): Promise<FakeSandbox> {
    FakeClient.fetched.push(sandboxId)
    FakeClient.last = new FakeSandbox()
    return Promise.resolve(FakeClient.last)
  }

  delete(sandbox: object): Promise<void> {
    FakeClient.deleted.push(sandbox)
    return Promise.resolve()
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

function makeRuntime(options: RemoteSandboxOptions = {}): FakedDaytonaRuntime {
  FakeClient.created = []
  FakeClient.fetched = []
  FakeClient.deleted = []
  FakeClient.disposed = 0
  FakeClient.last = null
  return new FakedDaytonaRuntime(options)
}

describe('DaytonaRuntime', () => {
  it('maps image, env, and a gpu type onto create params', async () => {
    const runtime = makeRuntime({
      config: { image: 'cuda:12', env: { A: '1' }, cpu: 4, gpu: 'H100' },
    })
    const sandboxId = await runtime.createSandbox()
    expect(sandboxId).toBe('sb-77')
    const params = FakeClient.created[0] as Record<string, unknown>
    expect(params.image).toBe('cuda:12')
    expect(params.envVars).toEqual({ A: '1' })
    expect(params.ephemeral).toBe(true)
    expect(params.resources).toEqual({ cpu: 4, gpu: 1, gpuType: 'H100' })
  })

  it('a gpu count passes through as a count', async () => {
    const runtime = makeRuntime({ config: { image: 'cuda:12', gpu: 2 } })
    await runtime.createSandbox()
    const params = FakeClient.created[0] as Record<string, unknown>
    expect(params.resources).toEqual({ gpu: 2 })
    expect(params.ephemeral).toBe(true)
  })

  it('no image falls to the default snapshot params', async () => {
    const runtime = makeRuntime()
    await runtime.createSandbox()
    const params = FakeClient.created[0] as Record<string, unknown>
    expect('image' in params).toBe(false)
    expect('resources' in params).toBe(false)
  })

  it('a template boots a snapshot by name', async () => {
    const runtime = makeRuntime({ config: { template: 'mirage-fuse' } })
    await runtime.createSandbox()
    const params = FakeClient.created[0] as Record<string, unknown>
    expect(params.snapshot).toBe('mirage-fuse')
    expect('image' in params).toBe(false)
  })

  it('template and image conflict', () => {
    expect(() => makeRuntime({ config: { template: 'mirage-fuse', image: 'cuda:12' } })).toThrow(
      'not both',
    )
  })

  it('cli args fail loud', () => {
    expect(() => makeRuntime({ config: { args: ['--cap-add', 'SYS_ADMIN'] } })).toThrow('params')
  })

  it('params pass through with snake_case keys camelized', async () => {
    const runtime = makeRuntime({
      config: {
        params: { auto_stop_interval: 10, auto_archive_interval: 30, labels: { team: 'ml' } },
      },
    })
    await runtime.createSandbox()
    const params = FakeClient.created[0] as Record<string, unknown>
    expect(params.autoStopInterval).toBe(10)
    expect(params.autoArchiveInterval).toBe(30)
    expect(params.labels).toEqual({ team: 'ml' })
  })

  it('params merge last over config fields', async () => {
    const runtime = makeRuntime({
      config: { image: 'cuda:12', params: { image: 'cuda:13' } },
    })
    await runtime.createSandbox()
    const params = FakeClient.created[0] as Record<string, unknown>
    expect(params.image).toBe('cuda:13')
  })

  it('sizing without an image fails loud', async () => {
    const runtime = makeRuntime({ config: { gpu: 1 } })
    await expect(runtime.createSandbox()).rejects.toThrow('requires an image')
  })

  it('redirects stdin through an uploaded file', async () => {
    const runtime = makeRuntime()
    await runtime.createSandbox()
    const result = await runtime.execLine(
      'wc -l',
      new TextEncoder().encode('a\nb\n'),
      { E: '1' },
      '/workspace',
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBeNull()
    expect(DEC.decode(result.stdout)).toBe('out:( wc -l ) < /tmp/.mirage_stdin')
    const sandbox = FakeClient.last ?? new FakeSandbox()
    expect(DEC.decode(sandbox.fs.files.get('/tmp/.mirage_stdin'))).toBe('a\nb\n')
    const [command, cwd, env] = sandbox.process.calls[0] ?? ['', undefined, undefined]
    expect(command).toBe('( wc -l ) < /tmp/.mirage_stdin')
    expect(cwd).toBe('/workspace')
    expect(env).toEqual({ E: '1' })
  })

  it('derives the default workspace root from the sandbox $HOME', async () => {
    const runtime = makeRuntime()
    await runtime.createSandbox()
    expect(await runtime.defaultWorkspaceRoot()).toBe('/home/daytona/workspace')
  })

  it('a reattached sandbox survives close', async () => {
    const runtime = makeRuntime({ sandboxId: 'sb-live' })
    await runtime.connectSandbox('sb-live')
    expect(FakeClient.fetched).toEqual(['sb-live'])
    await runtime.close()
    expect(FakeClient.deleted).toHaveLength(0)
    expect(FakeClient.disposed).toBe(1)
  })

  it('close deletes only an owned sandbox', async () => {
    const runtime = makeRuntime()
    await runtime.createSandbox()
    runtime.ownedSandbox = true
    await runtime.close()
    expect(FakeClient.deleted).toHaveLength(1)
    expect(FakeClient.disposed).toBe(1)
  })

  it("registers under the config name 'daytona'", () => {
    const runtime = buildRuntime('daytona', { config: { image: 'cuda:12' } })
    expect(runtime).toBeInstanceOf(DaytonaRuntime)
    expect(runtime.captures).toEqual(['*'])
  })
})
