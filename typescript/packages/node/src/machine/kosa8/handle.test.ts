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

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAsProcess } from '@struktoai/mirage-core/context/session_context'
import { ProcessTable } from '@struktoai/mirage-core/execution/process/table'
import { buildMachine } from '@struktoai/mirage-core/machine/registry'
import { PROCESS, stopLine } from '@struktoai/mirage-core/machine/constants'
import { ConnectionLostError } from '@struktoai/mirage-core/machine/errors'
import type { MachineMemory } from '@struktoai/mirage-core/machine/types'
import type { Context } from '@struktoai/mirage-core/commands/config'
import { answerOf } from '@struktoai/mirage-core/runtime/binding'
import type { OutputFn, RunAnswer, RunResult } from '@struktoai/mirage-core/runtime/types'
import { MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { machineRuntime } from '../../../tests/fixtures/machine.ts'
import { Kosa8Api, Kosa8ApiError, Kosa8StreamCut, parseFrame } from './api.ts'
import { egressPolicy, type Kosa8Config } from './config.ts'
import { PRELUDE } from './constants.ts'
import { Kosa8Machine } from './handle.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()
const SANDBOX = /^\/v1\/sandboxes\/([^/]+)(\/.*)?$/

function frame(value: Record<string, unknown>): Uint8Array {
  return ENC.encode(`${JSON.stringify(value)}\n`)
}

function data(stream: string, bytes: Uint8Array): Uint8Array {
  return frame({ stream, data: Buffer.from(bytes).toString('base64') })
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * kosa8 Cloud's REST API over local processes: each exec runs its argv here,
 * streaming NDJSON frames, and like kosa8 keeps running when its stream is
 * dropped; files land at their paths.
 */
class FakeKosa8 {
  readonly home = mkdtempSync(join(tmpdir(), 'mirage-kosa8-'))
  sandboxes = new Map<string, { id: string; state: string }>()
  calls: string[] = []
  created: Record<string, unknown>[] = []
  egress = new Map<string, unknown>()
  execs: string[][] = []
  uploads: string[] = []
  procs: ChildProcessByStdio<null, Readable, Readable>[] = []
  createState = 'running'
  laterState = 'running'
  cutAfter: number | null = null
  execStatus: number | null = null

  add(state = 'running'): string {
    const id = `sbx_${String(this.sandboxes.size + 1)}`
    this.sandboxes.set(id, { id, state })
    return id
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? 'GET'
    this.calls.push(`${method} ${url.pathname}`)
    const json = (): Record<string, unknown> =>
      JSON.parse(init?.body as string) as Record<string, unknown>
    if (url.pathname === '/v1/sandboxes' && method === 'POST') {
      this.created.push(json())
      const id = this.add(this.createState)
      const sandbox = this.sandboxes.get(id)
      if (sandbox !== undefined) sandbox.state = this.laterState
      return reply(201, { sandbox: { id, state: this.createState } })
    }
    const found = SANDBOX.exec(url.pathname)
    if (found === null) throw new Error(`unexpected ${url.pathname}`)
    const id = decodeURIComponent(found[1] ?? '')
    const rest = found[2] ?? ''
    const sandbox = this.sandboxes.get(id)
    if (sandbox === undefined || sandbox.state === 'deleted')
      return reply(404, { error: 'not_found', message: 'no such sandbox' })
    if (rest === '' && method === 'GET') return reply(200, { sandbox: { ...sandbox } })
    if (rest === '' && method === 'DELETE') {
      sandbox.state = 'deleted'
      return reply(200, {})
    }
    if (rest === '/sleep') {
      sandbox.state = 'sleeping'
      return reply(200, { sandbox: { ...sandbox } })
    }
    if (rest === '/egress') {
      this.egress.set(id, json())
      return reply(200, { egress: {} })
    }
    const path = url.searchParams.get('path') ?? ''
    if (rest === '/files/raw') {
      const parts: Uint8Array[] = []
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader()
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        parts.push(next.value)
      }
      writeFileSync(path, Buffer.concat(parts))
      this.uploads.push(path)
      return reply(200, { file: {} })
    }
    if (rest === '/files' && method === 'DELETE') {
      if (existsSync(path)) unlinkSync(path)
      return reply(200, {})
    }
    if (rest === '/exec') {
      if (this.execStatus !== null)
        return reply(this.execStatus, { error: 'host_failed', message: 'the host failed' })
      sandbox.state = 'running'
      const argv = json().cmd as string[]
      this.execs.push(argv)
      return new Response(this.frames(argv), { status: 200 })
    }
    throw new Error(`unexpected ${method} ${url.pathname}`)
  }

  private frames(argv: string[]): ReadableStream<Uint8Array> {
    const proc = spawn(argv[0] ?? '/bin/sh', argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      cwd: '/',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: this.home },
    })
    this.procs.push(proc)
    const cut = this.cutAfter
    let sent = 0
    return new ReadableStream<Uint8Array>({
      start(controller) {
        let ended = false
        const send = (name: string) => (chunk: Buffer) => {
          if (ended) return
          if (cut !== null && sent >= cut) {
            ended = true
            controller.close()
            return
          }
          sent += 1
          controller.enqueue(data(name, new Uint8Array(chunk)))
        }
        proc.stdout.on('data', send('stdout'))
        proc.stderr.on('data', send('stderr'))
        proc.on('close', (code, signal) => {
          if (ended) return
          ended = true
          controller.enqueue(frame({ done: true, exit: code ?? 128 + (signal === null ? 0 : 15) }))
          controller.close()
        })
      },
      cancel() {
        // kosa8 keeps the command once its stream is dropped.
      },
    })
  }

  stopAll(): void {
    for (const proc of this.procs) {
      if (proc.exitCode === null && proc.pid !== undefined) {
        try {
          process.kill(-proc.pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
  }
}

class Memory implements MachineMemory {
  readonly workspaceId = 'ws-1'
  constructor(
    readonly kept: Map<string, string> = new Map(),
    private readonly fail = false,
  ) {}
  recall(name: string): Promise<string | null> {
    return Promise.resolve(this.kept.get(name) ?? null)
  }
  remember(name: string, instance: string): Promise<void> {
    if (this.fail) return Promise.reject(new Error('the workspace store is down'))
    this.kept.set(name, instance)
    return Promise.resolve()
  }
  forget(name: string): Promise<void> {
    this.kept.delete(name)
    return Promise.resolve()
  }
  remembered(): Promise<Record<string, string>> {
    return Promise.resolve(Object.fromEntries(this.kept))
  }
}

let fake: FakeKosa8

class FakedKosa8Machine extends Kosa8Machine {
  protected override newApi(): Kosa8Api {
    return new Kosa8Api('k8c_live_test', undefined, fake.fetch as typeof fetch)
  }
  limitInput(bytes: number): void {
    this.inputLimit = bytes
  }
}

function makeMachine(config: Partial<Kosa8Config> = {}): FakedKosa8Machine {
  return new FakedKosa8Machine('box', config as Kosa8Config)
}

async function brought(config: Partial<Kosa8Config> = {}): Promise<FakedKosa8Machine> {
  const machine = makeMachine({ sandboxId: fake.add(), ...config })
  await machine.ensureConnected()
  return machine
}

function execArgv(
  machine: Kosa8Machine,
  argv: string[],
  output: OutputFn,
  errors: OutputFn,
  signal?: AbortSignal,
): Promise<RunResult> {
  const direct = machine as unknown as { execArgv: (...args: unknown[]) => Promise<RunResult> }
  return direct.execArgv(argv, null, {}, '/', output, errors, signal)
}

function lineOn(machine: Kosa8Machine, ctx: Context): Promise<RunAnswer> {
  return answerOf((output, errors) =>
    machineRuntime(machine).runLine(undefined, [], [], ctx, output, errors),
  )
}

async function* parts(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve()
    yield chunk
  }
}

beforeEach(() => {
  fake = new FakeKosa8()
})

afterEach(() => {
  fake.stopAll()
})

describe('egressPolicy', () => {
  it.each([
    [{}, null],
    [{ network: false }, { internet: false }],
    [{ network: true }, { internet: true }],
    [
      { allowedDomains: ['pypi.org', '*.github.com', '10.0.0.0/8'] },
      { internet: false, allow: ['pypi.org', '*.github.com', '10.0.0.0/8'] },
    ],
    [{ allowedDomains: [] }, { internet: false, allow: [] }],
    [{ allowedDomains: ['*'] }, { internet: true }],
    [{ deniedDomains: ['gist.github.com'] }, { internet: true, deny: ['gist.github.com'] }],
    [
      { allowedDomains: ['*.github.com'], deniedDomains: ['gist.github.com'] },
      { internet: false, allow: ['*.github.com'], deny: ['gist.github.com'] },
    ],
    [{ deniedDomains: ['*'] }, { internet: false }],
  ])('compiles %j to a kosa8 egress policy', (config, policy) => {
    expect(egressPolicy(config as Kosa8Config)).toEqual(policy)
  })
})

describe('Kosa8Machine config', () => {
  it.each([
    [{ sandboxId: ' ' }, 'nonblank sandboxId'],
    [{ sandboxId: 'sbx_1', template: 'base' }, 'template applies'],
    [{ sandboxId: 'sbx_1', image: 'debian:12' }, 'image applies'],
    [{ sandboxId: 'sbx_1', idleTimeout: 30 }, 'idleTimeout applies'],
    [{ sandboxId: 'sbx_1', secrets: ['GH'] }, 'secrets applies'],
    [{ template: 'base', image: 'debian:12' }, 'template or an image'],
    [{ idleTimeout: 0.5 }, 'idleTimeout must be'],
    [{ idleTimeout: Number.POSITIVE_INFINITY }, 'idleTimeout must be'],
    [{ network: 'no' }, 'true or false'],
    [{ allowedDomains: 'pypi.org' }, 'list of names'],
    [{ deniedDomains: ['', 'x.org'] }, 'list of names'],
    [{ deniedDomains: ['api.github.com:443'] }, 'not ports or IPv6'],
    [{ allowedDomains: ['::1'] }, 'not ports or IPv6'],
    [{ network: true, allowedDomains: ['pypi.org'] }, 'network: true'],
    [{ network: false, allowedDomains: ['pypi.org'] }, 'network: false'],
    [{ sandboxId: 'sbx_1', onPause: 'stop' }, 'onPause'],
    [{ sandboxId: 'sbx_1', region: 'eu' }, 'unknown'],
  ])('refuses %j', (config, message) => {
    expect(() => makeMachine(config as unknown as Kosa8Config)).toThrow(message)
  })

  it('refuses a mountType', async () => {
    const machine = makeMachine({ sandboxId: fake.add(), mountType: 'ssh' })
    const ctx = { stdin: null, flags: { c: 'true' }, env: {}, cwd: PathSpec.fromStrPath('/') }
    await expect(lineOn(machine, ctx)).rejects.toThrow('kosa8: mountType needs a pipe transport')
  })

  it("registers under the config name 'kosa8'", () => {
    const machine = buildMachine('box', { provider: 'kosa8', sandboxId: 'sbx_1' })
    expect(machine).toBeInstanceOf(Kosa8Machine)
    expect(String(machine.machine)).toBe('kosa8:box')
  })
})

describe('Kosa8Api', () => {
  const api = (handler: (url: URL, init: RequestInit) => Response): Kosa8Api =>
    new Kosa8Api('k8c_live_test', 'https://own.example.test/', ((
      input: string | URL,
      init: RequestInit,
    ) => Promise.resolve(handler(new URL(String(input)), init))) as typeof fetch)

  it('needs a key', () => {
    vi.stubEnv('KOSA8_API_KEY', '')
    expect(() => new Kosa8Api(undefined, undefined)).toThrow('set KOSA8_API_KEY')
    vi.unstubAllEnvs()
  })

  it('sends the key and reaches the configured address', async () => {
    const seen: string[] = []
    await api((url, init) => {
      seen.push(url.href, new Headers(init.headers).get('authorization') ?? '')
      return reply(200, { sandbox: { id: 'sbx_1' } })
    }).get('sbx_1')
    expect(seen).toEqual(['https://own.example.test/v1/sandboxes/sbx_1', 'Bearer k8c_live_test'])
  })

  it('carries kosa8s code and message on a refusal', async () => {
    const error = await api(() => reply(404, { error: 'not_found', message: 'no sandbox sbx_1' }))
      .get('sbx_1')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Kosa8ApiError)
    expect([(error as Kosa8ApiError).status, (error as Kosa8ApiError).code]).toEqual([
      404,
      'not_found',
    ])
    expect((error as Error).message).toContain('no sandbox sbx_1')
  })

  it('yields an exec’s frames byte for byte and skips heartbeats', async () => {
    const body = Buffer.concat([
      data('stdout', new Uint8Array([97, 0, 255])),
      frame({ heartbeat: true }),
      data('stderr', ENC.encode('e\n')),
      frame({ done: true, exit: 3 }),
    ])
    const frames = []
    for await (const f of api(() => new Response(body)).exec('sbx_1', ['true'], [])) frames.push(f)
    expect(frames).toEqual([
      { stream: 'stdout', data: new Uint8Array([97, 0, 255]) },
      { stream: 'stderr', data: ENC.encode('e\n') },
      { exitCode: 3 },
    ])
  })

  it.each([
    [data('stdout', ENC.encode('x')), 'ended before the command exited'],
    [frame({ done: true, error: 'the host stopped it' }), 'the host stopped it'],
    [ENC.encode('not json\n'), 'cannot read'],
    [frame({ stream: 'stdout', data: '!!' }), 'cannot read'],
  ])('a stream cut short says so', async (body, message) => {
    const run = async (): Promise<void> => {
      for await (const f of api(() => new Response(body)).exec('sbx_1', ['true'], [])) void f
    }
    await expect(run()).rejects.toThrow(Kosa8StreamCut)
    await expect(run()).rejects.toThrow(message)
  })

  it('reads a heartbeat as no frame', () => {
    expect(parseFrame('{"heartbeat":true}')).toBeNull()
  })
})

describe('Kosa8Machine', () => {
  it('reaches a brought sandbox by id', async () => {
    const machine = await brought()
    expect(machine.instance).toBe('sbx_1')
    expect(fake.calls).toEqual(['GET /v1/sandboxes/sbx_1'])
    expect(machine.startedByMirage).toBe(false)
  })

  it.each([
    ['deleted', 'was deleted or never existed'],
    ['error', 'failed to start'],
    ['stopped', 'was stopped'],
  ])('a brought sandbox that is %s says what to do', async (state, hint) => {
    const machine = makeMachine({ sandboxId: fake.add(state) })
    await expect(machine.ensureConnected()).rejects.toThrow(
      `sandbox sbx_1 is not running: it ${hint}`,
    )
  })

  it('sets a brought sandbox’s network policy only when the config has one', async () => {
    await brought({ allowedDomains: ['pypi.org'] })
    await brought()
    expect(Object.fromEntries(fake.egress)).toEqual({
      sbx_1: { internet: false, allow: ['pypi.org'] },
    })
  })

  it('starts a sandbox and remembers it when no id is given', async () => {
    const machine = makeMachine({
      template: 'code',
      idleTimeout: 12.5,
      deniedDomains: ['gist.github.com'],
      secrets: ['OPENAI_API_KEY'],
    })
    const memory = new Memory()
    machine.bindMemory(memory)
    await machine.ensureConnected()
    expect(fake.created).toEqual([
      {
        sleep_after_s: 13,
        labels: { mirage_machine: 'box' },
        template: 'code',
        egress: { internet: true, deny: ['gist.github.com'] },
        secrets: ['OPENAI_API_KEY'],
      },
    ])
    expect(Object.fromEntries(memory.kept)).toEqual({ box: 'sbx_1' })
    expect([machine.startedByMirage, machine.instance]).toEqual([true, 'sbx_1'])
  })

  it('reaches the sandbox an earlier build started, and starts anew when it is gone', async () => {
    const asleep = fake.add('sleeping')
    const again = makeMachine()
    again.bindMemory(new Memory(new Map([['box', asleep]])))
    await again.ensureConnected()
    expect(fake.created).toEqual([])
    const gone = fake.add('deleted')
    const memory = new Memory(new Map([['box', gone]]))
    const fresh = makeMachine()
    fresh.bindMemory(memory)
    await fresh.ensureConnected()
    expect(fake.created.length).toBe(1)
    expect(memory.kept.get('box')).toBe('sbx_3')
  })

  it('deletes a sandbox the workspace cannot keep', async () => {
    const machine = makeMachine()
    machine.bindMemory(new Memory(new Map(), true))
    await expect(machine.ensureConnected()).rejects.toThrow('store is down')
    expect(fake.sandboxes.get('sbx_1')?.state).toBe('deleted')
    expect(machine.startedByMirage).toBe(false)
  })

  it('runs a line under the prelude with its cwd and env', async () => {
    const machine = await brought()
    const dir = fake.home
    const result = await machine.execLine('pwd; echo "$E"', null, { E: 'v 1' }, dir)
    expect([result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]).toEqual([
      0,
      `${dir}\nv 1\n`,
      '',
    ])
    const argv = fake.execs[0] ?? []
    expect(argv.slice(0, 7)).toEqual(['/bin/sh', '-c', PRELUDE, 'sh', '', dir, 'env'])
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'pwd; echo "$E"'])
  })

  it('exits 126 in a missing cwd', async () => {
    const machine = await brought()
    expect((await machine.execLine('true', null, {}, '/no/such/dir')).exitCode).toBe(126)
  })

  it('returns bytes and the exit code exactly', async () => {
    const machine = await brought()
    const result = await machine.execLine(
      "printf 'a\\377\\000b\\r\\n'; printf 'e\\376\\000' >&2; exit 5",
      null,
      {},
      '/',
    )
    expect(result.exitCode).toBe(5)
    expect([...result.stdout]).toEqual([97, 255, 0, 98, 13, 10])
    expect([...result.stderr]).toEqual([101, 254, 0])
  })

  it('uploads input whole and reads it as stdin', async () => {
    const machine = await brought()
    const bytes = new Uint8Array(256 * 1000).map((_, i) => i % 256)
    const result = await machine.execLine(
      'cat',
      parts(bytes.subarray(0, 1000), bytes.subarray(1000)),
      {},
      '/',
    )
    expect(Buffer.compare(Buffer.from(result.stdout), Buffer.from(bytes))).toBe(0)
    const [staged] = fake.uploads
    expect(staged).toMatch(/\/\.mirage\/in-[0-9a-f]{32}$/)
    expect(staged?.startsWith(fake.home)).toBe(true)
    expect(existsSync(staged ?? '')).toBe(false)
  })

  it('reads no input as empty', async () => {
    const machine = await brought()
    expect(DEC.decode((await machine.execLine('wc -c', null, {}, '/')).stdout).trim()).toBe('0')
  })

  it('fails a line whose input passes the limit', async () => {
    const machine = await brought()
    machine.limitInput(10)
    const result = await machine.execLine('cat', ENC.encode('x'.repeat(11)), {}, '/')
    expect(result.exitCode).toBe(126)
    expect(DEC.decode(result.stderr)).toContain('input past 10 bytes')
    expect(readdirSync(join(fake.home, '.mirage'))).toEqual([])
  })

  it('stages a line too long for one exec as a script', async () => {
    const machine = await brought()
    // 5,000 characters, 10,000 UTF-16 units: past what kosa8 counts.
    const word = '\u{1d11e}'.repeat(5000)
    const result = await machine.execLine(`printf %s '${word}' | wc -c`, null, {}, '/')
    expect(DEC.decode(result.stdout).trim()).toBe(String(ENC.encode(word).byteLength))
    const argv = fake.execs.at(-1) ?? []
    expect(argv.length).toBe(2)
    expect(argv[1]).toMatch(/\/\.mirage\/run-[0-9a-f]{32}$/)
    expect(existsSync(argv[1] ?? '')).toBe(false)
  })

  it('stages many variables too', async () => {
    const machine = await brought()
    const env = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`V${String(i)}`, String(i)]),
    )
    const result = await machine.execLine('echo "$V299"', null, env, '/')
    expect(DEC.decode(result.stdout)).toBe('299\n')
    expect(fake.execs.at(-1)?.length).toBe(2)
  })

  it('asks for its folder once', async () => {
    const machine = await brought()
    await machine.execLine('cat', ENC.encode('a'), {}, '/')
    await machine.execLine('cat', ENC.encode('b'), {}, '/')
    expect(fake.execs.filter((argv) => (argv.at(-1) ?? '').includes('printf %s "$d"')).length).toBe(
      1,
    )
  })

  it('stops an aborted line by its tag', async () => {
    const machine = await brought()
    const ready = join(fake.home, 'ready')
    const abort = new AbortController()
    const line = machine.execLine(`echo $$ > ${ready}; sleep 30`, null, {}, '/', abort.signal)
    await vi.waitFor(
      () => {
        expect(existsSync(ready) && readFileSync(ready, 'utf8').trim() !== '').toBe(true)
      },
      { timeout: 10000 },
    )
    const pid = Number(readFileSync(ready, 'utf8'))
    abort.abort()
    await expect(line).rejects.toThrow()
    const tags = (fake.execs[0] ?? [])
      .filter((word) => word.startsWith(`${PROCESS}=`))
      .map((word) => word.slice(PROCESS.length + 1))
    expect(tags.length).toBe(1)
    const stop = stopLine(tags[0] ?? '', 15)
    await vi.waitFor(() => {
      expect(fake.execs.slice(1).some((argv) => (argv.at(-1) ?? '').includes(stop))).toBe(true)
    })
    // The stop line finds a run's processes through /proc.
    if (!existsSync('/proc')) return
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow()
      },
      { timeout: 10000 },
    )
  })

  it.skipIf(!existsSync('/proc'))('a kill reaches the program with its signal', async () => {
    const [ready, seen] = [join(fake.home, 'ready'), join(fake.home, 'seen')]
    const machine = makeMachine({ sandboxId: fake.add() })
    const abort = new AbortController()
    const ctx = {
      stdin: null,
      flags: {
        c:
          `trap 'echo INT >> ${seen}; exit 0' INT; ` +
          `trap 'echo TERM >> ${seen}; exit 0' TERM; ` +
          `echo up > ${ready}; while :; do sleep 1; done`,
      },
      env: {},
      cwd: PathSpec.fromStrPath('/'),
      signal: abort.signal,
    }
    const runner = new ProcessTable(undefined, undefined, runAsProcess).start({
      sessionId: 's',
      command: 'sh',
      cwd: ctx.cwd,
      cancel: () => {
        abort.abort()
      },
      run: async () => (await lineOn(machine, ctx)).exitCode,
    })
    await vi.waitFor(
      () => {
        expect(existsSync(ready)).toBe(true)
      },
      { timeout: 10000 },
    )
    expect(runner.terminate(2)).toBe(true)
    expect((await runner.join()).exit).toBe(130)
    expect(readFileSync(seen, 'utf8')).toBe('INT\n')
  })

  it('keeps what a line read before its stream dropped', async () => {
    const machine = await brought()
    fake.cutAfter = 1
    const [out, err]: [Uint8Array[], Uint8Array[]] = [[], []]
    const lost = await execArgv(
      machine,
      ['/bin/sh', '-c', 'echo out; sleep 0.3; echo more'],
      (d) => Promise.resolve(void out.push(d)),
      (d) => Promise.resolve(void err.push(d)),
    ).catch((error: unknown) => error)
    expect(lost).toBeInstanceOf(ConnectionLostError)
    expect(DEC.decode(Buffer.concat(out))).toBe('out\n')
    expect(DEC.decode(Buffer.concat(err))).toMatch(/^kosa8: kosa8 could not be reached/)
  })

  it('loses a line kosa8 could not run, and the next line connects again', async () => {
    const machine = makeMachine({ sandboxId: fake.add() })
    const ctx = { stdin: null, flags: { c: 'echo hi' }, env: {}, cwd: PathSpec.fromStrPath('/') }
    fake.execStatus = 503
    const result = await lineOn(machine, ctx)
    expect(result.exitCode).toBe(129)
    expect(DEC.decode(result.stderr)).toContain('mirage: kosa8:box: connection lost\n')
    fake.execStatus = null
    const again = await lineOn(machine, ctx)
    expect([again.exitCode, DEC.decode(again.stdout)]).toEqual([0, 'hi\n'])
    expect(fake.calls.filter((c) => c === 'GET /v1/sandboxes/sbx_1').length).toBe(2)
  })

  it('says what to do when the sandbox is deleted under a line', async () => {
    const machine = await brought()
    const sandbox = fake.sandboxes.get('sbx_1')
    if (sandbox !== undefined) sandbox.state = 'deleted'
    await expect(machine.execLine('echo hi', null, {}, '/')).rejects.toThrow(
      'sandbox sbx_1 is not running: it was deleted',
    )
  })

  it('close leaves the sandbox; pause puts it to sleep', async () => {
    const machine = await brought({ onPause: 'pause' })
    expect(machine.configAsksToPause()).toBe(true)
    await machine.close()
    expect(fake.sandboxes.get('sbx_1')?.state).toBe('running')
    await machine.pause()
    expect(fake.sandboxes.get('sbx_1')?.state).toBe('sleeping')
  })

  it('pausing a sandbox already gone is quiet', async () => {
    const machine = await brought()
    await machine.close()
    const sandbox = fake.sandboxes.get('sbx_1')
    if (sandbox !== undefined) sandbox.state = 'deleted'
    await machine.pause()
  })

  it('destroy deletes only a sandbox Mirage started', async () => {
    const own = await brought()
    await own.destroy()
    expect(fake.sandboxes.get('sbx_1')?.state).toBe('running')
    const memory = new Memory()
    const started = makeMachine()
    started.bindMemory(memory)
    await started.ensureConnected()
    await started.destroy()
    expect(fake.sandboxes.get('sbx_2')?.state).toBe('deleted')
    expect(memory.kept.size).toBe(0)
    const remembered = fake.add('sleeping')
    const later = makeMachine()
    later.bindMemory(new Memory(new Map([['box', remembered]])))
    await later.destroy()
    expect(fake.sandboxes.get(remembered)?.state).toBe('deleted')
  })

  it('runs a workspace’s captured programs on the sandbox', async () => {
    const machine = makeMachine({ sandboxId: fake.add(), captures: ['@python', '@external'] })
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, machines: { box: machine } },
    )
    try {
      await ws.shell('cat > /data/in.txt', { stdin: ENC.encode('alpha\nbeta\n') })
      const result = await ws.shell(
        `cat /data/in.txt | python3 -c 'import sys; print(sys.stdin.read().upper(), end="")'`,
      )
      expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'ALPHA\nBETA\n'])
    } finally {
      await ws.close()
    }
  })
})
