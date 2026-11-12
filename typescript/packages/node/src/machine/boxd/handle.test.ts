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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { buildMachine } from '@struktoai/mirage-core/machine/registry'
import { wrapLine } from '@struktoai/mirage-core/machine/constants'
import type { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import type { RunResult } from '@struktoai/mirage-core/runtime/types'
import { MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { machineRuntime, on } from '../../../tests/fixtures/machine.ts'
import type { BoxdConfig } from './config.ts'
import { BoxdMachine } from './handle.ts'
import type { BoxdSdk } from './sdk.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

class FakeBoxdError extends Error {}
class FakeNotFoundError extends FakeBoxdError {}
class FakeConflictError extends FakeBoxdError {}
class FakeAPIConnectionError extends FakeBoxdError {}

/** One of a local process's outputs, failing with `fail` once it has data. */
async function* chunks(
  source: AsyncIterable<Buffer>,
  fail: Error | null,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    if (fail !== null) throw fail
    yield new Uint8Array(chunk)
  }
}

/**
 * boxd's exec stream over a local `/bin/sh`: stdin as written, stdout and
 * stderr separately, byte for byte, and `close` ends the command's process
 * group.
 */
class LocalStream {
  readonly child: ChildProcessWithoutNullStreams
  readonly stdout: AsyncIterable<Uint8Array>
  readonly stderr: AsyncIterable<Uint8Array>
  closed = false
  private readonly exited: Promise<number>

  constructor(
    readonly command: string,
    readonly closeStdin: boolean,
    fail: Error | null,
  ) {
    this.child = spawn('/bin/sh', ['-c', command], { detached: true })
    this.child.stdin.on('error', () => undefined)
    if (closeStdin) this.child.stdin.end()
    this.exited = new Promise((resolve) =>
      this.child.on('close', (code, signal) => {
        resolve(code ?? (signal === null ? -1 : 143))
      }),
    )
    this.stdout = chunks(this.child.stdout, fail)
    this.stderr = chunks(this.child.stderr, fail)
  }

  write(data: Uint8Array): void {
    this.child.stdin.write(data)
  }

  end(): void {
    this.child.stdin.end()
  }

  wait(): Promise<number> {
    return this.exited
  }

  close(): void {
    this.closed = true
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        process.kill(-(this.child.pid ?? 0), 'SIGTERM')
      } catch {
        // already gone
      }
    }
  }
}

class FakeClient {
  static configs: object[] = []
  static fetched: string[] = []
  static streams: { machineId: string; stream: LocalStream }[] = []
  static closed = 0
  static status = 'running'
  static getError: Error | null = null
  static streamError: Error | null = null

  readonly machines = {
    get: (machineId: string): Promise<{ id: string; status: string }> => {
      FakeClient.fetched.push(machineId)
      if (FakeClient.getError !== null) return Promise.reject(FakeClient.getError)
      return Promise.resolve({ id: machineId, status: FakeClient.status })
    },
    streamExec: (
      machineId: string,
      params: { command: string; closeStdin?: boolean },
    ): LocalStream => {
      const stream = new LocalStream(
        params.command,
        params.closeStdin === true,
        FakeClient.streamError,
      )
      FakeClient.streams.push({ machineId, stream })
      return stream
    },
  }

  constructor(config: object) {
    FakeClient.configs.push(config)
  }

  close(): Promise<void> {
    FakeClient.closed += 1
    return Promise.resolve()
  }
}

class FakedBoxdMachine extends BoxdMachine {
  protected override loadSdk(): Promise<BoxdSdk> {
    return Promise.resolve({
      Boxd: FakeClient,
      NotFoundError: FakeNotFoundError,
      ConflictError: FakeConflictError,
      APIConnectionError: FakeAPIConnectionError,
    } as unknown as BoxdSdk)
  }
}

function makeMachine(config: Partial<BoxdConfig> = {}): FakedBoxdMachine {
  return new FakedBoxdMachine('box', { machineId: 'm-live', ...config } as BoxdConfig)
}

function lastStream(): LocalStream {
  const last = FakeClient.streams.at(-1)
  if (last === undefined) throw new Error('no stream')
  return last.stream
}

/** The runtime's transport called directly, with streaming sinks. */
function execArgv(
  machine: BoxdMachine,
  argv: string[],
  output: ((data: Uint8Array) => Promise<void>) | null,
  errors: ((data: Uint8Array) => Promise<void>) | null,
  signal?: AbortSignal,
): Promise<RunResult> {
  const direct = machine as unknown as {
    execArgv: (...args: unknown[]) => Promise<RunResult>
  }
  return direct.execArgv(argv, null, {}, '/', output, errors, signal)
}

beforeEach(() => {
  FakeClient.configs = []
  FakeClient.fetched = []
  FakeClient.streams = []
  FakeClient.closed = 0
  FakeClient.status = 'running'
  FakeClient.getError = null
  FakeClient.streamError = null
})

