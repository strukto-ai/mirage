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
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import {
  CHECK_LINE,
  CHECK_MARK,
  CHECK_WAIT_SECONDS,
  EXEC_PRELUDE,
  MOUNT_GUARD,
  PIPE_DIAGNOSTIC_BYTES,
  PROCESS,
  isRun,
  stopLine,
} from '@struktoai/mirage-core/machine/constants'
import { ConnectionLostError } from '@struktoai/mirage-core/machine/errors'
import { buildMachine } from '@struktoai/mirage-core/machine/registry'
import { OPEN } from '@struktoai/mirage-core/mount/constants'
import '@struktoai/mirage-core/mount/sftp'
import { RemoteRuntime } from '@struktoai/mirage-core/runtime/machine/runtime'
import type { RunResult } from '@struktoai/mirage-core/runtime/types'
import { MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { concat } from '@struktoai/mirage-core/utils/bytes'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOT_ANSWERING, STOPPED } from './constants.ts'
import { ContainerMachine } from './handle.ts'
import type { Container, ExecOptions, ExecProcess } from './types.ts'

vi.setConfig({ testTimeout: 10_000 })

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const PIPES = { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
// NUL and CR LF, which line framing trips on, and bytes that are not UTF-8.
const ODD = new Uint8Array([0, 13, 10, 255, 128, 254, 0])

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return concat(parts)
    parts.push(value)
  }
}

// The line an exec runs: its argv past the prelude, a run's wrapper and a mount guard.
function lineOf(argv: readonly string[]): string {
  let inner = argv[2] === EXEC_PRELUDE ? argv.slice(5) : argv
  if (isRun(inner)) inner = inner.slice(7)
  if (inner[2] === MOUNT_GUARD) inner = inner.slice(inner.indexOf('--', 5) + 1)
  return inner[0] === '/bin/sh' && inner[1] === '-c' ? (inner[2] ?? '') : inner.join(' ')
}

type Program = (proc: FakeProcess) => Promise<number> | number

/**
 * A process a fake container's exec starts: `program` scripts it over real
 * output streams. Its stdin keeps no queue of its own, so a write sent
 * while another is still landing is refused.
 */
class FakeProcess implements ExecProcess {
  readonly stdin: WritableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exitCode: Promise<number>
  readonly killed: number[] = []
  input: Uint8Array = new Uint8Array()
  closed = false
  exited = false
  overlapped = false
  // A deaf process has closed its input; a stubborn one ignores TERM.
  deaf = false
  stubborn = false
  writes = 0
  onInput: (chunk: Uint8Array) => void = () => undefined
  private readonly eof = deferred<undefined>()
  private readonly dead = deferred<number>()
  private readonly out: WritableStreamDefaultWriter<Uint8Array>
  private readonly err: WritableStreamDefaultWriter<Uint8Array>
  private writing = false

  constructor(
    readonly line: string,
    program: Program,
    private readonly log: string[],
  ) {
    const out = new TransformStream<Uint8Array, Uint8Array>()
    const err = new TransformStream<Uint8Array, Uint8Array>()
    this.stdout = out.readable
    this.stderr = err.readable
    this.out = out.writable.getWriter()
    this.err = err.writable.getWriter()
    const writer = {
      write: async (chunk: Uint8Array): Promise<void> => {
        this.writes += 1
        if (this.deaf) throw new Error('the input is closed')
        if (this.writing) {
          this.overlapped = true
          throw new Error('a write is already landing')
        }
        this.writing = true
        await new Promise((resolve) => setTimeout(resolve, 1))
        this.input = concat([this.input, chunk])
        this.writing = false
        this.onInput(chunk)
      },
      close: (): Promise<void> => {
        this.closed = true
        this.eof.resolve(undefined)
        return Promise.resolve()
      },
    }
    this.stdin = { getWriter: () => writer } as unknown as WritableStream<Uint8Array>
    this.exitCode = Promise.race([
      Promise.resolve().then(() => program(this)),
      this.dead.promise,
    ]).finally(() => {
      this.exited = true
      this.out.close().catch(() => undefined)
      this.err.close().catch(() => undefined)
    })
  }

