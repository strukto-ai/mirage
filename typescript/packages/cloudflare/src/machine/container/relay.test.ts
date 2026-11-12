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

import type { Context } from '@struktoai/mirage-core/commands/config'
import { CHECK_LINE, EXEC_PRELUDE, isRun } from '@struktoai/mirage-core/machine/constants'
import { ContainerMachine } from '@struktoai/mirage-core/machine/cloudflare_container/handle'
import { RelayContainer } from '@struktoai/mirage-core/machine/cloudflare_container/relay'
import type {
  ExecOptions,
  ExecProcess,
  RelaySocket,
} from '@struktoai/mirage-core/machine/cloudflare_container/types'
import { RELAY_WINDOW_BYTES } from '@struktoai/mirage-core/machine/cloudflare_container/constants'
import { logger } from '@struktoai/mirage-core/machine/handle'
import { PathSpec } from '@struktoai/mirage-core/types'
import { concat } from '@struktoai/mirage-core/utils/bytes'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContainerRelay, relayFetch, type RelayedContainer } from './relay.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const TOKEN = 'relay-test-token'
const URL_BASE = 'https://relay.test/relay/box'
// NUL and CR LF, which line framing trips on, and bytes that are not UTF-8.
const ODD = new Uint8Array([0, 13, 10, 255, 128, 254, 0])

type Listener = (event: { readonly data: unknown }) => void

/** One end of an in-memory WebSocket: what is sent arrives at its peer, in order. */
class MemorySocket implements RelaySocket {
  peer: MemorySocket | null = null
  closed = false
  private readonly listeners: Record<string, Listener[]> = { message: [], close: [], error: [] }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.closed) throw new Error('the socket is closed')
    const copy = typeof data === 'string' ? data : data.slice().buffer
    const peer = this.peer
    queueMicrotask(() => {
      if (peer !== null && !peer.closed) peer.emit('message', copy)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const peer = this.peer
    queueMicrotask(() => {
      this.emit('close')
      if (peer !== null && !peer.closed) {
        peer.closed = true
        peer.emit('close')
      }
    })
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners[type]?.push(listener)
  }

  private emit(type: string, data?: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener({ data })
  }
}

function pair(): [MemorySocket, MemorySocket] {
  const [a, b] = [new MemorySocket(), new MemorySocket()]
  a.peer = b
  b.peer = a
  return [a, b]
}

type Program = (proc: ScriptedProcess) => Promise<number>

/** A process a scripted container runs: its input kept, its output written by its program. */
class ScriptedProcess implements ExecProcess {
  readonly stdin: WritableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exitCode: Promise<number>
  readonly killed: number[] = []
  input: Uint8Array = new Uint8Array()
  inputClosed = false
  readonly inputEnded: Promise<void>
  readonly out: WritableStreamDefaultWriter<Uint8Array>
  readonly err: WritableStreamDefaultWriter<Uint8Array>
  private onKill: (signal: number) => void = () => undefined

  constructor(
    readonly argv: readonly string[],
    readonly env: Record<string, string> | undefined,
    program: Program,
    deaf = false,
  ) {
    const out = new TransformStream<Uint8Array, Uint8Array>()
    const err = new TransformStream<Uint8Array, Uint8Array>()
    const writers = [out.writable.getWriter(), err.writable.getWriter()] as const
    this.stdout = out.readable
    this.stderr = err.readable
    ;[this.out, this.err] = writers
    let closed: () => void = () => undefined
    const ended = new Promise<void>((resolve) => {
      closed = resolve
    })
    this.stdin = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.inputClosed) throw new Error('Broken pipe')
        this.input = concat([this.input, chunk])
        // A deaf program takes nothing past its first chunk.
        return deaf ? new Promise<void>(() => undefined) : undefined
      },
      close: () => {
        this.inputClosed = true
        closed()
      },
    })
    this.inputEnded = ended
    this.exitCode = (async () => {
      const killed = new Promise<number>((resolve) => {
        this.onKill = (signal) => {
          resolve(128 + signal)
        }
      })
      const code = await Promise.race([program(this), killed])
      for (const settled of await Promise.allSettled(writers.map((writer) => writer.close())))
        if (settled.status === 'rejected')
          logger.debug?.(`scripted process: output not closed: ${String(settled.reason)}`)
      return code
    })()
  }

  kill(signal = 15): void {
    this.killed.push(signal)
    this.onKill(signal)
  }
}

/** A container whose execs run programs by their first word; `down` refuses every exec. */
class ScriptedContainer implements RelayedContainer {
  readonly procs: ScriptedProcess[] = []
  running = false
  starts = 0
  down: Error | null = null
  // Each exec waits for `held` before it answers; a deaf one's program takes no input.
  held: Promise<void> | null = null
  deaf = false
  private exited: { resolve: () => void; reject: (error: Error) => void } | null = null

