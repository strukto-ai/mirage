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

import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import { wrapLine } from './constants.ts'
import { MountMode, PathSpec } from '@struktoai/mirage-core/types'
import type { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import { SSHVFS } from '../../../vfs/ssh/ssh.ts'
import { Workspace } from '../../../workspace.ts'
import { describe, expect, it, vi } from 'vitest'
import { SSHRuntime } from './runtime.ts'
import type { Ssh2Sdk } from './sdk.ts'

vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => '/private/tmp/mirage-ssh-test-no-default-keys',
}))

const DEC = new TextDecoder()
const ENC = new TextEncoder()

interface SshResult {
  stdout: Uint8Array
  stderr: Uint8Array
  code: number
}

class FakeSSHRuntime extends SSHRuntime {
  readonly calls: [string, Uint8Array | null][] = []

  override connect(): Promise<void> {
    return Promise.resolve()
  }

  protected override ssh(command: string, stdin: Uint8Array | null): Promise<SshResult> {
    this.calls.push([command, stdin])
    return Promise.resolve({
      stdout: ENC.encode(`out:${command}`),
      stderr: ENC.encode('warn'),
      code: 0,
    })
  }
}

const made: FakeClient[] = []

class FakeClient {
  opts: Record<string, unknown> | null = null
  ended = false
  noDelay = false
  private readonly handlers = new Map<string, (...args: unknown[]) => void>()

  constructor() {
    made.push(this)
  }

  on(event: string, fn: (...args: unknown[]) => void): this {
    this.handlers.set(event, fn)
    return this
  }

  setNoDelay(on: boolean): this {
    this.noDelay = on
    return this
  }

  connect(opts: Record<string, unknown>): void {
    this.opts = opts
    queueMicrotask(() => {
      this.handlers.get('ready')?.()
    })
  }

  end(): void {
    this.ended = true
    this.handlers.get('close')?.()
  }
}

class SdkFakeRuntime extends SSHRuntime {
  protected override ssh(): Promise<SshResult> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: new Uint8Array(), code: 0 })
  }
  protected override loadSdk(): Promise<Ssh2Sdk> {
    return Promise.resolve({ Client: FakeClient } as unknown as Ssh2Sdk)
  }
}

async function withAgentSock<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.SSH_AUTH_SOCK
  if (value === undefined) delete process.env.SSH_AUTH_SOCK
  else process.env.SSH_AUTH_SOCK = value
  try {
    return await fn()
  } finally {
    if (prior === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = prior
  }
}

