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

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { buildMachine } from '@struktoai/mirage-core/machine/registry'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { EXEC_PRELUDE, runArgv, runStatusPath } from '@struktoai/mirage-core/machine/constants'
import { materialize, type ByteSource } from '@struktoai/mirage-core/io/types'
import type { OutputFn, RunResult } from '@struktoai/mirage-core/runtime/types'
import { isLineExecutor, isProcessExecutor } from '@struktoai/mirage-core/runtime/mixin'
import { describe, expect, it, vi } from 'vitest'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import type { Route, RouteContext } from '@struktoai/mirage-core/policy/types'
import { MachineRuntime } from '@struktoai/mirage-core/runtime/machine/runtime'
import type { AppleContainerConfig } from './config.ts'
import { AppleContainerMachine } from './handle.ts'
import { Workspace } from '../../workspace.ts'
import { machineRuntime } from '../../../tests/fixtures/machine.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

class FakeAppleContainerMachine extends AppleContainerMachine {
  states: Record<string, string> = {}
  inspectCode = 0
  inspectStdout: string | null = null
  readonly calls: [string[], Uint8Array | null][] = []

  protected override async execProgram(
    args: string[],
    source: ByteSource | null = null,
    output: OutputFn | null = null,
  ): Promise<RunResult> {
    const stdin = source === null ? null : await materialize(source)
    this.calls.push([args.slice(), stdin])
    if (args[0] === 'inspect') {
      if (this.inspectStdout !== null) {
        return Promise.resolve({
          stdout: ENC.encode(this.inspectStdout),
          stderr: new Uint8Array(),
          exitCode: this.inspectCode,
        })
      }
      if (this.inspectCode !== 0) {
        return Promise.resolve({
          stdout: new Uint8Array(),
          stderr: ENC.encode(`Error: container not found: ${args[1] ?? ''}`),
          exitCode: this.inspectCode,
        })
      }
      return Promise.resolve({
        stdout: ENC.encode(
          JSON.stringify([
            {
              id: args[1],
              configuration: {},
              status: { state: this.states[args[1] ?? ''] ?? 'running' },
            },
          ]),
        ),
        stderr: new Uint8Array(),
        exitCode: 0,
      })
    }
    const script = args[args.length - 1] ?? ''
    const stdout = ENC.encode(`out:${script}`)
    if (output !== null) await output(stdout)
    return {
      stdout: output === null ? stdout : new Uint8Array(),
      stderr: ENC.encode('warn'),
      exitCode: 0,
    }
  }

  inspected(): string[] {
    return this.calls.filter(([args]) => args[0] === 'inspect').map(([args]) => args[1] ?? '')
  }

  execTargets(): string[] {
    return this.calls
      .filter(([args]) => args[0] === 'exec')
      .map(([args]) => args[args.indexOf('/bin/sh') - 1] ?? '')
  }
}

function makeRuntime(
  config: AppleContainerConfig | Record<string, unknown> = { container: 'box' },
): FakeAppleContainerMachine {
  return new FakeAppleContainerMachine('box', config as AppleContainerConfig)
}

function prelude(cwd: string, ...argv: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('/bin/sh', ['-c', EXEC_PRELUDE, 'sh', cwd, ...argv])
}