  constructor(private readonly programs: Record<string, Program> = {}) {}

  start(): void {
    this.starts += 1
    this.running = true
  }

  async exec(cmd: string[], options?: ExecOptions): Promise<ExecProcess> {
    if (this.down !== null) throw this.down
    await this.held
    let inner = cmd[2] === EXEC_PRELUDE ? cmd.slice(5) : cmd
    if (isRun(inner)) inner = inner.slice(7)
    const line = inner[0] === '/bin/sh' && inner[1] === '-c' ? (inner[2] ?? '') : inner.join(' ')
    const program =
      line === CHECK_LINE
        ? async (proc: ScriptedProcess) => {
            await proc.out.write(ENC.encode('mirage-check\n'))
            return 0
          }
        : (this.programs[line.split(' ')[0] ?? ''] ?? (() => Promise.resolve(0)))
    const proc = new ScriptedProcess(cmd, options?.env, program, this.deaf)
    this.procs.push(proc)
    return proc
  }

  monitor(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.exited = { resolve, reject }
    })
  }

  exit(error?: Error): void {
    this.running = false
    if (error === undefined) this.exited?.resolve()
    else this.exited?.reject(error)
  }
}

/** A relay whose sockets are in memory, so its own `serve` is what a client reaches. */
class MemoryRelay extends ContainerRelay<Record<string, string>> {
  serveSocket(call: string, socket: RelaySocket): void {
    this.serve(call, socket)
  }
}

/** A client that reaches `relay` in memory: its POSTs through the relay's fetch, its sockets paired. */
class MemoryClient extends RelayContainer {
  readonly opened: MemorySocket[] = []

  constructor(
    private readonly relay: MemoryRelay,
    private readonly secret = TOKEN,
  ) {
    super(URL_BASE, secret)
  }

  protected override post(url: string): Promise<Response> {
    return this.relay.fetch(
      new Request(url, { method: 'POST', headers: { authorization: `Bearer ${this.secret}` } }),
    )
  }

  protected override openSocket(url: string): Promise<RelaySocket> {
    const [mine, theirs] = pair()
    this.opened.push(mine)
    this.relay.serveSocket(url.split('/').at(-1) ?? '', theirs)
    return Promise.resolve(mine)
  }
}

function relayed(
  programs: Record<string, Program> = {},
  secret: string | null = TOKEN,
): { box: ScriptedContainer; relay: MemoryRelay } {
  const box = new ScriptedContainer(programs)
  const env: Record<string, string> = secret === null ? {} : { MIRAGE_RELAY_TOKEN: secret }
  return { box, relay: new MemoryRelay({ container: box }, env) }
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (stream === null) throw new Error('the process has no such pipe')
  const parts: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return concat(parts)
    parts.push(value)
  }
}

