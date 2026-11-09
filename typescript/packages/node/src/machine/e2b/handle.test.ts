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
import type { Readable } from 'node:stream'
import { buildMachine } from '@struktoai/mirage-core/machine/registry'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Limit, MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { E2BMachine } from '@struktoai/mirage-core/machine/e2b/handle'
import { ProcessTable } from '@struktoai/mirage-core/execution/process/table'
import { runAsProcess } from '@struktoai/mirage-core/context/session_context'
import type { E2bSdk } from '@struktoai/mirage-core/machine/e2b/sdk'
import { PTY_MARK, PTY_RAW } from '@struktoai/mirage-core/machine/e2b/constants'
import type { Context } from '@struktoai/mirage-core/commands/config'
import type { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import type { MachinePipe } from '@struktoai/mirage-core/machine/types'
import type { RunResult } from '@struktoai/mirage-core/runtime/types'
import {
  MOUNT_GUARD,
  PROCESS,
  RUN_WRAPPER,
  encodeOutput,
  isRun,
  runArgv,
  runStatusPath,
  stopLine,
  wrapLine,
} from '@struktoai/mirage-core/machine/constants'
import { captured, machineRuntime, on } from '../../../tests/fixtures/machine.ts'

const DEC = new TextDecoder()

/** `text` as the machine's encoder sends it. */
function b64(text: string): string {
  return `${Buffer.from(text).toString('base64')}\n`
}

function runLine(
  rt: E2BMachine,
  c: string,
  stdin: Uint8Array | null,
  cwd = '/',
  more: Partial<Context> = {},
) {
  const ctx = { stdin, flags: { c }, env: {}, cwd: PathSpec.fromStrPath(cwd), ...more }
  return machineRuntime(rt).runLine(undefined, [], [], ctx)
}

class FakeExitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`exit ${String(exitCode)}`)
  }
}
class FakeSandboxError extends Error {}
class FakeNotFoundError extends FakeSandboxError {}

/** The runtime's transport called directly: a run with no tag but the caller's. */
function execArgv(
  rt: E2BMachine,
  argv: string[],
  stdin: Uint8Array | null,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<RunResult> {
  const direct = rt as unknown as {
    execArgv: (...args: unknown[]) => Promise<RunResult>
  }
  return direct.execArgv(argv, stdin, env, '/', null, null, signal)
}

/** The line `wrapLine` dressed, or the one word of its argv, unquoted. */
function lineOf(command: string): string {
  const at = command.lastIndexOf("'-c' ")
  const quoted =
    at < 0 || command.startsWith(`'${RUN_WRAPPER.slice(0, 5)}`, at + "'-c' ".length)
      ? command.slice(command.lastIndexOf(" '") + 1)
      : command.slice(at + "'-c' ".length)
  return quoted.slice(1, -1).replaceAll(`'\\''`, "'")
}

class FakeHandle {
  input: Uint8Array = new Uint8Array()
  disconnected = false
  killed = false
  inputError: Error | null = null
  onStdout: ((text: string) => unknown) | undefined = undefined
  onStderr: ((text: string) => unknown) | undefined = undefined
  private readonly received = deferred<undefined>()
  private readonly closed = deferred<undefined>()
  private readonly sent = deferred<undefined>()
  constructor(
    readonly command: string,
    public eof: boolean,
  ) {}

  sendStdin(data: Uint8Array): Promise<void> {
    this.sent.resolve(undefined)
    if (this.inputError) return Promise.reject(this.inputError)
    this.input = new Uint8Array([...this.input, ...data])
    this.received.resolve(undefined)
    return Promise.resolve()
  }
  closeStdin(): Promise<void> {
    this.eof = true
    this.closed.resolve(undefined)
    return Promise.resolve()
  }
  async wait(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.command === 'sleep' || this.command === 'native-sleep')
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => undefined)
    if (this.command === 'exit 3' || this.command === 'exit 0') {
      if (!this.eof) await Promise.race([this.sent.promise, this.closed.promise])
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (this.command === 'exit 0')
        return { stdout: b64('partial'), stderr: b64('boom-err'), exitCode: 0 }
      throw new FakeExitError(3, b64('partial'), b64('boom-err'))
    }
    const hex = (): string => b64(Buffer.from(this.input).toString('hex'))
    if (this.command === 'head') {
      await this.received.promise
      return { stdout: hex(), stderr: '', exitCode: 0 }
    }
    if (!this.eof) await this.closed.promise
    await this.onStdout?.(hex())
    await this.onStderr?.(b64('warn'))
    return { stdout: hex(), stderr: b64('warn'), exitCode: 0 }
  }
  kill(): Promise<boolean> {
    this.killed = true
    return Promise.resolve(true)
  }
  disconnect(): Promise<void> {
    this.disconnected = true
    return Promise.resolve()
  }
}