  say(data: string | Uint8Array): Promise<void> {
    return this.out.write(typeof data === 'string' ? ENC.encode(data) : data)
  }

  complain(text: string): Promise<void> {
    return this.err.write(ENC.encode(text))
  }

  /** Everything the process was sent, once its stdin closed. */
  async allInput(): Promise<Uint8Array> {
    await this.eof.promise
    return this.input
  }

  kill(signal = 15): void {
    this.killed.push(signal)
    this.log.push(`kill ${String(signal)} ${this.line}`)
    if (this.stubborn && signal !== 9) return
    setTimeout(() => {
      this.dead.resolve(128 + signal)
    }, 5)
  }
}

const cat: Program = async (proc) => {
  await proc.say(await proc.allInput())
  return 0
}
const sleep: Program = () => new Promise<number>(() => undefined)
const check: Program = async (proc) => {
  await proc.say(`${CHECK_MARK}\n`)
  return 0
}

/**
 * A Durable Object's container: `programs`, by a line's first word, script
 * what its execs run. A line with no program exits 0.
 */
class FakeContainer implements Container {
  readonly execs: { argv: string[]; options: ExecOptions | undefined; proc: FakeProcess }[] = []
  readonly log: string[] = []
  // Each fails the next exec; `down` fails every one, and `hung` leaves every one unanswered.
  readonly refusals: Error[] = []
  down: Error | null = null
  hung = false
  asked = 0
  private exited = deferred<undefined>()

  constructor(private readonly programs: Record<string, Program> = {}) {}

  exec(argv: string[], options?: ExecOptions): Promise<ExecProcess> {
    this.asked += 1
    if (this.hung) return new Promise(() => undefined)
    const refusal = this.down ?? this.refusals.shift()
    if (refusal !== undefined) return Promise.reject(refusal)
    const line = lineOf(argv)
    this.log.push(`exec ${line}`)
    const program =
      line === CHECK_LINE ? check : (this.programs[line.split(' ')[0] ?? ''] ?? (() => 0))
    const proc = new FakeProcess(line, program, this.log)
    this.execs.push({ argv, options, proc })
    return Promise.resolve(proc)
  }

  monitor(): Promise<void> {
    return this.exited.promise
  }

  /** The container exits: cleanly, or with `error`. */
  exit(error?: Error): void {
    const was = this.exited
    this.exited = deferred()
    was.promise.catch(() => undefined)
    if (error === undefined) was.resolve(undefined)
    else was.reject(error)
  }

  /** The exec that ran `line`. */
  ran(line: string): FakeProcess {
    const found = this.execs.find((exec) => exec.proc.line === line)
    if (found === undefined) throw new Error(`no exec ran ${line}`)
    return found.proc
  }
}

function boxed(programs: Record<string, Program> = {}): {
  box: FakeContainer
  start: ReturnType<typeof vi.fn<() => Promise<void>>>
  machine: ContainerMachine
} {
  const box = new FakeContainer(programs)
  const start = vi.fn(() => Promise.resolve())
  return { box, start, machine: new ContainerMachine('box', {}, box, start) }
}

/** The handle's transport called directly, as the base class calls it. */
function execArgv(
  machine: ContainerMachine,
  argv: string[],
  stdin: ByteSource | null = null,
  more: {
    env?: Record<string, string>
    cwd?: string
    output?: (data: Uint8Array) => Promise<void>
    errors?: (data: Uint8Array) => Promise<void>
  } = {},
): Promise<RunResult> {
  const direct = machine as unknown as { execArgv: (...args: unknown[]) => Promise<RunResult> }
  return direct.execArgv(
    argv,
    stdin,
    more.env ?? {},
    more.cwd ?? '/',
    more.output ?? null,
    more.errors ?? null,
  )
}

