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

import { buildRuntime } from '@struktoai/mirage-core/runtime/table'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../../../workspace.ts'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Limit, MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { E2BRuntime } from '@struktoai/mirage-core/runtime/sandbox/e2b/runtime'
import { ProcessTable } from '@struktoai/mirage-core/process/table'
import { runWithExecution } from '@struktoai/mirage-core/context/session_context'
import type { E2bSdk } from '@struktoai/mirage-core/runtime/sandbox/e2b/sdk'
import { PTY_MARK, PTY_RAW } from '@struktoai/mirage-core/runtime/sandbox/e2b/constants'
import type { Context } from '@struktoai/mirage-core/commands/config'
import type { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import type { RunResult, SandboxPipe } from '@struktoai/mirage-core/runtime/types'
import { EXEC_ID, wrapLine } from '@struktoai/mirage-core/runtime/sandbox/constants'

const DEC = new TextDecoder()

function runLine(
  rt: E2BRuntime,
  c: string,
  stdin: Uint8Array | null,
  cwd = '/',
  more: Partial<Context> = {},
) {
  const ctx = { stdin, flags: { c }, env: {}, cwd: PathSpec.fromStrPath(cwd), ...more }
  return rt.runLine(undefined, [], [], ctx)
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

/** The line `wrapLine` dressed, or the one word of its argv, unquoted. */
function lineOf(command: string): string {
  const at = command.lastIndexOf("'-c' ")
  const quoted =
    at < 0 ? command.slice(command.lastIndexOf(" '") + 1) : command.slice(at + "'-c' ".length)
  return quoted.slice(1, -1).replaceAll(`'\\''`, "'")
}

class FakeHandle {
  input: Uint8Array = new Uint8Array()
  disconnected = false
  killed = false
  inputError: Error | null = null
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
    if (this.command === 'exit 3') {
      if (!this.eof) await Promise.race([this.sent.promise, this.closed.promise])
      await new Promise((resolve) => setTimeout(resolve, 0))
      throw new FakeExitError(3, 'partial', 'boom-err')
    }
    const hex = (): string => Buffer.from(this.input).toString('hex')
    if (this.command === 'head') {
      await this.received.promise
      return { stdout: hex(), stderr: '', exitCode: 0 }
    }
    if (!this.eof) await this.closed.promise
    return { stdout: hex(), stderr: 'warn', exitCode: 0 }
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
  run(command: string, opts: { background: boolean; stdin: boolean; timeoutMs?: number }) {
    expect([opts.background, opts.timeoutMs]).toEqual([true, 0])
    this.calls.push([command, opts.stdin])
    const handle = new FakeHandle(lineOf(command), !opts.stdin)
    handle.inputError = this.inputError
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
    if (this.refuse) return Promise.reject(new Error('the sandbox went away'))
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

class FakeSandbox {
  static connected: [string, Record<string, unknown>][] = []
  static last: FakeSandbox
  readonly commands = new FakeCommands()
  readonly pty = new FakePty()
  static async connect(sandboxId: string, params: Record<string, unknown>): Promise<FakeSandbox> {
    FakeSandbox.connected.push([sandboxId, params])
    await Promise.resolve()
    FakeSandbox.last = new FakeSandbox()
    return FakeSandbox.last
  }
}

class FakedE2BRuntime extends E2BRuntime {
  protected override loadSdk(): Promise<E2bSdk> {
    return Promise.resolve({
      Sandbox: FakeSandbox,
      CommandExitError: FakeExitError,
      NotFoundError: FakeNotFoundError,
      SandboxError: FakeSandboxError,
    } as unknown as E2bSdk)
  }
}

function makeRuntime() {
  return new FakedE2BRuntime({ config: { sandboxId: 'sb-live' } })
}

beforeEach(() => {
  FakeSandbox.connected = []
  FakeSandbox.last = new FakeSandbox()
  vi.restoreAllMocks()
})

describe('E2BRuntime', () => {
  it('connects by sandbox id with api key', async () => {
    const runtime = new FakedE2BRuntime({ config: { sandboxId: 'sb-live', apiKey: 'k-123' } })
    await runtime.connect()
    expect(FakeSandbox.connected).toEqual([['sb-live', { apiKey: 'k-123' }]])
  })
  it('takes a mountType of ssh, fuse or both', () => {
    expect(
      () => new FakedE2BRuntime({ config: { sandboxId: 'sb', mountType: 'nfs' as never } }),
    ).toThrow('sandbox mountType must be one of ssh, fuse, both, not "nfs"')
    expect(
      () => new FakedE2BRuntime({ config: { sandboxId: 'sb', mountType: 'both' } }),
    ).not.toThrow()
  })
  it("opens a pipe as a raw pty past the shell's own output", async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    const pty = FakeSandbox.last.pty
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
    const pty = FakeSandbox.last.pty
    const pipe = await runtime.openPipe('exec sshfs x y')
    const chunks = pipe.reader.getReader()
    await chunks.read()
    pty.refuse = true
    pipe.writer.write(new Uint8Array([1]))
    await expect(chunks.read()).rejects.toThrow('the sandbox went away')
    expect(pty.ended).toBe(true)
  })
  it('kills a pty whose command cannot be sent', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    const pty = FakeSandbox.last.pty
    pty.refuse = true
    await expect(runtime.openPipe('exec sshfs x y')).rejects.toThrow('the sandbox went away')
    expect(pty.ended).toBe(true)
  })
  it('requires a sandbox id', () => {
    expect(() => new FakedE2BRuntime({ config: {} as never })).toThrow('sandboxId')
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
    expect(FakeSandbox.last.commands.calls).toEqual([
      [
        wrapLine(['/bin/sh', '-c', 'wc -l | cat'], { E: '1', [EXEC_ID]: 'runid' }, '/workspace'),
        data !== null,
      ],
    ])
    expect(FakeSandbox.last.commands.handles[0]).toMatchObject({
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
  ])('preserves a nonzero exit when stdin races exit: %s', async (inputError) => {
    const runtime = makeRuntime()
    await runtime.connect()
    FakeSandbox.last.commands.inputError = inputError
    const result = await runtime.execLine(
      'exit 3',
      new TextEncoder().encode('input'),
      {},
      '/workspace',
    )
    expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
      3,
      'partial',
      'boom-err',
    ])
    expect(FakeSandbox.last.commands.handles[0]).toMatchObject({
      disconnected: true,
      killed: false,
    })
  })
  it('connects once and keeps parallel input separate', async () => {
    const runtime = makeRuntime()
    const payloads = Array.from({ length: 6 }, (_, i) => new Uint8Array(100).fill(i))
    const results = await Promise.all(
      payloads.map((data) => runLine(runtime, 'cat', data, '/workspace')),
    )
    expect(FakeSandbox.connected).toHaveLength(1)
    expect(results.map((r) => DEC.decode(r.stdout))).toEqual(
      payloads.map((data) => Buffer.from(data).toString('hex')),
    )
    expect(FakeSandbox.last.commands.handles.every((h) => h.disconnected)).toBe(true)
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
    expect(FakeSandbox.last.commands.handles[0]).toMatchObject({
      killed: false,
      disconnected: true,
    })
  })
  it.each([
    new Error('stdin transport failed'),
    new FakeSandboxError('13: [internal] stdin transport failed'),
  ])('kills its command and disconnects when sending stdin fails: %s', async (inputError) => {
    const runtime = makeRuntime()
    await runtime.connect()
    FakeSandbox.last.commands.inputError = inputError
    await expect(runtime.execLine('cat', new Uint8Array([1]), {}, '/workspace')).rejects.toThrow(
      'stdin transport failed',
    )
    expect(FakeSandbox.last.commands.handles[0]).toMatchObject({ killed: true, disconnected: true })
  })
  it('registers under e2b', () => {
    const runtime = buildRuntime('e2b', { config: { sandboxId: 'sb-live' } })
    expect(runtime).toBeInstanceOf(E2BRuntime)
    expect(runtime.captures).toEqual(['@external'])
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
      expect(() => new E2BRuntime({ config: { sandboxId: sandboxId as string } })).toThrow(
        'nonblank sandboxId',
      )
      expect(FakeSandbox.connected).toEqual([])
    },
  )

  it('does not connect for an already aborted call', async () => {
    const abort = new AbortController()
    abort.abort()
    const aborted = runLine(makeRuntime(), 'cat', null, '/', { signal: abort.signal })
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeSandbox.connected).toEqual([])
  })

  it('cancels one connection waiter without cancelling another', async () => {
    const connection = deferred<FakeSandbox>()
    const connect = vi.spyOn(FakeSandbox, 'connect').mockReturnValue(connection.promise)
    const runtime = makeRuntime()
    const abort = new AbortController()
    const cancelled = runLine(runtime, 'sleep', null, '/', { signal: abort.signal })
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    const other = runLine(runtime, 'cat', new Uint8Array([7]))
    abort.abort()
    await rejected
    const sandbox = new FakeSandbox()
    connection.resolve(sandbox)
    expect(DEC.decode((await other).stdout)).toBe('07')
    expect(connect).toHaveBeenCalledTimes(1)
    expect(sandbox.commands.calls).toHaveLength(1)
  })

  // A kill that names a gentler signal leaves a run's tagged command to the
  // reap, which sends it that signal first; an untagged one (mount setup, a
  // direct exec) has no reap behind it and is killed.
  it.each([
    [{ [EXEC_ID]: 'run' }, false],
    [{}, true],
  ])('leaves only a tagged command to the reap on TERM: %j', async (env, killed) => {
    const runtime = makeRuntime()
    await runtime.connect()
    const abort = new AbortController()
    const runner = new ProcessTable(runWithExecution).start({
      sessionId: 's',
      command: 'sleep',
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => {
        abort.abort()
      },
      run: async () => (await runtime.execLine('sleep', null, env, '/', abort.signal)).exitCode,
    })
    await vi.waitFor(() => {
      expect(FakeSandbox.last.commands.handles).toHaveLength(1)
    })
    expect(runner.terminate(15)).toBe(true)
    expect((await runner.join()).exitCode).toBe(143)
    expect(FakeSandbox.last.commands.handles[0]).toMatchObject({ killed, disconnected: true })
  })

  it('kills a handle that arrives after startup was aborted', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    const startup = deferred<FakeHandle>()
    const start = vi.spyOn(FakeSandbox.last.commands, 'run').mockReturnValue(startup.promise)
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
    expect(FakeSandbox.last.commands.handles[0]).toMatchObject({ killed: true, disconnected: true })
    expect(removed).toHaveBeenCalledTimes(added.mock.calls.length)
    input.reject(new Error('late input failure'))
  })

  it('stops only the cancelled command and keeps the sandbox usable', async () => {
    const runtime = makeRuntime()
    const abort = new AbortController()
    const cancelled = runLine(runtime, 'sleep', null, '/', { signal: abort.signal })
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    const other = runLine(runtime, 'cat', new Uint8Array([9]))
    await vi.waitFor(() => {
      expect(FakeSandbox.last.commands.handles).toHaveLength(2)
    })
    abort.abort()
    await rejected
    expect(DEC.decode((await other).stdout)).toBe('09')
    expect(FakeSandbox.last.commands.handles.find((h) => h.command === 'sleep')).toMatchObject({
      killed: true,
      disconnected: true,
    })
    expect(FakeSandbox.last.commands.handles.find((h) => h.command === 'cat')).toMatchObject({
      killed: false,
      disconnected: true,
    })
    expect((await runLine(runtime, 'cat', null)).exitCode).toBe(0)
    expect(FakeSandbox.connected).toHaveLength(1)
  })

  it.each(['caller', 'timeout'])('propagates %s cancellation from a workspace', async (kind) => {
    const runtime = new FakedE2BRuntime({
      captures: ['native-sleep'],
      config: { sandboxId: 'sb-live' },
    })
    const abort = new AbortController()
    const workspace = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: [runtime, 'workspace'],
        ...(kind === 'timeout'
          ? { commandLimits: { line: new Limit({ timeoutSeconds: 0.05 }) } }
          : {}),
      },
    )
    try {
      const run = workspace.shell('native-sleep', { signal: abort.signal })
      if (kind === 'caller') {
        const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() => {
          expect(FakeSandbox.last.commands.handles).toHaveLength(1)
        })
        abort.abort()
        await rejected
      } else {
        const result = await run
        expect(result.exitCode).toBe(124)
        expect(result.stderrText).toContain('line: timed out after 0.05s')
      }
      await vi.waitFor(() => {
        expect(FakeSandbox.last.commands.handles[0]).toMatchObject({
          killed: true,
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
class MountingE2BRuntime extends FakedE2BRuntime {
  readonly table = new Map<string, string>()
  readonly lines: string[] = []

  protected override execArgv(argv: readonly string[]): Promise<RunResult> {
    return this.execLine(argv[0] === '/bin/sh' ? (argv[2] ?? '') : argv.join(' '))
  }

  override execLine(line: string): Promise<RunResult> {
    this.lines.push(line)
    const rows = [...this.table].map(([p, t]) => `src ${p} ${t} rw 0 0\n`).join('')
    const stdout = line === 'cat /proc/mounts' ? rows : ''
    return Promise.resolve({ stdout: new TextEncoder().encode(stdout), stderr: null, exitCode: 0 })
  }

  override openPipe(command: string): Promise<SandboxPipe> {
    this.table.set([...command.matchAll(/'([^']*)'|(\S+)/g)][6]?.[1] ?? '', 'fuse.sshfs')
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

function restricted(runtime: E2BRuntime, profile: SessionProfile): Workspace {
  return new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.EXEC, profiles: { agent: profile }, runtimes: [runtime, 'workspace'] },
  )
}

describe('E2BRuntime under session restrictions', () => {
  it.each(RESTRICTIONS)('refuses a line with no mount type', async (profile) => {
    const runtime = new MountingE2BRuntime({ config: { sandboxId: 'sb-live' } })
    const ws = restricted(runtime, profile)
    try {
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('tool run')
      expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([
        126,
        'e2b: Permission denied\n',
      ])
      expect(FakeSandbox.connected).toEqual([])
      expect((await (await ws.session('other')).shell('tool run')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it.each(RESTRICTIONS)('refuses a line on fuse mounts', async (profile) => {
    const runtime = new MountingE2BRuntime({ config: { sandboxId: 'sb-live', mountType: 'fuse' } })
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
      const runtime = new MountingE2BRuntime({ config: { sandboxId: 'sb-live', mountType: 'ssh' } })
      const ws = restricted(runtime, profile)
      try {
        const agent = await ws.session('agent', { profile: 'agent' })
        const result = await agent.shell('tool run')
        expect(result.exitCode).toBe(0)
        expect(Object.fromEntries(runtime.table)).toEqual({ '/data': 'fuse.sshfs' })
        expect(runtime.lines).toContain('tool run')
      } finally {
        await ws.close()
      }
    },
  )
})