class FakeCommands {
  calls: [string, boolean][] = []
  handles: FakeHandle[] = []
  inputError: Error | null = null
  run(
    command: string,
    opts: {
      background: boolean
      stdin: boolean
      timeoutMs?: number
      onStdout?: (text: string) => unknown
      onStderr?: (text: string) => unknown
    },
  ) {
    expect([opts.background, opts.timeoutMs]).toEqual([true, 0])
    this.calls.push([command, opts.stdin])
    const handle = new FakeHandle(lineOf(command), !opts.stdin)
    handle.inputError = this.inputError
    handle.onStdout = opts.onStdout
    handle.onStderr = opts.onStderr
    this.handles.push(handle)
    return Promise.resolve(handle)
  }
}

/** E2B's pty API: the shell echoes its line, then the command speaks. */
class FakePty {
  readonly sent: Uint8Array[] = []
  created: [number, number, number | undefined] | null = null
  private onData: (data: Uint8Array) => void = () => undefined
  private end: () => void = () => undefined
  ended = false
  refuse = false
  readonly pid = 7

  create(opts: {
    cols: number
    rows: number
    onData: (data: Uint8Array) => void
    timeoutMs?: number
  }) {
    this.created = [opts.rows, opts.cols, opts.timeoutMs]
    this.onData = opts.onData
    const waiting = new Promise<never>((_, reject) => {
      this.end = () => {
        reject(new FakeExitError(-1, '', ''))
      }
    })
    return Promise.resolve({ pid: this.pid, wait: () => waiting })
  }

  sendInput(pid: number, data: Uint8Array): Promise<void> {
    expect(pid).toBe(this.pid)
    if (this.refuse) return Promise.reject(new Error('the machine went away'))
    this.sent.push(data)
    if (this.sent.length === 1) {
      this.onData(
        new Uint8Array([...new TextEncoder().encode('$ stty raw\r\n'), ...PTY_MARK.slice(0, 3)]),
      )
      this.onData(new Uint8Array([...PTY_MARK.slice(3), 0, 115, 102, 116, 112]))
    }
    return Promise.resolve()
  }

  kill(pid: number): Promise<boolean> {
    expect(pid).toBe(this.pid)
    this.ended = true
    this.end()
    return Promise.resolve(true)
  }
}

class FakeMachine {
  static connected: [string, Record<string, unknown>][] = []
  static last: FakeMachine
  readonly commands = new FakeCommands()
  readonly pty = new FakePty()
  static async connect(sandboxId: string, params: Record<string, unknown>): Promise<FakeMachine> {
    FakeMachine.connected.push([sandboxId, params])
    await Promise.resolve()
    FakeMachine.last = new FakeMachine()
    return FakeMachine.last
  }
}

class FakedE2BMachine extends E2BMachine {
  protected override loadSdk(): Promise<E2bSdk> {
    return Promise.resolve({
      Sandbox: FakeMachine,
      CommandExitError: FakeExitError,
      NotFoundError: FakeNotFoundError,
      SandboxError: FakeSandboxError,
    } as unknown as E2bSdk)
  }
}

function makeRuntime() {
  return new FakedE2BMachine('box', { sandboxId: 'sb-live' })
}

beforeEach(() => {
  FakeMachine.connected = []
  FakeMachine.last = new FakeMachine()
  vi.restoreAllMocks()
})