/** One program's run, as a remote runtime starts it. */
function run(machine: ContainerMachine, argv: string[]): Promise<RunResult> {
  const ctx: Context = { stdin: null, flags: {}, env: {}, cwd: PathSpec.fromStrPath('/') }
  return machine.run(argv, ctx, null, null, null)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ContainerMachine exec', () => {
  it("runs argv under the prelude with the cwd as $1, never as exec's own", async () => {
    const { box, machine } = boxed()
    const done = await execArgv(machine, ['echo', 'hi'], null, { env: { A: '1' }, cwd: '/data' })
    expect(done.exitCode).toBe(0)
    expect(box.execs[0]?.argv).toEqual(['/bin/sh', '-c', EXEC_PRELUDE, 'sh', '/data', 'echo', 'hi'])
    expect(box.execs[0]?.options).toEqual({ env: { A: '1' }, ...PIPES })
  })

  it('pipes stdin and closes it at once for a line with no input', async () => {
    const { box, machine } = boxed({ cat })
    const done = await execArgv(machine, ['cat'])
    expect([done.exitCode, done.stdout.byteLength]).toEqual([0, 0])
    expect(box.ran('cat')).toMatchObject({ closed: true, input: new Uint8Array() })
  })

  it('delivers input byte for byte, then closes stdin', async () => {
    const { box, machine } = boxed({ cat })
    const done = await execArgv(machine, ['cat'], ODD)
    expect(done.stdout).toEqual(ODD)
    expect(box.ran('cat')).toMatchObject({ closed: true, input: ODD, overlapped: false })
  })

  it('streams stdout and stderr apart and returns the exit code', async () => {
    const { machine } = boxed({
      both: async (proc) => {
        await proc.say('out-1 ')
        await proc.complain('err-1')
        await proc.say(ODD)
        return 7
      },
    })
    const [out, err]: [Uint8Array[], Uint8Array[]] = [[], []]
    const done = await execArgv(machine, ['both'], null, {
      output: (data) => Promise.resolve(void out.push(data)),
      errors: (data) => Promise.resolve(void err.push(data)),
    })
    expect(concat(out)).toEqual(concat([ENC.encode('out-1 '), ODD]))
    expect(DEC.decode(concat(err))).toBe('err-1')
    expect(done).toEqual({ stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 7 })
  })

  it('returns what no sink took', async () => {
    const { machine } = boxed({
      both: async (proc) => {
        await proc.say('out')
        await proc.complain('err')
        return 0
      },
    })
    const done = await execArgv(machine, ['both'])
    expect([DEC.decode(done.stdout), DEC.decode(done.stderr ?? undefined)]).toEqual(['out', 'err'])
  })

  it('ends a line by its exit status when the program closes its input early', async () => {
    const { box, machine } = boxed({
      head: async (proc) => {
        proc.deaf = true
        await proc.say('a')
        await new Promise((resolve) => setTimeout(resolve, 10))
        return 0
      },
    })
    const done = await execArgv(machine, ['head'], ODD)
    expect([done.exitCode, DEC.decode(done.stdout)]).toEqual([0, 'a'])
    expect(box.ran('head').killed).toEqual([])
  })

  it('fails a line whose input fails, and kills its command', async () => {
    const { box, machine } = boxed({ cat })
    const input = (async function* (): AsyncGenerator<Uint8Array> {
      yield ODD
      await Promise.resolve()
      throw new Error('the upstream stage failed')
    })()
    await expect(execArgv(machine, ['cat'], input)).rejects.toThrow('the upstream stage failed')
    expect(box.log).toContain('kill 9 cat')
  })

  it('kills an aborted line, then stops it by its own tag', async () => {
    const { box, machine } = boxed({ sleep })
    const abort = new AbortController()
    const line = machine.execLine('sleep 60', null, {}, '/', abort.signal)
    const rejected = expect(line).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => {
      expect(box.execs).toHaveLength(1)
    })
    abort.abort()
    await rejected
    const tag = box.execs[0]?.options?.env?.[PROCESS] ?? ''
    expect(tag).toMatch(/^[0-9a-f]{32}$/)
    expect(box.log).toEqual([
      'exec sleep 60',
      'kill 9 sleep 60',
      `exec ${CHECK_LINE}`,
      `exec ${stopLine(tag, 15)}`,
    ])
  })

  it('stops a tagged run that fails by its tag', async () => {
    const { box, machine } = boxed({
      loud: async (proc) => {
        await proc.say('x')
        return sleep(proc)
      },
    })
    const failed = execArgv(machine, ['loud'], null, {
      env: { [PROCESS]: 'w1:7' },
      output: () => Promise.reject(new Error('the sink refused')),
    })
    await expect(failed).rejects.toThrow('the sink refused')
    expect(box.log).toContain('kill 9 loud')
    expect(box.log.at(-1)).toBe(`exec ${stopLine('w1:7', 15)}`)
  })
})