describe('BoxdMachine', () => {
  it('connect gets the user machine by id', async () => {
    const machine = makeMachine()
    await machine.connect()
    expect(FakeClient.fetched).toEqual(['m-live'])
    expect(machine.instance).toBe('m-live')
  })

  it('machineId is required', () => {
    expect(() => new BoxdMachine('box', {} as BoxdConfig)).toThrow('machineId')
  })

  it('the apiKey and region reach the client', async () => {
    await makeMachine({ apiKey: 'k-123', region: 'nyc' }).connect()
    expect(FakeClient.configs).toEqual([{ apiKey: 'k-123', region: 'nyc' }])
  })

  it('leaves an unset apiKey and region to the SDK', async () => {
    await makeMachine().connect()
    expect(FakeClient.configs).toEqual([{}])
  })

  it('a missing machine fails with what to do', async () => {
    FakeClient.getError = new FakeNotFoundError('VM not found')
    await expect(makeMachine().connect()).rejects.toThrow('machine m-live is not running: ')
  })

  it('a stopped machine fails with what to do', async () => {
    FakeClient.status = 'stopped'
    await expect(makeMachine().connect()).rejects.toThrow('boxd machine start')
  })

  it('a destroyed machine fails with what to do', async () => {
    FakeClient.status = 'destroyed'
    await expect(makeMachine().connect()).rejects.toThrow('deleted, never existed')
  })

  it.each(['suspended', 'hibernated'])(
    'leaves a %s machine to wake on the line',
    async (status) => {
      FakeClient.status = status
      await makeMachine().connect()
    },
  )

  it('runs a line as one streamed exec of the wrapped argv', async () => {
    const machine = makeMachine()
    await machine.connect()
    const result = await machine.execLine('echo hi', null, { E: '1' }, '/tmp')
    expect([
      result.exitCode,
      DEC.decode(result.stdout),
      DEC.decode(result.stderr ?? new Uint8Array()),
    ]).toEqual([0, 'hi\n', ''])
    const [only] = FakeClient.streams
    expect(only?.machineId).toBe('m-live')
    expect(only?.stream.command).toBe(wrapLine(['/bin/sh', '-c', 'echo hi'], { E: '1' }, '/tmp'))
    expect(only?.stream.closeStdin).toBe(true)
  })

  it.each([{ stdin: null }, { stdin: new Uint8Array([0x69, 0x6e, 0xff, 0x00]) }])(
    'returns arbitrary bytes and the exit code exactly (stdin: $stdin)',
    async ({ stdin }) => {
      const machine = makeMachine()
      await machine.connect()
      const line =
        "printf 'a\\377\\000b\\r\\n'; printf 'e\\376\\000' >&2; " +
        (stdin === null ? 'exit 5' : 'cat; exit 5')
      const result = await machine.execLine(line, stdin, {}, '/')
      expect([result.exitCode, [...result.stdout], [...(result.stderr ?? [])]]).toEqual([
        5,
        [0x61, 0xff, 0x00, 0x62, 0x0d, 0x0a, ...(stdin ?? [])],
        [0x65, 0xfe, 0x00],
      ])
      expect(lastStream().closeStdin).toBe(stdin === null)
    },
  )

  it('ends the line when the program stops reading', async () => {
    const machine = makeMachine()
    await machine.connect()
    const result = await machine.execLine('head -c 3', ENC.encode('abcdef'.repeat(100000)), {}, '/')
    expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'abc'])
  })

  it('the exit ends a line whose input never ends', async () => {
    const machine = makeMachine()
    await machine.connect()
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        yield ENC.encode('abcdef'.repeat(1000))
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    const result = await machine.execLine('head -c 3', endless(), {}, '/')
    expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'abc'])
  })

  it('the exit ends a line whose input stays open', async () => {
    const machine = makeMachine()
    await machine.connect()
    async function* idle(): AsyncGenerator<Uint8Array> {
      yield ENC.encode('one\ntwo\n')
      await new Promise(() => undefined)
    }
    const result = await machine.execLine('head -n 1', idle(), {}, '/')
    expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'one\n'])
  })

  it('an input that fails as it is read ends the line', async () => {
    const machine = makeMachine()
    await machine.connect()
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield ENC.encode('first\n')
      await Promise.resolve()
      throw new Error('source went away')
    }
    await expect(machine.execLine('cat; sleep 30', failing(), {}, '/')).rejects.toThrow(
      'source went away',
    )
    const stream = lastStream()
    expect(stream.closed).toBe(true)
    await stream.wait()
  })

  it('streams output to the caller as it arrives', async () => {
    const machine = makeMachine()
    await machine.connect()
    const out: string[] = []
    const err: string[] = []
    const result = await execArgv(
      machine,
      ['/bin/sh', '-c', 'echo out; echo err >&2'],
      (data) => {
        out.push(DEC.decode(data))
        return Promise.resolve()
      },
      (data) => {
        err.push(DEC.decode(data))
        return Promise.resolve()
      },
    )
    expect([
      result.stdout.byteLength,
      result.stderr?.byteLength,
      out.join(''),
      err.join(''),
    ]).toEqual([0, 0, 'out\n', 'err\n'])
  })

  it('an aborted line ends its stream', async () => {
    const machine = makeMachine()
    await machine.connect()
    const abort = new AbortController()
    const line = execArgv(machine, ['/bin/sh', '-c', 'sleep 30'], null, null, abort.signal)
    while (FakeClient.streams.length === 0) await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await expect(line).rejects.toThrow('aborted')
    const stream = lastStream()
    expect(stream.closed).toBe(true)
    await stream.wait()
  })

  it('a dropped connection loses the line, and the next line connects again', async () => {
    FakeClient.streamError = new FakeAPIConnectionError('connection reset')
    const machine = makeMachine()
    const ctx = { stdin: null, flags: { c: 'echo hi' }, env: {}, cwd: PathSpec.fromStrPath('/') }
    const result = await machineRuntime(machine).runLine(undefined, [], [], ctx)
    expect([result.exitCode, DEC.decode(result.stderr ?? new Uint8Array())]).toEqual([
      129,
      'boxd: connection reset\nmirage: boxd:box: connection lost\n',
    ])
    FakeClient.streamError = null
    const again = await machineRuntime(machine).runLine(undefined, [], [], ctx)
    expect(again.exitCode).toBe(0)
    expect(FakeClient.fetched).toEqual(['m-live', 'm-live'])
  })

  it('a refused exec loses the line, and the next line connects again', async () => {
    const machine = makeMachine()
    const ctx = { stdin: null, flags: { c: 'echo hi' }, env: {}, cwd: PathSpec.fromStrPath('/') }
    FakeClient.streamError = new FakeConflictError('machine is not running')
    const result = await machineRuntime(machine).runLine(undefined, [], [], ctx)
    expect([result.exitCode, DEC.decode(result.stderr ?? new Uint8Array())]).toEqual([
      129,
      'boxd: machine is not running\nmirage: boxd:box: connection lost\n',
    ])
    FakeClient.streamError = null
    FakeClient.status = 'stopped'
    await expect(machineRuntime(machine).runLine(undefined, [], [], ctx)).rejects.toThrow(
      'boxd machine start',
    )
    expect(FakeClient.fetched).toEqual(['m-live', 'm-live'])
  })

  it('a machine deleted under a line says what to do', async () => {
    const machine = makeMachine()
    await machine.connect()
    FakeClient.streamError = new FakeNotFoundError('VM not found')
    await expect(machine.execLine('echo hi', null, {}, '/')).rejects.toThrow(
      'machine m-live is not',
    )
  })

  it('refuses a mountType', async () => {
    const machine = makeMachine({ mountType: 'ssh' })
    const ctx = { stdin: null, flags: { c: 'echo hi' }, env: {}, cwd: PathSpec.fromStrPath('/') }
    await expect(machineRuntime(machine).runLine(undefined, [], [], ctx)).rejects.toThrow(
      'boxd: mountType needs a pipe transport',
    )
    expect(FakeClient.streams).toEqual([])
  })

  it('close releases the client, never the machine', async () => {
    const machine = makeMachine()
    await machine.connect()
    await machine.close()
    // The fake exposes no delete or stop: close only drops the client.
    expect(FakeClient.closed).toBe(1)
  })

  it("registers under the config name 'boxd'", () => {
    const machine = buildMachine('box', { provider: 'boxd', machineId: 'm-1' })
    expect(machine).toBeInstanceOf(BoxdMachine)
    expect(String(machine.machine)).toBe('boxd:box')
  })
})

const RESTRICTIONS: SessionProfile[] = [
  { paths: { hide: ['/data/secret'] } },
  { commands: { deny: [{ paths: ['/data/secret'], reason: 'x' }] } },
  { mounts: new Map([['/data', { mode: MountMode.READ }]]) },
]

it.each(RESTRICTIONS)('refuses every line under a session restriction', async (profile) => {
  const machine = makeMachine()
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.EXEC, profiles: { agent: profile }, ...on(machine, 'workspace') },
  )
  try {
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('tool run')
    expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
      126,
      '',
      'boxd: Permission denied\n',
    ])
    expect(FakeClient.fetched).toEqual([])
    const other = await ws.session('other')
    // The line reaches the machine, whose shell has no `tool`.
    expect((await other.shell('tool run')).exitCode).toBe(127)
    expect(FakeClient.fetched).toEqual(['m-live'])
  } finally {
    await ws.close()
  }
})
