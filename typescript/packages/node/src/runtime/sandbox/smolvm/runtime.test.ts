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
import { PathSpec } from '@struktoai/mirage-core/types'
import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import type { ProcessExecution, RuntimeOptions } from '@struktoai/mirage-core/runtime/types'
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

  protected override smolvm(
    args: string[],
    stdin: Uint8Array | null = null,
  ): Promise<SmolvmResult> {
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
    return Promise.resolve({
      stdout: ENC.encode(`out:${script}`),
      stderr: ENC.encode('warn'),
      code: 0,
    })
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

  it('connect fails loud on a stopped machine', async () => {
    const runtime = makeRuntime()
    runtime.state = 'stopped'
    await expect(runtime.connect()).rejects.toThrow('not running')
  })

  it.each([
    ['unreachable', 'guest agent is not answering'],
    ['frozen', 'frozen fork base'],
    ['created', 'never been started'],
  ])('connect names why state %s cannot take a line', async (state, hint) => {
    const runtime = makeRuntime()
    runtime.state = state
    await expect(runtime.connect()).rejects.toThrow(hint)
  })

  it('connect reports an unknown state verbatim', async () => {
    const runtime = makeRuntime()
    runtime.state = 'quiesced'
    await expect(runtime.connect()).rejects.toThrow('state: quiesced')
  })

  it('connect fails loud when the CLI errors', async () => {
    const runtime = makeRuntime()
    runtime.statusCode = 1
    await expect(runtime.connect()).rejects.toThrow("machine 'vm' not found")
  })

  it('connect fails loud on unreadable json', async () => {
    const runtime = makeRuntime()
    runtime.statusStdout = 'not json'
    await expect(runtime.connect()).rejects.toThrow('unreadable json')
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
      '/root/ws',
      '-e',
      'E=1',
      '--',
      'sh',
      '-c',
      'wc -l',
    ])
    expect(DEC.decode(stdin ?? new Uint8Array())).toBe('a\nb\n')
  })

  it('ends flags so a dashed line is not parsed as one', async () => {
    const runtime = makeRuntime()
    await runtime.execLine('--version', null, {}, '/')
    const args = runtime.calls[runtime.calls.length - 1]?.[0] ?? []
    expect(args.slice(-4)).toEqual(['--', 'sh', '-c', '--version'])
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
  const result = await runtime.execute({
    kind: 'process',
    argv,
    cwd: PathSpec.fromStrPath('/work'),
    env: { E: 'request' },
    stdin,
  })
  expect(DEC.decode(result.stdout)).toBe('out:--flag')
  expect(runtime.calls.at(-1)).toEqual([
    ['machine', 'exec', '--name', 'vm', '-i', '-w', '/work', '-e', 'E=request', '--', ...argv],
    stdin,
  ])
  await runtime.execute({
    kind: 'shell',
    line: 'pwd',
    cwd: PathSpec.fromStrPath('/work'),
    env: {},
    stdin: null,
  })
  expect(runtime.calls.filter(([args]) => args[1] === 'status')).toHaveLength(1)
  expect(runtime.capabilities).toMatchObject({ process: true, shell: true, filesystem: [] })
})

it('refuses empty argv and a stopped VM before executing', async () => {
  const runtime = makeRuntime()
  runtime.state = 'stopped'
  const request = {
    kind: 'process' as const,
    argv: [] as unknown as ProcessExecution['argv'],
    cwd: PathSpec.fromStrPath('/'),
    env: {},
    stdin: null,
  }
  await expect(runtime.execute(request)).rejects.toThrow('argv must not be empty')
  expect(runtime.calls).toHaveLength(0)
  await expect(runtime.execute({ ...request, argv: ['node'] })).rejects.toThrow('not running')
  expect(runtime.calls).toHaveLength(1)
})