describe('SSHRuntime', () => {
  it('host is required', () => {
    expect(() => new SSHRuntime({ config: {} as never })).toThrow('host')
  })

  it('dresses the line with cwd and env and threads stdin', async () => {
    const runtime = new FakeSSHRuntime({ config: { host: 'box' } })
    const result = await runtime.execLine('wc -l', ENC.encode('a\nb\n'), { E: '1' }, '/w')
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe(`out:${wrapLine('wc -l', { E: '1' }, '/w')}`)
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('warn')
    const [, stdin] = runtime.calls[0] ?? ['', null]
    expect(DEC.decode(stdin ?? new Uint8Array())).toBe('a\nb\n')
  })

  it('connect maps the config onto ssh2 connect options', async () => {
    const runtime = new SdkFakeRuntime({
      config: { host: 'box', hostname: '10.0.0.5', port: 2222, username: 'deploy', timeout: 5 },
    })
    await withAgentSock(undefined, () => runtime.connect())
    expect(made[made.length - 1]?.opts).toEqual({
      host: '10.0.0.5',
      port: 2222,
      username: 'deploy',
      readyTimeout: 5000,
      authHandler: [{ type: 'none', username: 'deploy' }],
    })
    expect(made[made.length - 1]?.noDelay).toBe(true)
  })

  it('username defaults to the local user and the agent rides when no key is named', async () => {
    const runtime = new SdkFakeRuntime({ config: { host: 'box' } })
    await withAgentSock('/tmp/agent.sock', () => runtime.connect())
    expect(made[made.length - 1]?.opts).toEqual({
      host: 'box',
      port: 22,
      username: userInfo().username,
      readyTimeout: 30000,
      authHandler: [
        { type: 'none', username: userInfo().username },
        { type: 'agent', username: userInfo().username, agent: '/tmp/agent.sock' },
      ],
    })
  })

  it('connect tries the agent and the named identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirage-ssh-key-'))
    const keyPath = join(dir, 'id_ed25519')
    await writeFile(keyPath, 'fake-key')
    try {
      const runtime = new SdkFakeRuntime({ config: { host: 'box', identityFile: keyPath } })
      await withAgentSock('/tmp/agent.sock', () => runtime.connect())
      expect(made[made.length - 1]?.opts).toEqual({
        host: 'box',
        port: 22,
        username: userInfo().username,
        readyTimeout: 30000,
        authHandler: [
          { type: 'none', username: userInfo().username },
          { type: 'agent', username: userInfo().username, agent: '/tmp/agent.sock' },
          { type: 'publickey', username: userInfo().username, key: Buffer.from('fake-key') },
        ],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("registers under the config name 'ssh'", () => {
    const runtime = buildRuntime('ssh', { config: { host: 'box' } })
    expect(runtime).toBeInstanceOf(SSHRuntime)
    expect(runtime.captures).toEqual(['@external'])
  })
})

// One exec channel whose command runs until something kills it.
class HungChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly signals: string[] = []
  closed = false

  write(): boolean {
    return true
  }

  end(): void {
    this.emit('eof')
  }

  signal(name: string): void {
    this.signals.push(name)
  }

  close(): void {
    this.closed = true
  }
}

class HungRuntime extends SSHRuntime {
  readonly channel = new HungChannel()

  constructor() {
    super({ config: { host: 'box' } })
    const client = {
      exec: (_command: string, done: (err: undefined, stream: HungChannel) => void) => {
        queueMicrotask(() => {
          done(undefined, this.channel)
        })
      },
    }
    Object.assign(this, { client })
  }

  line(command: string, signal: AbortSignal): Promise<unknown> {
    return this.ssh(command, null, signal)
  }
}

describe('SSHRuntime cancellation', () => {
  it('signals the command and closes its channel when the line is aborted', async () => {
    const runtime = new HungRuntime()
    const controller = new AbortController()
    const started = new Promise((resolve) => runtime.channel.once('eof', resolve))
    const running = runtime.line('sleep 30', controller.signal)
    await started
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect([runtime.channel.signals, runtime.channel.closed]).toEqual([['KILL'], true])
  })

  it('closes its channel and stops listening when the channel fails', async () => {
    const runtime = new HungRuntime()
    const controller = new AbortController()
    const started = new Promise((resolve) => runtime.channel.once('eof', resolve))
    const running = runtime.line('true', controller.signal)
    await started
    runtime.channel.emit('error', new Error('connection lost'))
    await expect(running).rejects.toThrow('connection lost')
    controller.abort()
    expect([runtime.channel.signals, runtime.channel.closed]).toEqual([[], true])
  })
})

it('reconnects after the previous client closes', async () => {
  const runtime = new SdkFakeRuntime({ config: { host: 'box' } })
  const ctx = { stdin: null, flags: { c: 'true' }, cwd: PathSpec.fromStrPath('/') }
  await runtime.runLine(undefined, [], [], ctx)
  const first = made.at(-1)
  if (first === undefined) throw new Error('no SSH client')
  await runtime.runLine(undefined, [], [], ctx)
  expect(made.at(-1)).toBe(first)
  first.end()
  await runtime.runLine(undefined, [], [], ctx)
  expect(made.at(-1)).not.toBe(first)
  await runtime.close()
})

const RESTRICTIONS: SessionProfile[] = [
  { paths: { hide: ['/data/secret'] } },
  { commands: { deny: [{ paths: ['/data/secret'], reason: 'x' }] } },
  { mounts: new Map([['/data', { mode: MountMode.READ }]]) },
]

it.each(RESTRICTIONS)(
  'refuses a line with no mount type under a session restriction',
  async (profile) => {
    const runtime = new FakeSSHRuntime({ config: { host: 'box' } })
    const ws = new Workspace(
      { '/data': new SSHVFS({ host: 'box' }) },
      { mode: MountMode.EXEC, profiles: { agent: profile }, runtimes: [runtime, 'workspace'] },
    )
    try {
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('tool run')
      expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
        126,
        '',
        'ssh: Permission denied\n',
      ])
      expect(runtime.calls).toEqual([])
      const other = await ws.session('other')
      expect((await other.shell('tool run')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  },
)