describe('AppleContainerMachine', () => {
  it('connect inspects its container', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    await runtime.execLine('pwd', null, {}, '/')
    expect(runtime.calls[0]?.[0]).toEqual(['inspect', 'box'])
    expect(runtime.execTargets()).toEqual(['box'])
  })

  it.each([
    ['stopped', 'start it with `container start box`'],
    ['stopping', 'shutting down'],
    ['unknown', 'state: unknown'],
  ])('names why state %s cannot take a line', async (state, hint) => {
    const runtime = makeRuntime()
    runtime.states.box = state
    await expect(runtime.connect()).rejects.toThrow(hint)
    expect(runtime.execTargets()).toEqual([])
  })

  it('an inspect error fails loud', async () => {
    const runtime = makeRuntime()
    runtime.inspectCode = 1
    await expect(runtime.connect()).rejects.toThrow('container not found: box')
  })

  it.each(['not json', '[]', '{}', '[{"status": null}]'])(
    'unreadable inspect json %s fails loud',
    async (stdout) => {
      const runtime = makeRuntime()
      runtime.inspectStdout = stdout
      await expect(runtime.connect()).rejects.toThrow('unreadable json')
    },
  )

  it('config needs a container', () => {
    expect(() => makeRuntime({})).toThrow('container')
    expect(() => makeRuntime({ container: ' ' })).toThrow('needs a nonblank container')
    expect(() => makeRuntime({ container: 'box', containers: { a: 'box' } })).toThrow('containers')
  })

  it("registers under the config name 'apple_container'", () => {
    const machine = buildMachine('box', { provider: 'apple_container', container: 'box' })
    expect(machine).toBeInstanceOf(AppleContainerMachine)
    expect(String(machine.id)).toBe('apple_container:box')
  })

  it('runs the line under the prelude with stdin and real stderr', async () => {
    const runtime = makeRuntime()
    const result = await runtime.execLine('wc -l', ENC.encode('a\nb\n'), { E: '1' }, '/root/ws')
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('out:wc -l')
    expect(DEC.decode(result.stderr ?? new Uint8Array())).toBe('warn')
    const [args, stdin] = runtime.calls[runtime.calls.length - 1] ?? [[], null]
    expect(args).toEqual([
      'exec',
      '-i',
      '-w',
      '/',
      '-e',
      'E=1',
      'box',
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
})

describe.skipIf(process.platform === 'win32')('AppleContainerMachine against a real spawn', () => {
  async function withFakeCli<T>(script: string | null, run: () => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'fake-container-'))
    if (script !== null) await writeFile(join(dir, 'container'), script, { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = script === null ? dir : `${dir}:${savedPath ?? ''}`
    try {
      return await run()
    } finally {
      process.env.PATH = savedPath
      await rm(dir, { recursive: true, force: true })
    }
  }

  // A guest command that exits without draining its stdin EPIPEs the
  // pipe; without the stdin error guard the stream's unhandled 'error'
  // event crashes the whole process.
  it('a command that ignores a large stdin resolves instead of crashing', async () => {
    const fake =
      '#!/bin/sh\n' +
      'if [ "$1" = inspect ]; then echo \'[{"status":{"state":"running"}}]\'; fi\n' +
      'exit 0\n'
    const result = await withFakeCli(fake, () =>
      new AppleContainerMachine('box', { container: 'box' }).execLine(
        'head -1',
        new Uint8Array(4 * 1024 * 1024),
        {},
        '/',
      ),
    )
    expect(result.exitCode).toBe(0)
  })

  it('a missing program names how to install it', async () => {
    await withFakeCli(null, async () => {
      const runtime = new AppleContainerMachine('box', { container: 'box' })
      await expect(runtime.execLine('pwd', null, {}, '/')).rejects.toThrow('brew install container')
    })
  })
})

describe.skipIf(process.platform === 'win32')('EXEC_PRELUDE', () => {
  it('enters the cwd and hands over argv unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prelude-'))
    try {
      const done = prelude(
        dir,
        'sh',
        '-c',
        'pwd; printf "[%s]\\n" "$@"',
        'sh',
        'a b',
        '$(echo literal)',
        '',
        '--flag',
      )
      expect(done.status).toBe(0)
      expect(String(done.stdout).split('\n').slice(0, -1)).toEqual([
        dir,
        '[a b]',
        '[$(echo literal)]',
        '[]',
        '[--flag]',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails loud on a missing cwd and creates nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prelude-'))
    try {
      const missing = join(dir, 'unserved')
      const done = prelude(missing, 'pwd')
      expect(done.status).not.toBe(0)
      expect(String(done.stdout)).toBe('')
      expect(String(done.stderr)).toContain(missing)
      expect(existsSync(missing)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the exit code', () => {
    expect(prelude('/', 'sh', '-c', 'exit 7').status).toBe(7)
  })

  it('resolves a relative cwd without CDPATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prelude-'))
    try {
      for (const root of ['start', 'elsewhere']) {
        await mkdir(join(dir, root, 'sub'), { recursive: true })
      }
      const done = spawnSync(
        '/bin/sh',
        ['-c', EXEC_PRELUDE, 'sh', 'sub', 'sh', '-c', 'pwd -P; printf "%s\\n" "$CDPATH"'],
        { cwd: join(dir, 'start'), env: { ...process.env, CDPATH: join(dir, 'elsewhere') } },
      )
      expect(done.status).toBe(0)
      expect(String(done.stdout).split('\n').slice(0, -1)).toEqual([
        realpathSync(join(dir, 'start', 'sub')),
        join(dir, 'elsewhere'),
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

it('preserves argv through execute and shares the shell connection', async () => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('r-u-n-i-d')
  const runtime = makeRuntime({ container: 'box', env: { E: 'config' } })
  const argv = ['node', 'a b', '$(echo literal)', '', '--flag'] as const
  const stdin = ENC.encode('input')
  const result = await machineRuntime(runtime).execute(
    [],
    argv,
    { stdin, flags: {}, cwd: PathSpec.fromStrPath('/work'), env: { E: 'request' } },
    { kind: 'process' },
  )
  expect(DEC.decode(result.stdout)).toBe('out:--flag')
  expect(runtime.calls.at(-1)).toEqual([
    [
      'exec',
      '-i',
      '-w',
      '/',
      '-e',
      'E=request',
      'box',
      '/bin/sh',
      '-c',
      EXEC_PRELUDE,
      'sh',
      '/work',
      ...runArgv('runid', runStatusPath('runid'), [], argv),
    ],
    stdin,
  ])
  await machineRuntime(runtime).execute(
    [],
    [],
    { stdin: null, flags: { c: 'pwd' }, cwd: PathSpec.fromStrPath('/work') },
    { kind: 'line' },
  )
  expect(runtime.inspected()).toEqual(['box'])
  expect([
    isProcessExecutor(machineRuntime(runtime)),
    isLineExecutor(machineRuntime(runtime)),
  ]).toEqual([true, true])
  expect(machineRuntime(runtime).filesystem).toEqual([])
})

it('refuses empty argv and a stopped container before executing', async () => {
  const runtime = makeRuntime()
  runtime.states.box = 'stopped'
  const ctx = { stdin: null, flags: {}, cwd: PathSpec.fromStrPath('/') }
  const opts = { kind: 'process' } as const
  await expect(machineRuntime(runtime).execute([], [], ctx, opts)).rejects.toThrow(
    'argv must not be empty',
  )
  expect(runtime.calls).toHaveLength(0)
  await expect(machineRuntime(runtime).execute([], ['node'], ctx, opts)).rejects.toThrow(
    'not running',
  )
  expect(runtime.calls).toHaveLength(1)
})

class OwnBox implements Policy {
  preExecute(ctx: RouteContext): Route {
    return { kind: 'route', machine: ctx.sessionId }
  }
}

it('gives each session a container of its own through a route', async () => {
  const boxes = {
    agent_a: new FakeAppleContainerMachine('agent_a', { container: 'box-agent_a' }),
    agent_b: new FakeAppleContainerMachine('agent_b', { container: 'box-agent_b' }),
  }
  const ws = new Workspace(
    { '/d': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: boxes,
      runtimes: [new MachineRuntime({ captures: ['uname'] }), 'workspace'],
      policies: [new OwnBox()],
    },
  )
  try {
    for (const id of ['agent_a', 'agent_b', 'agent_a']) {
      const handle = await ws.session(id)
      expect((await handle.shell('uname')).exitCode).toBe(0)
    }
  } finally {
    await ws.close()
  }
  expect(boxes.agent_a.execTargets()).toEqual(['box-agent_a', 'box-agent_a', 'box-agent_a'])
  expect(boxes.agent_b.execTargets()).toEqual(['box-agent_b', 'box-agent_b'])
  expect(boxes.agent_a.inspected()).toEqual(['box-agent_a'])
})