describe('E2BMachine', () => {
  it('connects by sandbox id with api key', async () => {
    const runtime = new FakedE2BMachine('box', { sandboxId: 'sb-live', apiKey: 'k-123' })
    await runtime.connect()
    expect(FakeMachine.connected).toEqual([['sb-live', { apiKey: 'k-123' }]])
  })
  it('takes a mountType of ssh, fuse or both', () => {
    expect(
      () => new FakedE2BMachine('box', { sandboxId: 'sb', mountType: 'nfs' as never }),
    ).toThrow('e2b mountType must be one of ssh, fuse, both, not "nfs"')
    expect(() => new FakedE2BMachine('box', { sandboxId: 'sb', mountType: 'both' })).not.toThrow()
  })
  it("opens a pipe as a raw pty past the shell's own output", async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    const pty = FakeMachine.last.pty
    const pipe = await runtime.openPipe('exec sshfs x y')
    expect(pty.created).toEqual([24, 80, 0])
    expect(pty.sent.map((d) => DEC.decode(d))).toEqual([`${PTY_RAW}exec sshfs x y\n`])
    const chunks = pipe.reader.getReader()
    expect([...((await chunks.read()).value ?? [])]).toEqual([0, 115, 102, 116, 112])
    for (const part of [[97], [0], [99]]) pipe.writer.write(new Uint8Array(part))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pty.sent.slice(1).map((d) => [...d])).toEqual([[97, 0, 99]])
    await pipe.stop()
    expect(pty.ended).toBe(true)
    expect((await chunks.read()).done).toBe(true)
  })
  it('ends the pipe with the error of a reply it cannot send', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    const pty = FakeMachine.last.pty
    const pipe = await runtime.openPipe('exec sshfs x y')
    const chunks = pipe.reader.getReader()
    await chunks.read()
    pty.refuse = true
    pipe.writer.write(new Uint8Array([1]))
    await expect(chunks.read()).rejects.toThrow('the machine went away')
    expect(pty.ended).toBe(true)
  })
  it('kills a pty whose command cannot be sent', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    const pty = FakeMachine.last.pty
    pty.refuse = true
    await expect(runtime.openPipe('exec sshfs x y')).rejects.toThrow('the machine went away')
    expect(pty.ended).toBe(true)
  })
  it('requires a sandbox id', () => {
    expect(() => new FakedE2BMachine('box', {} as never)).toThrow('sandboxId')
  })
  it.each([
    null,
    new Uint8Array(),
    new TextEncoder().encode('a\nb\n'),
    Uint8Array.from({ length: 256 }, (_, i) => i),
  ])('preserves native input, EOF and the command: %s', async (data) => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('r-u-n-i-d')
    const runtime = makeRuntime()
    const result = await runLine(runtime, 'wc -l | cat', data, '/workspace', { env: { E: '1' } })
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe(Buffer.from(data ?? []).toString('hex'))
    expect(DEC.decode(result.stderr)).toBe('warn')
    expect(FakeMachine.last.commands.calls).toEqual([
      [
        encodeOutput(
          wrapLine(
            runArgv('runid', runStatusPath('runid'), [], ['/bin/sh', '-c', 'wc -l | cat']),
            { E: '1' },
            '/workspace',
          ),
        ),
        data !== null,
      ],
    ])
    expect(FakeMachine.last.commands.handles[0]).toMatchObject({
      eof: true,
      disconnected: true,
      killed: false,
    })
  })
  it.each([
    null,
    new FakeNotFoundError('process exited'),
    new FakeSandboxError(
      "13: [internal] error writing to stdin of process '2815': write |1: broken pipe",
    ),
    new FakeSandboxError(
      "13: [internal] error writing to stdin: error writing to stdin of process '2822': write |1: file already closed",
    ),
  ])('preserves the command exit when stdin races exit: %s', async (inputError) => {
    for (const exitCode of [0, 3]) {
      const runtime = makeRuntime()
      await runtime.connect()
      FakeMachine.last.commands.inputError = inputError
      const result = await runtime.execLine(
        `exit ${String(exitCode)}`,
        new TextEncoder().encode('input'),
        {},
        '/workspace',
      )
      expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
        exitCode,
        'partial',
        'boom-err',
      ])
      expect(FakeMachine.last.commands.handles[0]).toMatchObject({
        disconnected: true,
        killed: false,
      })
    }
  })
  it('connects once and keeps parallel input separate', async () => {
    const runtime = makeRuntime()
    const payloads = Array.from({ length: 6 }, (_, i) => new Uint8Array(100).fill(i))
    const results = await Promise.all(
      payloads.map((data) => runLine(runtime, 'cat', data, '/workspace')),
    )
    expect(FakeMachine.connected).toHaveLength(1)
    expect(results.map((r) => DEC.decode(r.stdout))).toEqual(
      payloads.map((data) => Buffer.from(data).toString('hex')),
    )
    expect(FakeMachine.last.commands.handles.every((h) => h.disconnected)).toBe(true)
  })
  it('ends the line when its command exits while the input stays open', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    async function* openInput(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('one\n')
      await new Promise<never>(() => undefined)
    }
    const result = await runtime.execLine('head', openInput(), {}, '/workspace')
    expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([
      0,
      Buffer.from('one\n').toString('hex'),
    ])
    expect(FakeMachine.last.commands.handles[0]).toMatchObject({
      killed: false,
      disconnected: true,
    })
  })
  // An untagged run (the stop's own line) that fails is killed and starts
  // nothing more.
  it.each([
    new Error('stdin transport failed'),
    new FakeSandboxError('13: [internal] stdin transport failed'),
  ])('kills its command and disconnects when sending stdin fails: %s', async (inputError) => {
    const runtime = makeRuntime()
    await runtime.connect()
    FakeMachine.last.commands.inputError = inputError
    await expect(
      execArgv(runtime, ['/bin/sh', '-c', 'cat'], new Uint8Array([1]), {}),
    ).rejects.toThrow('stdin transport failed')
    expect(FakeMachine.last.commands.handles[0]).toMatchObject({ killed: true, disconnected: true })
    expect(FakeMachine.last.commands.calls).toHaveLength(1)
  })
  // A kill reaches only the encoding shell, so a line run with no tag of its
  // caller's gets its own and an aborted one is stopped by it.
  it('stops an aborted line by its own tag', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('l-i-n-e-')
    const runtime = makeRuntime()
    await (runtime as unknown as { ensureConnected(): Promise<void> }).ensureConnected()
    const commands = FakeMachine.last.commands
    const abort = new AbortController()
    const run = runtime.execLine('sleep', null, {}, '/', abort.signal)
    await vi.waitFor(() => {
      expect(commands.handles).toHaveLength(1)
    })
    abort.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(commands.handles[0]).toMatchObject({ killed: true, disconnected: true })
    expect(commands.calls.map(([command]) => lineOf(command))).toEqual([
      'sleep',
      stopLine('line', 15),
    ])
  })
  it('starts no other stop when a stop times out', async () => {
    const runtime = makeRuntime()
    await (runtime as unknown as { ensureConnected(): Promise<void> }).ensureConnected()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort())
    expect(await runtime.stop('t', 15)).toBe(false)
    expect(FakeMachine.last.commands.calls.length).toBeLessThanOrEqual(1)
  })
  // A kill reaches only the shell that encodes the output, so a tagged run
  // that fails for a reason other than a cancel is also stopped by its tag.
  it('stops a tagged run that fails by its tag', async () => {
    const runtime = makeRuntime()
    await (runtime as unknown as { ensureConnected(): Promise<void> }).ensureConnected()
    const commands = FakeMachine.last.commands
    commands.inputError = new Error('stdin transport failed')
    await expect(
      runtime.execLine('cat', new Uint8Array([1]), { [PROCESS]: 'run' }, '/'),
    ).rejects.toThrow('stdin transport failed')
    expect(commands.calls.map(([command]) => lineOf(command))).toEqual(['cat', stopLine('run', 15)])
  })
  it("registers under the config name 'e2b'", () => {
    const machine = buildMachine('box', { provider: 'e2b', sandboxId: 'sb-live' })
    expect(machine).toBeInstanceOf(E2BMachine)
    expect(String(machine.id)).toBe('e2b:box')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('E2B cancellation and validation', () => {
  it.each([null, '', ' \t\n', 0, 1, false, [], {}].map((sandboxId) => ({ sandboxId })))(
    'rejects an invalid sandbox id before connecting: $sandboxId',
    ({ sandboxId }) => {
      expect(() => new E2BMachine('box', { sandboxId: sandboxId as string })).toThrow(
        'nonblank sandboxId',
      )
      expect(FakeMachine.connected).toEqual([])
    },
  )

  it('does not connect for an already aborted call', async () => {
    const abort = new AbortController()
    abort.abort()
    const aborted = runLine(makeRuntime(), 'cat', null, '/', { signal: abort.signal })
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeMachine.connected).toEqual([])
  })

  it('cancels one connection waiter without cancelling another', async () => {
    const connection = deferred<FakeMachine>()
    const connect = vi.spyOn(FakeMachine, 'connect').mockReturnValue(connection.promise)
    const runtime = makeRuntime()
    const abort = new AbortController()
    const cancelled = runLine(runtime, 'sleep', null, '/', { signal: abort.signal })
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    const other = runLine(runtime, 'cat', new Uint8Array([7]))
    abort.abort()
    await rejected
    const sandbox = new FakeMachine()
    connection.resolve(sandbox)
    expect(DEC.decode((await other).stdout)).toBe('07')
    expect(connect).toHaveBeenCalledTimes(1)
    expect(sandbox.commands.calls).toHaveLength(1)
  })

  // A kill that names a gentler signal leaves a run's tagged command to the
  // stop, which sends it that signal first; an untagged one (mount setup, a
  // direct exec) has no stop behind it and is killed. Either way the
  // runtime runs nothing more: an aborted run is the caller's to stop.
  it.each([
    [{ [PROCESS]: 'run' }, false],
    [{}, true],
  ])('leaves only a tagged command to the stop on TERM: %j', async (env, killed) => {
    const runtime = makeRuntime()
    await runtime.connect()
    const abort = new AbortController()
    const runner = new ProcessTable(undefined, undefined, runAsProcess).start({
      sessionId: 's',
      command: 'sleep',
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => {
        abort.abort()
      },
      run: async () =>
        (await execArgv(runtime, ['/bin/sh', '-c', 'sleep'], null, env, abort.signal)).exitCode,
    })
    await vi.waitFor(() => {
      expect(FakeMachine.last.commands.handles).toHaveLength(1)
    })
    expect(runner.terminate(15)).toBe(true)
    expect((await runner.join()).exit).toBe(143)
    expect(FakeMachine.last.commands.handles[0]).toMatchObject({ killed, disconnected: true })
    expect(FakeMachine.last.commands.calls).toHaveLength(1)
  })

  it('kills a handle that arrives after startup was aborted', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    const startup = deferred<FakeHandle>()
    const start = vi.spyOn(FakeMachine.last.commands, 'run').mockReturnValue(startup.promise)
    const abort = new AbortController()
    const cancelled = runtime.execLine('sleep', null, {}, '/', abort.signal)
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce()
    })
    abort.abort()
    const handle = new FakeHandle('sleep', true)
    startup.resolve(handle)
    await rejected
    expect(handle).toMatchObject({ killed: true, disconnected: true })
  })

  it('cancels an in-flight stdin write and removes its abort listener', async () => {
    const input = deferred<undefined>()
    const send = vi.spyOn(FakeHandle.prototype, 'sendStdin').mockReturnValue(input.promise)
    const runtime = makeRuntime()
    const abort = new AbortController()
    const added = vi.spyOn(abort.signal, 'addEventListener')
    const removed = vi.spyOn(abort.signal, 'removeEventListener')
    const cancelled = runLine(runtime, 'cat', new Uint8Array([1]), '/', { signal: abort.signal })
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce()
    })
    abort.abort()
    await rejected
    expect(FakeMachine.last.commands.handles[0]).toMatchObject({ killed: true, disconnected: true })
    expect(removed).toHaveBeenCalledTimes(added.mock.calls.length)
    input.reject(new Error('late input failure'))
  })

  it('stops only the cancelled command and keeps the machine usable', async () => {
    const runtime = makeRuntime()
    const abort = new AbortController()
    const cancelled = runLine(runtime, 'sleep', null, '/', { signal: abort.signal })
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    const other = runLine(runtime, 'cat', new Uint8Array([9]))
    await vi.waitFor(() => {
      expect(FakeMachine.last.commands.handles).toHaveLength(2)
    })
    abort.abort()
    await rejected
    expect(DEC.decode((await other).stdout)).toBe('09')
    expect(FakeMachine.last.commands.handles.find((h) => h.command === 'sleep')).toMatchObject({
      killed: true,
      disconnected: true,
    })
    expect(FakeMachine.last.commands.handles.find((h) => h.command === 'cat')).toMatchObject({
      killed: false,
      disconnected: true,
    })
    expect((await runLine(runtime, 'cat', null)).exitCode).toBe(0)
    expect(FakeMachine.connected).toHaveLength(1)
  })

  it.each(['caller', 'timeout'])('propagates %s cancellation from a workspace', async (kind) => {
    const runtime = captured(new FakedE2BMachine('box', { sandboxId: 'sb-live' }), ['native-sleep'])
    const abort = new AbortController()
    const workspace = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        ...on(runtime, 'workspace'),
        ...(kind === 'timeout'
          ? { commandLimits: { '@line': new Limit({ timeoutSeconds: 0.05 }) } }
          : {}),
      },
    )
    try {
      const run = workspace.shell('native-sleep', { signal: abort.signal })
      if (kind === 'caller') {
        const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() => {
          expect(FakeMachine.last.commands.handles).toHaveLength(1)
        })
        abort.abort()
        await rejected
      } else {
        const result = await run
        expect(result.exitCode).toBe(124)
        expect(result.stderrText).toContain('line: timed out after 0.05s')
      }
      await vi.waitFor(() => {
        expect(FakeMachine.last.commands.handles[0]).toMatchObject({
          killed: kind === 'caller',
          disconnected: true,
        })
      })
    } finally {
      await workspace.close()
    }
  })
})