describe('ContainerRelay with RelayContainer', () => {
  it('starts the container once and answers 204', async () => {
    const { box, relay } = relayed()
    const client = new MemoryClient(relay)
    await client.start()
    await client.start()
    expect(box.starts).toBe(1)
  })

  it('carries argv, env, stdin and both outputs byte for byte, then the status', async () => {
    const { box, relay } = relayed({
      echo: async (proc) => {
        await proc.inputEnded
        await proc.out.write(proc.input)
        await proc.err.write(ODD)
        return 3
      },
    })
    const proc = await new MemoryClient(relay).exec(['echo', 'a b'], { env: { K: 'v' } })
    const input = proc.stdin?.getWriter()
    await input?.write(ODD)
    await input?.write(ENC.encode('tail'))
    await input?.close()
    const [out, err, code] = await Promise.all([
      readAll(proc.stdout),
      readAll(proc.stderr),
      proc.exitCode,
    ])
    expect(out).toEqual(concat([ODD, ENC.encode('tail')]))
    expect(err).toEqual(ODD)
    expect(code).toBe(3)
    expect(box.procs[0]?.argv).toEqual(['echo', 'a b'])
    expect(box.procs[0]?.env).toEqual({ K: 'v' })
    expect(box.procs[0]?.inputClosed).toBe(true)
  })

  it('forwards a signal to the process', async () => {
    const { box, relay } = relayed({ sleep: () => new Promise<number>(() => undefined) })
    const proc = await new MemoryClient(relay).exec(['sleep'])
    proc.kill(2)
    expect(await proc.exitCode).toBe(130)
    expect(box.procs[0]?.killed).toEqual([2])
  })

  it('kills a process whose client went before it exited', async () => {
    const { box, relay } = relayed({ sleep: () => new Promise<number>(() => undefined) })
    const client = new MemoryClient(relay)
    const proc = await client.exec(['sleep'])
    client.opened[0]?.close()
    await expect(proc.exitCode).rejects.toThrow('the connection to the relay closed')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(box.procs[0]?.killed).toEqual([9])
  })

  it('rejects an exec on a stopped container with what the container said', async () => {
    const { box, relay } = relayed()
    box.down = new Error('exec() cannot be called on a container that is not running.')
    await expect(new MemoryClient(relay).exec(['true'])).rejects.toThrow(
      'exec() cannot be called on a container that is not running.',
    )
  })

  it('refuses a wrong token before anything runs, on every call', async () => {
    const { box, relay } = relayed()
    const client = new MemoryClient(relay, 'wrong')
    await expect(client.exec(['true'])).rejects.toThrow('the relay refused the token')
    await expect(client.monitor()).rejects.toThrow('the relay refused the token')
    await expect(client.start()).rejects.toThrow(
      'the relay answered 401 to start: the relay refused the token',
    )
    expect(box.procs).toHaveLength(0)
    expect(box.starts).toBe(0)
  })

  it('refuses every call when it has no secret', async () => {
    const { relay } = relayed({}, null)
    await expect(new MemoryClient(relay).exec(['true'])).rejects.toThrow(
      'the relay has no MIRAGE_RELAY_TOKEN secret, so it refuses every call',
    )
  })

  it('tells a monitor when the container exits, with its error', async () => {
    const { box, relay } = relayed()
    const client = new MemoryClient(relay)
    const clean = client.monitor()
    await new Promise((resolve) => setTimeout(resolve, 0))
    box.exit()
    await expect(clean).resolves.toBeUndefined()
    const failed = client.monitor()
    await new Promise((resolve) => setTimeout(resolve, 0))
    box.exit(new Error('out of memory'))
    await expect(failed).rejects.toThrow('out of memory')
  })

  it('runs a line on a machine built over it', async () => {
    const { box, relay } = relayed({
      printf: async (proc) => {
        await proc.out.write(ENC.encode('from the relay\n'))
        return 0
      },
    })
    const client = new MemoryClient(relay)
    const machine = new ContainerMachine('box', {}, client, () => client.start())
    const ctx: Context = { stdin: null, flags: {}, env: {}, cwd: PathSpec.fromStrPath('/') }
    const result = await machine.run(['printf', 'x'], ctx, null, null, null)
    expect(DEC.decode(result.stdout)).toBe('from the relay\n')
    expect(result.exitCode).toBe(0)
    expect(box.starts).toBe(1)
    await machine.close()
  })
})

