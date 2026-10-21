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

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountMode, PathSpec } from '@struktoai/mirage-core/types'
import type { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '../../../workspace.ts'
import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import { EXEC_PRELUDE } from '@struktoai/mirage-core/runtime/sandbox/constants'
import type { RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import { materialize, type ByteSource } from '@struktoai/mirage-core/io/types'
import type { OutputFn } from '@struktoai/mirage-core/runtime/types'
import { isLineExecutor, isProcessExecutor } from '@struktoai/mirage-core/runtime/mixin'
import { describe, expect, it } from 'vitest'
import type { SmolvmConfig } from './config.ts'
import { SmolvmRuntime } from './runtime.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

interface SmolvmResult {
  stdout: Uint8Array
  stderr: Uint8Array
  code: number
}

class FakeSmolvmRuntime extends SmolvmRuntime {
  state = 'running'
  statusCode = 0
  statusStdout: string | null = null
  readonly calls: [string[], Uint8Array | null][] = []

  protected override async smolvm(
    args: string[],
    source: ByteSource | null = null,
    output: OutputFn | null = null,
  ): Promise<SmolvmResult> {
    const stdin = source === null ? null : await materialize(source)
    this.calls.push([args.slice(), stdin])
    if (args[1] === 'status') {
      if (this.statusStdout !== null) {
        return Promise.resolve({
          stdout: ENC.encode(this.statusStdout),
          stderr: new Uint8Array(),
          code: this.statusCode,
        })
      }
      if (this.statusCode !== 0) {
        return Promise.resolve({
          stdout: new Uint8Array(),
          stderr: ENC.encode("machine 'vm' not found"),
          code: this.statusCode,
        })
      }
      return Promise.resolve({
        stdout: ENC.encode(JSON.stringify({ name: 'vm', state: this.state })),
        stderr: new Uint8Array(),
        code: 0,
      })
    }
    const script = args[args.length - 1] ?? ''
    const stdout = ENC.encode(`out:${script}`)
    if (output !== null) await output(stdout)
    return {
      stdout: output === null ? stdout : new Uint8Array(),
      stderr: ENC.encode('warn'),
      code: 0,
    }
  }
}

function makeRuntime(
  options: RuntimeOptions<SmolvmConfig> | Record<string, unknown> = {
    config: { machine: 'vm' },
  },
): FakeSmolvmRuntime {
  return new FakeSmolvmRuntime(options)
}

describe('SmolvmRuntime', () => {
  it('connect probes the user machine state', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    expect(runtime.calls[0]?.[0]).toEqual(['machine', 'status', '--name', 'vm', '--json'])
  })

  it.each<
    [string, Partial<Pick<FakeSmolvmRuntime, 'state' | 'statusCode' | 'statusStdout'>>, string]
  >([
    ['a stopped machine', { state: 'stopped' }, 'not running'],
    ['an unreachable machine', { state: 'unreachable' }, 'guest agent is not answering'],
    ['a frozen machine', { state: 'frozen' }, 'frozen fork base'],
    ['a created machine', { state: 'created' }, 'never been started'],
    ['an unknown state', { state: 'quiesced' }, 'state: quiesced'],
    ['a CLI error', { statusCode: 1 }, "machine 'vm' not found"],
    ['unreadable json', { statusStdout: 'not json' }, 'unreadable json'],
  ])('connect names why it refuses %s', async (_name, fake, refusal) => {
    const runtime = Object.assign(makeRuntime(), fake)
    await expect(runtime.connect()).rejects.toThrow(refusal)
  })

  it('machine is required', () => {
    expect(() => makeRuntime({ config: {} })).toThrow('machine')
  })

  it('threads cwd, env, stdin, and real stderr through exec', async () => {
    const runtime = makeRuntime()
    const result = await runtime.execLine('wc -l', ENC.encode('a\nb\n'), { E: '1' }, '/root/ws')
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('out:wc -l')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('warn')
    const [args, stdin] = runtime.calls[runtime.calls.length - 1] ?? [[], null]
    expect(args).toEqual([
      'machine',
      'exec',
      '--name',
      'vm',
      '-i',
      '-w',
      '/',
      '-e',
      'E=1',
      '--',
      '/bin/sh',
      '-c',
      EXEC_PRELUDE,
      'sh',
      '/root/ws',
      '/bin/sh',
      '-c',
      'wc -l',
    ])
    expect(DEC.decode(stdin ?? new Uint8Array())).toBe('a\nb\n')
  })

  it('ends flags so a dashed line is not parsed as one', async () => {
    const runtime = makeRuntime()
    await runtime.execLine('--version', null, {}, '/')
    const args = runtime.calls[runtime.calls.length - 1]?.[0] ?? []
    expect(args.slice(args.indexOf('--') + 1)).toEqual([
      '/bin/sh',
      '-c',
      EXEC_PRELUDE,
      'sh',
      '/',
      '/bin/sh',
      '-c',
      '--version',
    ])
  })

  it("registers under the config name 'smolvm'", () => {
    const runtime = buildRuntime('smolvm', { config: { machine: 'vm' } })
    expect(runtime).toBeInstanceOf(SmolvmRuntime)
    expect(runtime.captures).toEqual(['@external'])
  })
})

// The real spawn path: a guest command that exits without draining its
// stdin EPIPEs the pipe. Without the stdin error guard the stream's
// unhandled 'error' event crashes the whole process (python suppresses
// the matching BrokenPipeError inside communicate()). A fake `smolvm`
// on PATH that ignores stdin reproduces it against the real spawn.
describe.skipIf(process.platform === 'win32')('SmolvmRuntime stdin EPIPE', () => {
  it('a command that ignores a large stdin resolves instead of crashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fake-smolvm-'))
    const fake = join(dir, 'smolvm')
    await writeFile(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = `${dir}:${savedPath ?? ''}`
    try {
      const runtime = new SmolvmRuntime({ config: { machine: 'vm' } })
      const big = new Uint8Array(4 * 1024 * 1024)
      const result = await runtime.execLine('head -1', big, {}, '/')
      expect(result.exitCode).toBe(0)
    } finally {
      process.env.PATH = savedPath
      await rm(dir, { recursive: true, force: true })
    }
  })
})