// A sandbox that answers its mount table, takes sshfs pipes and records the
// lines it runs.
class MountingE2BMachine extends FakedE2BMachine {
  readonly table = new Map<string, [string, string]>()
  readonly lines: string[] = []

  protected override execArgv(argv: readonly string[]): Promise<RunResult> {
    const inner = isRun(argv) ? argv.slice(7) : argv
    const run = inner[2] === MOUNT_GUARD ? inner.slice(inner.indexOf('--', 5) + 1) : inner
    return this.execLine(run[0] === '/bin/sh' ? (run[2] ?? '') : run.join(' '))
  }

  override execLine(line: string): Promise<RunResult> {
    this.lines.push(line)
    const rows = [...this.table].map(([p, [source, t]]) => `${source} ${p} ${t} rw 0 0\n`).join('')
    const stdout = line === 'cat /proc/mounts' ? rows : ''
    return Promise.resolve({ stdout: new TextEncoder().encode(stdout), stderr: null, exitCode: 0 })
  }

  override openPipe(command: string): Promise<MachinePipe> {
    const words = [...command.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '')
    this.table.set(words[6] ?? '', [words[5] ?? '', 'fuse.sshfs'])
    let end: () => void = () => undefined
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        end = () => {
          controller.close()
        }
      },
    })
    return Promise.resolve({
      reader,
      writer: { write: () => undefined, end: () => undefined },
      stop: () => {
        end()
        return Promise.resolve()
      },
    })
  }
}

