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
import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import type { RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import { EXEC_ID, EXEC_PRELUDE } from '@struktoai/mirage-core/runtime/sandbox/constants'
import { materialize, type ByteSource } from '@struktoai/mirage-core/io/types'
import type { OutputFn } from '@struktoai/mirage-core/runtime/types'
import { isLineExecutor, isProcessExecutor } from '@struktoai/mirage-core/runtime/mixin'
import { describe, expect, it, vi } from 'vitest'
import type { AppleContainerConfig } from './config.ts'
import { AppleContainerRuntime } from './runtime.ts'
import { Workspace } from '../../../workspace.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

interface ContainerResult {
  stdout: Uint8Array
  stderr: Uint8Array
  code: number
}

class FakeAppleContainerRuntime extends AppleContainerRuntime {
  states: Record<string, string> = {}
  inspectCode = 0
  inspectStdout: string | null = null
  readonly calls: [string[], Uint8Array | null][] = []

  protected override async container(
    args: string[],
    source: ByteSource | null = null,
    output: OutputFn | null = null,
  ): Promise<ContainerResult> {
    const stdin = source === null ? null : await materialize(source)
    this.calls.push([args.slice(), stdin])
    if (args[0] === 'inspect') {
      if (this.inspectStdout !== null) {
        return Promise.resolve({
          stdout: ENC.encode(this.inspectStdout),
          stderr: new Uint8Array(),
          code: this.inspectCode,
        })
      }
      if (this.inspectCode !== 0) {
        return Promise.resolve({
          stdout: new Uint8Array(),
          stderr: ENC.encode(`Error: container not found: ${args[1] ?? ''}`),
          code: this.inspectCode,
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
  options: RuntimeOptions<AppleContainerConfig> | Record<string, unknown> = {
    config: { container: 'box' },
  },
): FakeAppleContainerRuntime {
  return new FakeAppleContainerRuntime(options)
}

function prelude(cwd: string, ...argv: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('/bin/sh', ['-c', EXEC_PRELUDE, 'sh', cwd, ...argv])
}

describe('AppleContainerRuntime', () => {
  it('the first line inspects its container', async () => {
    const runtime = makeRuntime()
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
    await expect(runtime.execLine('pwd', null, {}, '/')).rejects.toThrow(hint)
    expect(runtime.execTargets()).toEqual([])
  })

  it('an inspect error fails loud', async () => {
    const runtime = makeRuntime()
    runtime.inspectCode = 1
    await expect(runtime.execLine('pwd', null, {}, '/')).rejects.toThrow('container not found: box')
  })

  it.each(['not json', '[]', '{}', '[{"status": null}]'])(
    'unreadable inspect json %s fails loud',
    async (stdout) => {
      const runtime = makeRuntime()
      runtime.inspectStdout = stdout
      await expect(runtime.execLine('pwd', null, {}, '/')).rejects.toThrow('unreadable json')
    },
  )

  it('config needs a container', () => {
    expect(() => makeRuntime({ config: {} })).toThrow('container or containers')
  })

  it.each([
    [{ container: '' }, 'container must be a nonblank id'],
    [{ containers: { agent_a: '' } }, 'nonblank id: agent_a'],
    [{ container: 'shared', containers: { b: ' ', a: 'box' } }, 'nonblank id: b'],
    [{ mountType: 'ssh', containers: { a: 'box' } }, 'cannot be combined with containers'],
  ])('config %j is refused', (config, named) => {
    expect(() => makeRuntime({ config })).toThrow(named)
  })

  it("registers under the config name 'apple_container'", () => {
    const runtime = buildRuntime('apple_container', { config: { container: 'box' } })
    expect(runtime).toBeInstanceOf(AppleContainerRuntime)
    expect(runtime.captures).toEqual(['@external'])
    expect(runtime.reach).toBe('remote')
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

describe.skipIf(process.platform === 'win32')('AppleContainerRuntime against a real spawn', () => {
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
      new AppleContainerRuntime({ config: { container: 'box' } }).execLine(
        'head -1',
        new Uint8Array(4 * 1024 * 1024),
        {},
        '/',
      ),
    )
    expect(result.exitCode).toBe(0)
  })

  it('a missing CLI names how to install it', async () => {
    await withFakeCli(null, async () => {
      const runtime = new AppleContainerRuntime({ config: { container: 'box' } })
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
  const runtime = makeRuntime({ config: { container: 'box', env: { E: 'config' } } })
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
      'exec',
      '-i',
      '-w',
      '/',
      '-e',
      'E=request',
      '-e',
      `${EXEC_ID}=runid`,
      'box',
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
  expect(runtime.inspected()).toEqual(['box'])
  expect([isProcessExecutor(runtime), isLineExecutor(runtime)]).toEqual([true, true])
  expect(runtime.filesystem).toEqual([])
})

it('refuses empty argv and a stopped container before executing', async () => {
  const runtime = makeRuntime()
  runtime.states.box = 'stopped'
  const ctx = { stdin: null, flags: {}, cwd: PathSpec.fromStrPath('/') }
  const opts = { kind: 'process' } as const
  await expect(runtime.execute([], [], ctx, opts)).rejects.toThrow('argv must not be empty')
  expect(runtime.calls).toHaveLength(0)
  await expect(runtime.execute([], ['node'], ctx, opts)).rejects.toThrow('not running')
  expect(runtime.calls).toHaveLength(1)
})

it.each(['agent_a', 'constructor', 'toString', '__proto__'])(
  'runs mapped session %s in its own container',
  async (sessionId) => {
    const runtime = makeRuntime({
      captures: ['uname'],
      config: { container: 'shared', containers: { [sessionId]: 'box-a', agent_b: 'box-b' } },
    })
    const ws = new Workspace(
      { '/d': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: [runtime, 'workspace'] },
    )
    for (const id of [sessionId, 'agent_b', sessionId]) {
      const handle = await ws.session(id)
      expect((await handle.shell('uname')).exitCode).toBe(0)
    }
    expect((await ws.shell('uname')).exitCode).toBe(0)
    expect(runtime.execTargets()).toEqual(['box-a', 'box-b', 'box-a', 'shared'])
    expect(runtime.inspected()).toEqual(['box-a', 'box-b', 'shared'])
  },
)

it.each(['agent_b', 'constructor', 'toString', '__proto__'])(
  'uses the fallback for unmapped session %s',
  async (sessionId) => {
    const runtime = makeRuntime({
      captures: ['uname'],
      config: { container: 'shared', containers: { agent_a: 'box-a' } },
    })
    const ws = new Workspace(
      { '/d': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: [runtime, 'workspace'] },
    )
    const handle = await ws.session(sessionId)
    expect((await handle.shell('uname')).exitCode).toBe(0)
    expect(runtime.execTargets()).toEqual(['shared'])
  },
)

it.each(['agent_b', 'constructor', 'toString', '__proto__'])(
  'fails unmapped session %s loudly',
  async (sessionId) => {
    const runtime = makeRuntime({
      captures: ['uname'],
      config: { containers: { agent_a: 'box-a' } },
    })
    const ws = new Workspace(
      { '/d': new RAMVFS() },
      { mode: MountMode.EXEC, runtimes: [runtime, 'workspace'] },
    )
    const handle = await ws.session(sessionId)
    const result = await handle.shell('uname')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toContain(`no container for session ${sessionId}`)
    expect(runtime.calls).toHaveLength(0)
  },
)