it('preserves argv through execute and shares the shell connection', async () => {
  const runtime = makeRuntime({ config: { machine: 'vm', env: { E: 'config' } } })
  const argv = ['node', 'a b', '$(echo literal)', '', '--flag'] as const
  const stdin = ENC.encode('input')
  const result = await runtime.execute(
    [],
    argv,
    { stdin, flags: {}, cwd: PathSpec.fromStrPath('/work'), env: { E: 'request' } },
    { kind: 'process' },
  )
  expect(DEC.decode(result.stdout)).toBe('out:--flag')
  expect(runtime.calls.at(-1)).toEqual([
    [
      'machine',
      'exec',
      '--name',
      'vm',
      '-i',
      '-w',
      '/',
      '-e',
      'E=request',
      '--',
      '/bin/sh',
      '-c',
      EXEC_PRELUDE,
      'sh',
      '/work',
      ...argv,
    ],
    stdin,
  ])
  await runtime.execute(
    [],
    [],
    { stdin: null, flags: { c: 'pwd' }, cwd: PathSpec.fromStrPath('/work') },
    { kind: 'line' },
  )
  expect(runtime.calls.filter(([args]) => args[1] === 'status')).toHaveLength(1)
  expect([isProcessExecutor(runtime), isLineExecutor(runtime)]).toEqual([true, true])
  expect(runtime.filesystem).toEqual([])
})

it('refuses empty argv and a stopped VM before executing', async () => {
  const runtime = makeRuntime()
  runtime.state = 'stopped'
  const ctx = { stdin: null, flags: {}, cwd: PathSpec.fromStrPath('/') }
  const opts = { kind: 'process' } as const
  await expect(runtime.execute([], [], ctx, opts)).rejects.toThrow('argv must not be empty')
  expect(runtime.calls).toHaveLength(0)
  await expect(runtime.execute([], ['node'], ctx, opts)).rejects.toThrow('not running')
  expect(runtime.calls).toHaveLength(1)
})

const RESTRICTIONS: SessionProfile[] = [
  { paths: { hide: ['/data/secret'] } },
  { commands: { deny: [{ paths: ['/data/secret'], reason: 'x' }] } },
  { mounts: new Map([['/data', { mode: MountMode.READ }]]) },
]

it.each(RESTRICTIONS)(
  'refuses a line with no mount type under a session restriction',
  async (profile) => {
    const runtime = makeRuntime({ config: { machine: 'vm' } })
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, profiles: { agent: profile }, runtimes: [runtime, 'workspace'] },
    )
    try {
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('tool run')
      expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
        126,
        '',
        'smolvm: Permission denied\n',
      ])
      expect(runtime.calls).toEqual([])
      const other = await ws.session('other')
      expect((await other.shell('tool run')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  },
)