describe('ContainerRelay limits', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers a browser preflight for start and lets any origin read its answer', async () => {
    const { relay } = relayed()
    const preflight = await relay.fetch(new Request(`${URL_BASE}/start`, { method: 'OPTIONS' }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization')
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST')
    const started = await relay.fetch(
      new Request(`${URL_BASE}/start`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    )
    expect(started.status).toBe(204)
    expect(started.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('kills a process whose client left while exec was starting', async () => {
    const { box, relay } = relayed({ sleep: () => new Promise<number>(() => undefined) })
    let answer: () => void = () => undefined
    box.held = new Promise((resolve) => {
      answer = resolve
    })
    const client = new MemoryClient(relay)
    const asked = client.exec(['sleep'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    client.opened[0]?.close()
    await expect(asked).rejects.toThrow('the relay closed the exec before it started')
    answer()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(box.procs[0]?.killed).toEqual([9])
  })

  it('stops a monitor speaking once its client has gone', async () => {
    vi.useFakeTimers()
    const { relay } = relayed()
    const [mine, theirs] = pair()
    relay.serveSocket('monitor', theirs)
    mine.send(JSON.stringify({ token: TOKEN }))
    await vi.advanceTimersByTimeAsync(0)
    const sent = vi.spyOn(theirs, 'send')
    mine.close()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sent).not.toHaveBeenCalled()
  })

  it('reads no further ahead of a slow reader than its window', async () => {
    const chunk = new Uint8Array(64 * 1024)
    let written = 0
    const { relay } = relayed({
      flood: async (proc) => {
        for (let at = 0; at < (4 * RELAY_WINDOW_BYTES) / chunk.byteLength; at++) {
          await proc.out.write(chunk)
          written += chunk.byteLength
        }
        return 0
      },
    })
    const proc = await new MemoryClient(relay).exec(['flood'])
    await proc.stdin?.getWriter().close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(written).toBeLessThanOrEqual(2 * RELAY_WINDOW_BYTES)
    const out = await readAll(proc.stdout)
    expect(out.byteLength).toBe(4 * RELAY_WINDOW_BYTES)
    expect(await proc.exitCode).toBe(0)
  })

  it('keeps a program going after its reader cancelled the stream', async () => {
    const chunk = new Uint8Array(64 * 1024)
    const { relay } = relayed({
      flood: async (proc) => {
        for (let at = 0; at < (4 * RELAY_WINDOW_BYTES) / chunk.byteLength; at++)
          await proc.out.write(chunk)
        return 0
      },
    })
    const proc = await new MemoryClient(relay).exec(['flood'])
    await proc.stdin?.getWriter().close()
    await proc.stdout?.cancel()
    expect(await readAll(proc.stderr)).toEqual(new Uint8Array())
    expect(await proc.exitCode).toBe(0)
  })

  it('holds stdin back once the program has a window of it untaken', async () => {
    const { box, relay } = relayed({ sleep: () => new Promise<number>(() => undefined) })
    box.deaf = true
    const proc = await new MemoryClient(relay).exec(['sleep'])
    const input = proc.stdin?.getWriter()
    const chunk = new Uint8Array(RELAY_WINDOW_BYTES / 4)
    let sent = 0
    const sending = (async () => {
      for (let at = 0; at < 16; at++) {
        await input?.write(chunk)
        sent += 1
      }
    })()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toBeLessThanOrEqual(5)
    proc.kill(9)
    await proc.exitCode
    void sending.catch(() => undefined)
  })

  it('fails a write once the program has closed its input', async () => {
    const { relay } = relayed({
      deaf: async (proc) => {
        await proc.stdin.close()
        return new Promise<number>(() => undefined)
      },
    })
    const proc = await new MemoryClient(relay).exec(['deaf'])
    const input = proc.stdin?.getWriter()
    const chunk = new Uint8Array(RELAY_WINDOW_BYTES / 4)
    const flood = async (): Promise<void> => {
      for (let at = 0; at < 16; at++) await input?.write(chunk)
    }
    await expect(flood()).rejects.toThrow('the program closed its input')
    proc.kill(9)
    await proc.exitCode
  })

  it('closes a socket that sends no request in time', async () => {
    vi.useFakeTimers()
    const { relay } = relayed()
    const [mine, theirs] = pair()
    const heard: unknown[] = []
    mine.addEventListener('message', ({ data }) => heard.push(data))
    relay.serveSocket('exec', theirs)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(heard).toEqual([JSON.stringify({ refused: 'no request within 10s' })])
    expect(mine.closed).toBe(true)
  })

  it('stops a process that starts after its caller gave up', async () => {
    const { box, relay } = relayed({ sleep: () => new Promise<number>(() => undefined) })
    let answer: () => void = () => undefined
    box.held = new Promise((resolve) => {
      answer = resolve
    })
    const client = new MemoryClient(relay)
    const machine = new ContainerMachine('box', {}, client, () => client.start())
    const gaveUp = new AbortController()
    const line = machine.execLine('sleep 30', null, { MIRAGE_PROCESS: 't' }, '/', gaveUp.signal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    gaveUp.abort()
    await expect(line).rejects.toThrow()
    answer()
    for (let tick = 0; tick < 5 && box.procs[0]?.killed.length !== 1; tick++)
      await new Promise((resolve) => setTimeout(resolve, 0))
    expect(box.procs[0]?.killed).toEqual([9])
  })

  it('says a runtime with no WebSocket cannot reach a relay', async () => {
    vi.stubGlobal('WebSocket', undefined)
    try {
      await expect(new RelayContainer(URL_BASE, TOKEN).start()).rejects.toThrow(
        'this runtime has no WebSocket, which a relay needs',
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('closes its sockets, the exit watch among them, when the machine closes', async () => {
    const { relay } = relayed()
    const client = new MemoryClient(relay)
    const machine = new ContainerMachine('box', {}, client, () => client.start())
    const ctx: Context = { stdin: null, flags: {}, env: {}, cwd: PathSpec.fromStrPath('/') }
    await machine.run(['true'], ctx, null, null, null)
    expect(client.opened.some((socket) => !socket.closed)).toBe(true)
    await (client as RelayContainer).close()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.opened.every((socket) => socket.closed)).toBe(true)
  })
})

describe('relayFetch', () => {
  it('routes /<name>/<call> to the relay named name', async () => {
    const asked: string[] = []
    const relays = {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: () => {
          asked.push(String(id))
          return Promise.resolve(new Response(null, { status: 204 }))
        },
      }),
    }
    const response = await relayFetch(new Request(`${URL_BASE}/start`, { method: 'POST' }), relays)
    expect(response.status).toBe(204)
    expect(asked).toEqual(['box'])
    expect((await relayFetch(new Request('https://relay.test/start'), relays)).status).toBe(404)
  })
})