const RESTRICTIONS: SessionProfile[] = [
  { paths: { hide: ['/data/secret'] } },
  { commands: { deny: [{ paths: ['/data/secret'], reason: 'sealed' }] } },
  { mounts: new Map([['/data', { mode: MountMode.READ }]]) },
]

function restricted(runtime: E2BMachine, profile: SessionProfile): Workspace {
  return new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.EXEC, profiles: { agent: profile }, ...on(runtime, 'workspace') },
  )
}

describe('E2BMachine under session restrictions', () => {
  it.each(RESTRICTIONS)('refuses a line with no mount type', async (profile) => {
    const runtime = new MountingE2BMachine('box', { sandboxId: 'sb-live' })
    const ws = restricted(runtime, profile)
    try {
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('tool run')
      expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([
        126,
        'e2b: Permission denied\n',
      ])
      expect(FakeMachine.connected).toEqual([])
      expect((await (await ws.session('other')).shell('tool run')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it.each(RESTRICTIONS)('refuses a line on fuse mounts', async (profile) => {
    const runtime = new MountingE2BMachine('box', { sandboxId: 'sb-live', mountType: 'fuse' })
    const ws = restricted(runtime, profile)
    try {
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('tool run')
      expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([
        126,
        'e2b: Permission denied\n',
      ])
      expect(runtime.lines).not.toContain('tool run')
    } finally {
      await ws.close()
    }
  })

  it.each(RESTRICTIONS)(
    'serves a restricted session its files over ssh mounts',
    async (profile) => {
      const runtime = new MountingE2BMachine('box', { sandboxId: 'sb-live', mountType: 'ssh' })
      const ws = restricted(runtime, profile)
      try {
        const agent = await ws.session('agent', { profile: 'agent' })
        const result = await agent.shell('tool run')
        expect(result.exitCode).toBe(0)
        expect([...runtime.table].map(([p, [, kind]]) => [p, kind])).toEqual([
          ['/data', 'fuse.sshfs'],
        ])
        expect(runtime.lines).toContain('tool run')
      } finally {
        await ws.close()
      }
    },
  )
})

/**
 * E2B's command handle over a local sh, its output decoded as the SDK
 * decodes it (streaming TextDecoder) and read in small slices.
 */
class ShellHandle {
  private readonly chunks = { out: [] as string[], err: [] as string[] }
  private readonly pumps: Promise<unknown>
  private readonly exited: Promise<number>
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    onStdout?: (text: string) => unknown,
    onStderr?: (text: string) => unknown,
  ) {
    this.exited = new Promise((resolve) =>
      child.on('exit', (code) => {
        resolve(code ?? -1)
      }),
    )
    this.pumps = Promise.all([
      this.pump(child.stdout, onStdout, this.chunks.out),
      this.pump(child.stderr, onStderr, this.chunks.err),
    ])
  }
  private async pump(
    stream: Readable,
    callback: ((text: string) => unknown) | undefined,
    chunks: string[],
  ): Promise<void> {
    const decoder = new TextDecoder()
    for await (const data of stream as AsyncIterable<Buffer>) {
      for (let at = 0; at < data.length; at += 7) {
        const text = decoder.decode(data.subarray(at, at + 7), { stream: true })
        if (text === '') continue
        chunks.push(text)
        await callback?.(text)
      }
    }
    const tail = decoder.decode()
    if (tail !== '') {
      chunks.push(tail)
      await callback?.(tail)
    }
  }
  sendStdin(data: Uint8Array): Promise<void> {
    this.child.stdin.write(data)
    return Promise.resolve()
  }
  closeStdin(): Promise<void> {
    this.child.stdin.end()
    return Promise.resolve()
  }
  async wait(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await this.pumps
    const exitCode = await this.exited
    const [stdout, stderr] = [this.chunks.out.join(''), this.chunks.err.join('')]
    if (exitCode !== 0) throw new FakeExitError(exitCode, stdout, stderr)
    return { stdout, stderr, exitCode }
  }
  kill(): Promise<boolean> {
    return Promise.resolve(this.child.kill('SIGKILL'))
  }
  disconnect(): Promise<void> {
    return Promise.resolve()
  }
}

class ShellCommands {
  run(
    command: string,
    opts: {
      stdin: boolean
      onStdout?: (text: string) => unknown
      onStderr?: (text: string) => unknown
    },
  ): Promise<ShellHandle> {
    const child = spawn('/bin/sh', ['-c', command])
    if (!opts.stdin) child.stdin.end()
    return Promise.resolve(new ShellHandle(child, opts.onStdout, opts.onStderr))
  }
}

class ShellSandbox {
  readonly commands = new ShellCommands()
  static connect(): Promise<ShellSandbox> {
    return Promise.resolve(new ShellSandbox())
  }
}

class ShellE2BMachine extends E2BMachine {
  protected override loadSdk(): Promise<E2bSdk> {
    return Promise.resolve({
      Sandbox: ShellSandbox,
      CommandExitError: FakeExitError,
      NotFoundError: FakeNotFoundError,
      SandboxError: FakeSandboxError,
    } as unknown as E2bSdk)
  }
}

const BYTES_LINE = "printf 'a\\377\\000b\\r\\n\\303'; printf 'e\\376\\000\\r\\n' >&2; exit 5"

describe('E2BMachine output bytes', () => {
  // Program output is bytes: invalid UTF-8, NUL and CRLF reach the host
  // unchanged on stdout and stderr, whole or streamed, with the program's
  // status.
  it.each([false, true])(
    'returns arbitrary bytes and the exit code exactly (streamed: %s)',
    async (streamed) => {
      const runtime = new ShellE2BMachine('box', { sandboxId: 'sb-live' })
      const said = { out: [] as number[], err: [] as number[] }
      const result = await machineRuntime(runtime).runLine(
        undefined,
        [],
        [],
        { stdin: null, flags: { c: BYTES_LINE }, env: {}, cwd: PathSpec.fromStrPath('/') },
        streamed ? (chunk) => Promise.resolve(void said.out.push(...chunk)) : undefined,
        streamed ? (chunk) => Promise.resolve(void said.err.push(...chunk)) : undefined,
      )
      const stdout = streamed ? said.out : [...result.stdout]
      const stderr = streamed ? said.err : [...(result.stderr ?? [])]
      expect([result.exitCode, stdout, stderr]).toEqual([
        5,
        [0x61, 0xff, 0x00, 0x62, 0x0d, 0x0a, 0xc3],
        [0x65, 0xfe, 0x00, 0x0d, 0x0a],
      ])
    },
  )
  // A program's output reaches the host while it still runs: here it
  // waits for input that is only sent once its first line has arrived.
  it('streams output while the program runs', async () => {
    const runtime = new ShellE2BMachine('box', { sandboxId: 'sb-live' })
    let said = ''
    const first = deferred<undefined>()
    async function* reply(): AsyncGenerator<Uint8Array> {
      await first.promise
      yield new TextEncoder().encode('two\n')
    }
    const ctx = {
      stdin: reply(),
      flags: { c: 'echo one; head -n 1' },
      env: {},
      cwd: PathSpec.fromStrPath('/'),
    }
    const result = await machineRuntime(runtime).runLine(undefined, [], [], ctx, (chunk) => {
      said += DEC.decode(chunk)
      if (said.includes('one\n')) first.resolve(undefined)
      return Promise.resolve()
    })
    expect([result.exitCode, said]).toEqual([0, 'one\ntwo\n'])
  }, 10_000)
})

/** A command that streams a line, then a tail with no newline, on stdout and on stderr. */
class TailSandbox {
  readonly commands = {
    async run(
      _command: string,
      opts: {
        onStdout?: (text: string) => Promise<void>
        onStderr?: (text: string) => Promise<void>
      },
    ) {
      await opts.onStdout?.(b64('a').slice(0, 3))
      await opts.onStdout?.(`${b64('a').slice(3)}mirage: tail`)
      await opts.onStderr?.(b64('b').slice(0, 3))
      await opts.onStderr?.(`${b64('b').slice(3)}mirage: etail`)
      return new FakeHandle('x', true)
    },
  }
  static connect(): Promise<TailSandbox> {
    return Promise.resolve(new TailSandbox())
  }
}

class TailE2BMachine extends E2BMachine {
  protected override loadSdk(): Promise<E2bSdk> {
    return Promise.resolve({
      Sandbox: TailSandbox,
      CommandExitError: FakeExitError,
      NotFoundError: FakeNotFoundError,
      SandboxError: FakeSandboxError,
    } as unknown as E2bSdk)
  }
}

// Streamed text decodes a whole line at a time; what is left when the
// stream ends without a newline still comes out, once.
it('passes on a streamed tail without a newline', async () => {
  const runtime = new TailE2BMachine('box', { sandboxId: 'sb-live' })
  const said = { out: [] as string[], err: [] as string[] }
  const ctx = { stdin: null, flags: { c: 'x' }, env: {}, cwd: PathSpec.fromStrPath('/') }
  const collect = (into: string[]) => (chunk: Uint8Array) => {
    into.push(DEC.decode(chunk))
    return Promise.resolve()
  }
  const result = await machineRuntime(runtime).runLine(
    undefined,
    [],
    [],
    ctx,
    collect(said.out),
    collect(said.err),
  )
  expect([result.exitCode, said]).toEqual([
    0,
    { out: ['a', 'mirage: tail\n'], err: ['b', 'mirage: etail\n'] },
  ])
})