describe('ContainerMachine pipe', () => {
  it('passes bytes both ways, each write landing before the next', async () => {
    const { box, machine } = boxed({ cat })
    const pipe = await machine.openPipe('cat')
    expect(box.execs[0]).toMatchObject({ argv: ['/bin/sh', '-c', 'cat'], options: PIPES })
    pipe.writer.write(ODD)
    pipe.writer.write(ENC.encode('second'))
    pipe.writer.write(ODD)
    pipe.writer.end()
    expect(await readAll(pipe.reader)).toEqual(concat([ODD, ENC.encode('second'), ODD]))
    expect(box.ran('cat').overlapped).toBe(false)
  })

  it('copies a write, which the caller may reuse', async () => {
    const { machine } = boxed({ cat })
    const pipe = await machine.openPipe('cat')
    const data = ENC.encode('kept')
    pipe.writer.write(data)
    data.fill(0)
    pipe.writer.end()
    expect(DEC.decode(await readAll(pipe.reader))).toBe('kept')
  })

  it('stops by TERM and waits for the command to exit', async () => {
    const { box, machine } = boxed({ sleep })
    const pipe = await machine.openPipe('sleep 60')
    await pipe.stop()
    expect(box.ran('sleep 60')).toMatchObject({ killed: [15], exited: true })
  })

  it('says the end of what the command wrote on stderr', async () => {
    const tail = 'sshfs: bad mount point'
    const { machine } = boxed({
      sshfs: async (proc) => {
        await proc.complain('x'.repeat(PIPE_DIAGNOSTIC_BYTES))
        await proc.complain(`${tail}\n`)
        return 1
      },
    })
    const pipe = await machine.openPipe('sshfs')
    expect(await pipe.diagnostic?.()).toBe(
      'x'.repeat(PIPE_DIAGNOSTIC_BYTES - tail.length - 1) + tail,
    )
  })

  it('ends the pipe at a write the command did not take, sending nothing after it', async () => {
    const { box, machine } = boxed({
      deaf: (proc) => {
        proc.deaf = true
        return sleep(proc)
      },
    })
    const pipe = await machine.openPipe('deaf')
    pipe.writer.write(ODD)
    pipe.writer.write(ODD)
    pipe.writer.end()
    expect((await readAll(pipe.reader)).byteLength).toBe(0)
    expect(box.ran('deaf')).toMatchObject({ killed: [15], writes: 1, closed: false })
  })

  it('kills a command that ignores TERM, so a stop always returns', async () => {
    const { box, machine } = boxed({
      stubborn: (proc) => {
        proc.stubborn = true
        return sleep(proc)
      },
    })
    const pipe = await machine.openPipe('stubborn')
    await pipe.stop()
    expect(box.ran('stubborn')).toMatchObject({ killed: [15, 9], exited: true })
  })

  it('loses the connection when the pipe cannot start', async () => {
    const { box, start, machine } = boxed()
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    box.refusals.push(new Error('container exited'))
    await expect(machine.openPipe('cat')).rejects.toBeInstanceOf(ConnectionLostError)
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    expect(start).toHaveBeenCalledTimes(2)
  })
})

