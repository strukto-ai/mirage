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
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { Limit, MountMode } from '@struktoai/mirage-core/types'
import { E2BRuntime, type E2bSdk } from '@struktoai/mirage-core/runtime/sandbox/e2b/runtime'

const DEC = new TextDecoder()

class FakeExitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`exit ${String(exitCode)}`)
  }
}
class FakeNotFoundError extends Error {}

class FakeHandle {
  input: Uint8Array = new Uint8Array()
  disconnected = false
  killed = false
  inputError: Error | null = null
  constructor(
    readonly command: string,
    public eof: boolean,
  ) {}

  sendStdin(data: Uint8Array): Promise<void> {
    if (this.inputError) return Promise.reject(this.inputError)
    this.input = data
    return Promise.resolve()
  }
  closeStdin(): Promise<void> {
    this.eof = true
    return Promise.resolve()
  }
  wait() {
    if (this.command === 'sleep' || this.command === 'native-sleep')
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => undefined)
    if (this.command === 'exit 3')
      return Promise.reject(new FakeExitError(3, 'partial', 'boom-err'))
    expect(this.eof).toBe(true)
    return Promise.resolve({
      stdout: Buffer.from(this.input).toString('hex'),
      stderr: 'warn',
      exitCode: 0,
    })
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
  calls: [string, Record<string, string>, string, boolean][] = []
  handles: FakeHandle[] = []
  inputError: Error | null = null
  run(
    command: string,
    opts: { envs: Record<string, string>; cwd: string; background: boolean; stdin: boolean },
  ) {
    expect(opts.background).toBe(true)
    this.calls.push([command, opts.envs, opts.cwd, opts.stdin])
    const handle = new FakeHandle(command, !opts.stdin)
    handle.inputError = this.inputError
    this.handles.push(handle)
    return Promise.resolve(handle)
  }
}

class FakeSandbox {
  static connected: [string, Record<string, unknown>][] = []
  static last: FakeSandbox
  readonly commands = new FakeCommands()
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
    } as unknown as E2bSdk)
  }
}

function makeRuntime() {
  return new FakedE2BRuntime({ config: { sandboxId: 'sb-live' } })
}

beforeEach(() => {
  FakeSandbox.connected = []
  vi.restoreAllMocks()
})

describe('E2BRuntime', () => {
  it('connects by sandbox id with api key', async () => {
    const runtime = new FakedE2BRuntime({ config: { sandboxId: 'sb-live', apiKey: 'k-123' } })
    await runtime.connect()
    expect(FakeSandbox.connected).toEqual([['sb-live', { apiKey: 'k-123' }]])
  })
  it('requires a sandbox id', () => {
    expect(() => new FakedE2BRuntime({ config: {} })).toThrow('sandboxId')
  })
  it.each([
    null,
    new Uint8Array(),
    new TextEncoder().encode('a\nb\n'),
    Uint8Array.from({ length: 256 }, (_, i) => i),
  ])('preserves native input, EOF and the command: %s', async (data) => {
    const runtime = makeRuntime()
    const result = await runtime.runLine('wc -l | cat', data, { E: '1' }, '/workspace')
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe(Buffer.from(data ?? []).toString('hex'))
    expect(DEC.decode(result.stderr)).toBe('warn')
    expect(FakeSandbox.last.commands.calls).toEqual([
      ['wc -l | cat', { E: '1' }, '/workspace', data !== null],
    ])
    expect(FakeSandbox.last.commands.handles[0]).toMatchObject({
      eof: true,
      disconnected: true,
      killed: false,
    })
  })
  it.each([false, true])(
    'preserves a nonzero exit when stdin races exit: %s',
    async (earlyExit) => {
      const runtime = makeRuntime()
      await runtime.connect()
      if (earlyExit) FakeSandbox.last.commands.inputError = new FakeNotFoundError('process exited')
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
    },
  )
  it('connects once and keeps parallel input separate', async () => {
    const runtime = makeRuntime()
    const payloads = Array.from({ length: 6 }, (_, i) => new Uint8Array(100).fill(i))
    const results = await Promise.all(
      payloads.map((data) => runtime.runLine('cat', data, {}, '/workspace')),
    )
    expect(FakeSandbox.connected).toHaveLength(1)
    expect(results.map((r) => DEC.decode(r.stdout))).toEqual(
      payloads.map((data) => Buffer.from(data).toString('hex')),
    )
    expect(FakeSandbox.last.commands.handles.every((h) => h.disconnected)).toBe(true)
  })
  it('kills its command and disconnects when sending stdin fails', async () => {
    const runtime = makeRuntime()
    await runtime.connect()
    FakeSandbox.last.commands.inputError = new Error('stdin transport failed')
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
      expect(() => new E2BRuntime({ config: { sandboxId } })).toThrow('nonblank sandboxId')
      expect(FakeSandbox.connected).toEqual([])
    },
  )

  it('does not connect for an already aborted call', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(makeRuntime().runLine('cat', null, {}, '/', abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(FakeSandbox.connected).toEqual([])
  })

  it('cancels one connection waiter without cancelling another', async () => {
    const connection = deferred<FakeSandbox>()
    const connect = vi.spyOn(FakeSandbox, 'connect').mockReturnValue(connection.promise)
    const runtime = makeRuntime()
    const abort = new AbortController()
    const cancelled = runtime.runLine('sleep', null, {}, '/', abort.signal)
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    const other = runtime.runLine('cat', new Uint8Array([7]), {}, '/')
    abort.abort()
    await rejected
    const sandbox = new FakeSandbox()
    connection.resolve(sandbox)
    expect(DEC.decode((await other).stdout)).toBe('07')
    expect(connect).toHaveBeenCalledTimes(1)
    expect(sandbox.commands.calls).toHaveLength(1)
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
    const cancelled = runtime.runLine('cat', new Uint8Array([1]), {}, '/', abort.signal)
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
    const cancelled = runtime.runLine('sleep', null, {}, '/', abort.signal)
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    const other = runtime.runLine('cat', new Uint8Array([9]), {}, '/')
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
    expect((await runtime.runLine('cat', null, {}, '/')).exitCode).toBe(0)
    expect(FakeSandbox.connected).toHaveLength(1)
  })

  it.each(['caller', 'timeout'])('propagates %s cancellation from a workspace', async (kind) => {
    const runtime = new FakedE2BRuntime({
      captures: ['native-sleep'],
      config: { sandboxId: 'sb-live' },
    })
    const abort = new AbortController()
    const workspace = new Workspace(
      { '/data': new RAMResource() },
      {
        mode: MountMode.EXEC,
        runtimes: [runtime, 'vfs'],
        ...(kind === 'timeout'
          ? { commandLimits: { '/data': { 'native-sleep': new Limit({ timeoutSeconds: 0.05 }) } } }
          : {}),
      },
    )
    try {
      const run = workspace.execute('native-sleep', { signal: abort.signal })
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
        expect(result.stderrText).toContain('timed out')
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
