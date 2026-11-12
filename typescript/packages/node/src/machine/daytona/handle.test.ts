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

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { stdinRedirect } from './constants.ts'
import { encodeOutput, wrapLine } from '@struktoai/mirage-core/machine/constants'
import { buildMachine } from '@struktoai/mirage-core/machine/registry'
import type { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '../../workspace.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DaytonaConfig } from './config.ts'
import { DaytonaMachine } from './handle.ts'
import type { DaytonaSdk } from './sdk.ts'
import { on } from '../../../tests/fixtures/machine.ts'

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

class FakeMachine {
  readonly id = 'sb-77'
  readonly process = new FakeProcess()
  readonly fs = new FakeFs()
}

class FakeClient {
  static configs: (object | undefined)[] = []
  static fetched: string[] = []
  static disposed = 0
  static last: FakeMachine | null = null

  constructor(readonly config?: object) {
    FakeClient.configs.push(config)
  }

  get(sandboxId: string): Promise<FakeMachine> {
    FakeClient.fetched.push(sandboxId)
    FakeClient.last = new FakeMachine()
    return Promise.resolve(FakeClient.last)
  }

  [Symbol.asyncDispose](): Promise<void> {
    FakeClient.disposed += 1
    return Promise.resolve()
  }
}

class FakedDaytonaMachine extends DaytonaMachine {
  protected override loadSdk(): Promise<DaytonaSdk> {
    return Promise.resolve({ Daytona: FakeClient } as unknown as DaytonaSdk)
  }
}

function makeRuntime(
  config: DaytonaConfig | Record<string, unknown> = { sandboxId: 'sb-live' },
): FakedDaytonaMachine {
  return new FakedDaytonaMachine('box', config as DaytonaConfig)
}

beforeEach(() => {
  FakeClient.configs = []
  FakeClient.fetched = []
  FakeClient.disposed = 0
  FakeClient.last = null
})

describe('DaytonaMachine', () => {
  it('connect gets the user sandbox by id', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    expect(FakeClient.fetched).toEqual(['sb-live'])
  })

  it('sandboxId is required', () => {
    expect(() => makeRuntime({})).toThrow('sandboxId')
  })

  it('the apiKey reaches the client', async () => {
    const runtime = makeRuntime({ sandboxId: 'sb-live', apiKey: 'k-123' })
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
    const sandbox = FakeClient.last ?? new FakeMachine()
    const [path] = [...sandbox.fs.files.keys()]
    // Unique per invocation, so concurrent stdin lines never collide.
    expect(path).toMatch(/^\/tmp\/\.mirage_stdin_/)
    expect(DEC.decode(sandbox.fs.files.get(path ?? ''))).toBe('a\nb\n')
    const [command, cwd, env] = sandbox.process.calls[0] ?? ['', undefined, undefined]
    expect(command).toBe(
      stdinRedirect(
        encodeOutput(wrapLine(['/bin/sh', '-c', 'wc -l'], { E: '1' }, '/workspace'), true),
        path ?? '',
      ),
    )
    expect(command).toContain(`rm -f ${path ?? ''}`)
    expect([cwd, env]).toEqual([undefined, undefined])
  })

  it('close releases the client, never the machine', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    await runtime.close()
    // The fake exposes no delete at all: close only drops the client.
    expect(FakeClient.disposed).toBe(1)
  })

  it("registers under the config name 'daytona'", () => {
    const machine = buildMachine('box', { provider: 'daytona', sandboxId: 'sb-live' })
    expect(machine).toBeInstanceOf(DaytonaMachine)
    expect(String(machine.machine)).toBe('daytona:box')
  })
})

const RESTRICTIONS: SessionProfile[] = [
  { paths: { hide: ['/data/secret'] } },
  { commands: { deny: [{ paths: ['/data/secret'], reason: 'x' }] } },
  { mounts: new Map([['/data', { mode: MountMode.READ }]]) },
]

it.each(RESTRICTIONS)('refuses every line under a session restriction', async (profile) => {
  const runtime = makeRuntime({ sandboxId: 'sb-77' })
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.EXEC, profiles: { agent: profile }, ...on(runtime, 'workspace') },
  )
  try {
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('tool run')
    expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
      126,
      '',
      'daytona: Permission denied\n',
    ])
    expect(FakeClient.fetched).toEqual([])
    const other = await ws.session('other')
    expect((await other.shell('tool run')).exitCode).toBe(0)
  } finally {
    await ws.close()
  }
})

/**
 * Daytona's exec over a local sh: stdout and stderr combined, decoded as
 * its JSON result carries them (UTF-8, errors replaced).
 */
class ShellProcess {
  executeCommand(command: string): Promise<{ exitCode: number; result: string }> {
    const child = spawn('/bin/sh', ['-c', `exec 2>&1\n${command}`], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (data: Buffer) => chunks.push(data))
    return new Promise((resolve) =>
      child.on('close', (code) => {
        resolve({ exitCode: code ?? -1, result: new TextDecoder().decode(Buffer.concat(chunks)) })
      }),
    )
  }
}

class LocalFs extends FakeFs {
  override async uploadFile(data: Buffer, path: string): Promise<void> {
    await super.uploadFile(data, path)
    await writeFile(path, data)
  }
}

// Program output is bytes: invalid UTF-8, NUL and CRLF reach the host
// unchanged, stderr in the one combined stream, with the program's status,
// with or without piped input.
describe('DaytonaMachine output bytes', () => {
  it.each([{ stdin: null }, { stdin: new Uint8Array([0x69, 0x6e, 0xff, 0x00]) }])(
    'returns arbitrary bytes and the exit code exactly (stdin: $stdin)',
    async ({ stdin }) => {
      const runtime = makeRuntime()
      await runtime.connect()
      Object.assign(FakeClient.last ?? {}, { process: new ShellProcess(), fs: new LocalFs() })
      const line =
        "printf 'a\\377\\000b\\r\\n\\303'; printf 'e\\376\\000\\r\\n' >&2; " +
        (stdin === null ? 'exit 5' : 'cat; exit 5')
      const result = await runtime.execLine(line, stdin, {}, '/')
      expect([result.exitCode, [...result.stdout], result.stderr]).toEqual([
        5,
        [0x61, 0xff, 0x00, 0x62, 0x0d, 0x0a, 0xc3, 0x65, 0xfe, 0x00, 0x0d, 0x0a, ...(stdin ?? [])],
        null,
      ])
    },
  )
})