describe('ContainerMachine connection', () => {
  const lost = `cloudflare_container: ${STOPPED}\nmirage: cloudflare_container:box: connection lost\n`

  it('starts the container once, before the first line', async () => {
    const { box, start, machine } = boxed()
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    expect(start).toHaveBeenCalledTimes(1)
    expect(box.log).toEqual([`exec ${CHECK_LINE}`, 'exec true', 'exec true'])
  })

  it('waits for a starting container to answer the check line', async () => {
    const { box, start, machine } = boxed()
    box.refusals.push(new Error('container is not running'))
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    expect([start.mock.calls.length, box.asked]).toEqual([1, 3])
  })

  it('gives up on a container that never answers', async () => {
    vi.useFakeTimers()
    const { box, machine } = boxed()
    box.down = new Error('container is not running')
    const failed = expect(machine.connect()).rejects.toThrow(
      `cloudflare_container: the container did not answer within ${String(CHECK_WAIT_SECONDS)}s of starting`,
    )
    await vi.advanceTimersByTimeAsync((CHECK_WAIT_SECONDS + 1) * 1000)
    await failed
  })

  it('gives up on a container whose exec never returns', async () => {
    const { box, machine } = boxed()
    box.hung = true
    const soon = AbortSignal.timeout(20)
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(soon)
    await expect(machine.connect()).rejects.toThrow(`cloudflare_container: ${NOT_ANSWERING}`)
  })

  it('loses the connection when exec rejects, and the next run starts the container again', async () => {
    const { box, start, machine } = boxed()
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    box.refusals.push(new Error('container exited'))
    const cut = await run(machine, ['true'])
    expect([cut.exitCode, DEC.decode(cut.stderr ?? undefined)]).toEqual([129, lost])
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['with an error', new Error('container exited with code 137')],
    ['cleanly', undefined],
  ])('loses the connection when the container exits %s mid-run', async (_how, error) => {
    const { box, start, machine } = boxed({ sleep })
    const running = run(machine, ['sleep', '60'])
    await vi.waitFor(() => {
      expect(box.log).toContain('exec sleep 60')
    })
    box.exit(error)
    const cut = await running
    expect([cut.exitCode, DEC.decode(cut.stderr ?? undefined)]).toEqual([129, lost])
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('loses the connection when a command the container ran rejects', async () => {
    const { start, machine } = boxed({
      boom: () => {
        throw new Error('the exec stream was reset')
      },
    })
    const cut = await run(machine, ['boom'])
    expect([cut.exitCode, DEC.decode(cut.stderr ?? undefined)]).toEqual([129, lost])
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('starts no stopped container to close the workspace', async () => {
    const { box, start, machine } = boxed()
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    box.exit()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await machine.close()
    expect([start.mock.calls.length, box.asked]).toEqual([1, 2])
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('starts a container that stopped between lines again, losing no line', async () => {
    const { box, start, machine } = boxed()
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    box.exit()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await run(machine, ['true'])).exitCode).toBe(0)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('fails to connect without a container, saying how to build one', async () => {
    const built = buildMachine('box', { provider: 'cloudflare_container', mountType: 'ssh' })
    expect(built).toBeInstanceOf(ContainerMachine)
    await expect(run(built as ContainerMachine, ['true'])).rejects.toThrow(
      'cloudflare_container runs in the Durable Object that owns the container: ' +
        'build it with new ContainerMachine(name, config, ctx.container, start)',
    )
  })

  it('takes no image, instance or network: those are the host’s', () => {
    expect(() => buildMachine('box', { provider: 'cloudflare_container', image: 'x' })).toThrow(
      "unknown machine config key 'image'",
    )
  })

  it('fails a line with the error start threw', async () => {
    const box = new FakeContainer()
    const quota = 'monthly container time is used up for this team; it resets on the 1st'
    const machine = new ContainerMachine('box', {}, box, () => Promise.reject(new Error(quota)))
    await expect(run(machine, ['true'])).rejects.toThrow(quota)
    expect(box.asked).toBe(0)
  })
})

// One SFTP v3 packet: its length, type and body.
function packet(kind: number, ...parts: (number | string | Uint8Array)[]): Uint8Array {
  const body = parts.map((part) => {
    if (part instanceof Uint8Array) return part
    const out = Buffer.alloc(4)
    if (typeof part === 'number') {
      out.writeUInt32BE(part)
      return out
    }
    out.writeUInt32BE(Buffer.byteLength(part))
    return Buffer.concat([out, Buffer.from(part)])
  })
  const head = Buffer.alloc(5)
  head.writeUInt32BE(body.reduce((sum, part) => sum + part.length, 1))
  head.writeUInt8(kind, 4)
  return concat([head, ...body])
}

const FXP = { INIT: 1, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6 }

/** The sshfs in a fake container: an SFTP client over its exec's pipes. */
class Sshfs {
  private got: Uint8Array = new Uint8Array()
  private wake: () => void = () => undefined

  constructor(private readonly proc: FakeProcess) {
    proc.onInput = (chunk) => {
      this.got = concat([this.got, chunk])
      this.wake()
    }
  }

  /** Send one request and return its answer's body, past the request id. */
  async request(kind: number, ...parts: (number | string | Uint8Array)[]): Promise<Uint8Array> {
    await this.proc.say(packet(kind, ...parts))
    const size = (): number => Buffer.from(this.got).readUInt32BE(0)
    while (this.got.length < 4 || this.got.length < 4 + size()) {
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
    const answer = this.got.slice(4 + 1 + 4, 4 + size())
    this.got = this.got.slice(4 + size())
    return answer
  }
}

// sh -c's own reading of a single-quoted word, enough for the mount lines.
function words(line: string): string[] {
  return [...line.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '')
}

// The sshfs source a mount line asks after.
function source(line: string): string {
  return / S='([^']*)' /.exec(line)?.[1] ?? ''
}

/**
 * A container that mounts what it is served, as one with sshfs does, and
 * runs `job` as its python3 over those mounts.
 */
function mounting(job: (fs: Sshfs, proc: FakeProcess) => Promise<number>): FakeContainer {
  const table = new Map<string, string>()
  const mounted = deferred<Sshfs>()
  return new FakeContainer({
    cat: async (proc) => {
      if (proc.line === 'cat /proc/mounts') {
        await proc.say([...table].map(([at, from]) => `${from} ${at} fuse.sshfs rw 0 0\n`).join(''))
        return 0
      }
      return [...table.values()].includes(source(proc.line)) ? 0 : 1
    },
    fusermount3: (proc) => {
      table.delete(words(proc.line)[2] ?? '')
      return 0
    },
    exec: async (proc) => {
      table.set(words(proc.line)[6] ?? '', words(proc.line)[5] ?? '')
      const fs = new Sshfs(proc)
      await fs.request(FXP.INIT, 3)
      mounted.resolve(fs)
      return sleep(proc)
    },
    python3: async (proc) => job(await mounted.promise, proc),
  })
}

describe('ContainerMachine in a workspace', () => {
  it('runs a captured program over the files Mirage serves it', async () => {
    const box = mounting(async (fs, proc) => {
      const from = await fs.request(FXP.OPEN, 1, '/data/in.txt', OPEN.READ, 0)
      await proc.say((await fs.request(FXP.READ, 2, from, 0, 0, 100)).slice(4))
      await fs.request(FXP.CLOSE, 3, from)
      const to = await fs.request(
        FXP.OPEN,
        4,
        '/data/out.txt',
        OPEN.WRITE | OPEN.CREAT | OPEN.TRUNC,
        0,
      )
      await fs.request(FXP.WRITE, 5, to, 0, 0, 'written in the container')
      await fs.request(FXP.CLOSE, 6, to)
      return 0
    })
    const start = vi.fn(() => Promise.resolve())
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        machines: { box: new ContainerMachine('box', { mountType: 'ssh' }, box, start) },
        runtimes: [new RemoteRuntime({ machine: 'box', captures: ['python3'] }), 'workspace'],
      },
    )
    try {
      await ws.vfs.write('/data/in.txt', 'seeded on the host')
      const done = await ws.shell('python3 job.py')
      expect([done.exitCode, done.stdoutText, done.stderrText]).toEqual([
        0,
        'seeded on the host',
        '',
      ])
      expect(DEC.decode(await ws.vfs.read('/data/out.txt'))).toBe('written in the container')
      expect(start).toHaveBeenCalledTimes(1)
    } finally {
      await ws.close()
    }
  })
})
