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

import { currentCaller } from '../../context/session_context.ts'
import { feed } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import {
  CHECK_LINE,
  EXEC_PRELUDE,
  PIPE_DIAGNOSTIC_BYTES,
  PIPE_DIAGNOSTIC_WAIT_SECONDS,
  PROCESS,
  STOP_GRACE_SECONDS,
  isRun,
  runTag,
  stopSignal,
} from '../constants.ts'
import { ConnectionLostError } from '../errors.ts'
import { MachineHandle, logger } from '../handle.ts'
import { PIPE_TRANSPORT, type PipeTransport } from '../mixin.ts'
import { registerMachine } from '../registry.ts'
import type { MachinePipe } from '../types.ts'
import type { OutputFn, RunResult } from '../../runtime/types.ts'
import { abortable, makeAbortError, settledWithin, sleep } from '../../utils/abort.ts'
import { concat } from '../../utils/bytes.ts'
import type { ConfigFields } from '../../runtime/config.ts'
import { requireId } from '../config.ts'
import { CONTAINER_CONFIG_FIELDS, type ContainerConfig } from './config.ts'
import {
  BOTH,
  CHECK_POLL_SECONDS,
  CLOSING,
  NO_CONTAINER,
  NOT_ANSWERING,
  START_WAIT_SECONDS,
  STOPPED,
} from './constants.ts'
import { RelayContainer } from './relay.ts'
import type { Container, ExecProcess } from './types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const PIPES = { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } as const

type Piped = ExecProcess & {
  readonly stdin: WritableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
}

/** `proc` with the three pipes its exec asked for. */
function piped(proc: ExecProcess): Piped {
  if (proc.stdin === null || proc.stdout === null || proc.stderr === null)
    throw new Error('cloudflare_container: exec started a process without its pipes')
  return proc as Piped
}

/** The lost connection a container that stopped under a line is. */
function stopped(error: unknown): ConnectionLostError {
  // shortcut: any exec rejection counts as the container having stopped, which Cloudflare's "not running" does; other rejections are untested
  logger.debug?.(`cloudflare_container: the container stopped: ${String(error)}`)
  const lost = new ConnectionLostError(
    STOPPED,
    new Uint8Array(),
    ENC.encode(`cloudflare_container: ${STOPPED}\n`),
  )
  lost.cause = error
  return lost
}

/**
 * Read `reader` to its end: into `sink`, or into the bytes returned when
 * there is none. A read that fails throws what `failed` makes of it.
 *
 * @param reader the stream's reader, which the caller may cancel.
 * @param sink receives each chunk; null keeps them for the result.
 * @param failed what a failed read throws, given its error.
 */
async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sink: OutputFn | null,
  failed: (error: unknown) => unknown = (error) => error,
): Promise<Uint8Array> {
  const kept: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read().catch((error: unknown) => {
      throw failed(error)
    })
    if (done) return concat(kept)
    if (sink === null) kept.push(value)
    else await sink(value)
  }
}

/**
 * A Cloudflare Container: from the Durable Object that owns it, or from
 * anywhere else through a `ContainerRelay`.
 *
 * In the Durable Object, the handle takes its own `ctx.container` and a
 * `start` that starts the container when it is not running; the image,
 * instance type, network and quota are that callback's, never config.
 * Anywhere else, `url` and `token` name a relay route, which takes the
 * same calls over the network (`RelayContainer`). Connecting calls
 * `start`, then waits for the container to answer the check line. Every
 * argv runs through the container's exec under `EXEC_PRELUDE`, its stdin
 * always piped and closed once the input ends, stdout and stderr as the
 * program wrote them. A `mountType` serves the workspace over one more exec
 * whose pipes carry SFTP.
 *
 * A handle with neither fails to connect, saying how to build one. Once
 * the container stops, a line it cut short loses its connection (129), and
 * the next line starts it again.
 */
export class ContainerMachine extends MachineHandle<ContainerConfig> implements PipeTransport {
  static override readonly provider = 'cloudflare_container'
  static override readonly configFields: ConfigFields = CONTAINER_CONFIG_FIELDS
  readonly [PIPE_TRANSPORT] = true as const
  // Settles once the container the last connect reached has exited.
  private exited: Promise<void> | null = null
  // What each exec still running is told when the container exits, and how many exits there have been.
  private readonly running = new Set<() => void>()
  private exits = 0
  // Set while the workspace closes, when nothing starts a container.
  private closing = false
  private readonly container: Container | undefined
  private readonly start: (() => Promise<void>) | undefined
  private readonly relay: RelayContainer | null = null

  /**
   * @param name the machine's name, its key under `machines:`.
   * @param config the environment, how the container sees the workspace,
   *   and outside its Durable Object the relay that reaches it.
   * @param container the Durable Object's own `ctx.container`.
   * @param start starts the container when it is not running.
   */
  constructor(
    name: string,
    config?: ContainerConfig,
    container?: Container,
    start?: () => Promise<void>,
  ) {
    super(name, config, ContainerMachine.configFields)
    const { url, token } = this.config
    if (url === undefined) {
      this.container = container
      this.start = start
      return
    }
    if (container !== undefined) throw new Error(BOTH)
    requireId('cloudflare_container', 'url', url)
    requireId('cloudflare_container', 'token', token)
    const relay = new RelayContainer(url, token ?? '')
    this.relay = relay
    this.container = relay
    this.start = () => relay.start()
  }

  async connect(): Promise<void> {
    if (this.container === undefined) throw new Error(NO_CONTAINER)
    if (this.closing) throw new Error(`cloudflare_container: ${CLOSING}`)
    await this.start?.()
    // shortcut: a start that never comes up fails this line after the wait and the next line starts again; whether starting again at once recovers is untested
    const deadline = AbortSignal.timeout(START_WAIT_SECONDS * 1000)
    let last: unknown = null
    for (
      let waited = 0;
      waited < START_WAIT_SECONDS && !deadline.aborted;
      waited += CHECK_POLL_SECONDS
    ) {
      try {
        const check = this.exec(
          ['/bin/sh', '-c', CHECK_LINE],
          null,
          { ...this.config.env },
          '/',
          null,
          null,
          deadline,
        )
        await abortable(check, deadline)
        // Only now: a container still starting refuses its calls, monitor() among them.
        this.watchExit(this.container)
        return
      } catch (error) {
        last = error
      }
      await sleep(CHECK_POLL_SECONDS * 1000)
    }
    throw new Error(`cloudflare_container: ${NOT_ANSWERING}`, { cause: last })
  }

  /** Have the next line connect, and so start the container, once `container` has exited. */
  private watchExit(container: Container): void {
    const exited: Promise<void> = container
      .monitor()
      .then(
        () => undefined,
        (error: unknown) => {
          logger.debug?.(`cloudflare_container: the container exited: ${String(error)}`)
        },
      )
      .then(() => {
        if (this.exited !== exited) return
        this.exits += 1
        this.disconnected()
        for (const cut of this.running) cut()
      })
    this.exited = exited
  }

  /**
   * Run one argv in the container. What the container itself fails, its
   * exec, its streams or its exit, is the connection lost
   * (`ConnectionLostError`); the latch is the caller's to drop.
   */
  private async exec(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    signal?.throwIfAborted()
    if (this.container === undefined) throw new Error(NO_CONTAINER)
    const runner = currentCaller().process
    const exits = this.exits
    // exec starts from Cloudflare's own PATH and HOME and merges env on top; the image's ENV never reaches it.
    const proc = piped(
      await this.container
        .exec(['/bin/sh', '-c', EXEC_PRELUDE, 'sh', cwd, ...argv], { env, ...PIPES })
        .catch((error: unknown) => {
          throw stopped(error)
        }),
    )
    const state = { exited: false }
    const [out, err] = [proc.stdout.getReader(), proc.stderr.getReader()]
    let cut: () => void = () => undefined
    const gone = new Promise<null>((resolve) => {
      cut = () => {
        resolve(null)
      }
    })
    this.running.add(cut)
    // The container may have exited while exec was starting, before this one listened.
    if (this.exits !== exits) cut()
    try {
      signal?.throwIfAborted()
      const input = proc.stdin.getWriter()
      // A program may close its input early (head): its exit status ends the line, not a write it refused.
      const feeding = feed(
        stdin,
        (chunk) => input.write(chunk),
        () => input.close(),
        () => state.exited,
        () => true,
      )
      feeding.catch((error: unknown) => {
        if (state.exited)
          logger.debug?.(`cloudflare_container: input after the command ended: ${String(error)}`)
      })
      const finished = Promise.all([
        drain(out, output, stopped),
        drain(err, errors, stopped),
        proc.exitCode.catch((error: unknown) => {
          throw stopped(error)
        }),
      ])
      const done = await abortable(
        Promise.race([finished, feeding.then(() => finished), gone]),
        signal,
      )
      if (done === null) throw stopped(new Error('the container exited'))
      return { stdout: done[0], stderr: done[1], exitCode: done[2] }
    } catch (error) {
      if (error instanceof ConnectionLostError) throw error
      try {
        // A tagged command a gentler kill stopped is left to the caller's stop, which sends that signal first.
        if ((env[PROCESS] === undefined && !isRun(argv)) || stopSignal(runner) === null)
          proc.kill(9)
      } catch (cleanupError) {
        logger.debug?.(`cloudflare_container: the command was not killed: ${String(cleanupError)}`)
      }
      if (signal?.aborted === true) throw makeAbortError(signal)
      // The kill stops only the process exec started; the caller stops an abort.
      const tag = isRun(argv) ? runTag(argv) : env[PROCESS]
      if (tag !== undefined) await this.stop(tag, 15)
      throw error
    } finally {
      state.exited = true
      this.running.delete(cut)
      // A line let go stops reading: a child its program left may hold the output open.
      for (const reader of [out, err]) {
        reader.cancel().catch((error: unknown) => {
          logger.debug?.(`cloudflare_container: output not released: ${String(error)}`)
        })
      }
    }
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    try {
      return await this.exec(argv, stdin, env, cwd, output, errors, signal)
    } catch (error) {
      if (error instanceof ConnectionLostError) this.disconnected()
      throw error
    }
  }

  /**
   * Execute one shell line, under a `PROCESS` tag of its own when the
   * caller gave none: an abort kills only the shell exec started, so an
   * aborted line is stopped by that tag.
   *
   * @param line the raw shell line.
   * @param stdin bytes piped into the line.
   * @param env the merged environment.
   * @param cwd the working directory, passed through verbatim.
   * @param signal stops the line.
   */
  override async execLine(
    line: string,
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (env[PROCESS] !== undefined) return super.execLine(line, stdin, env, cwd, signal)
    const tag = crypto.randomUUID().replaceAll('-', '')
    try {
      return await super.execLine(line, stdin, { ...env, [PROCESS]: tag }, cwd, signal)
    } catch (error) {
      if (signal?.aborted === true) await this.stop(tag, 15)
      throw error
    }
  }

  /**
   * Unmount what the container was served, as any machine does, without
   * starting a container that has stopped: what a close would clean up
   * there went with its disk. The watch for its exit ends, and a relay
   * closes its sockets; the next line connects again.
   */
  override async close(): Promise<void> {
    this.closing = true
    try {
      await super.close()
    } finally {
      this.closing = false
      // A watch the close ends is no exit of the container.
      this.exited = null
      await this.relay?.close()
    }
  }

  async openPipe(command: string): Promise<MachinePipe> {
    if (this.container === undefined) throw new Error(NO_CONTAINER)
    const proc = piped(
      await this.container.exec(['/bin/sh', '-c', command], PIPES).catch((error: unknown) => {
        this.disconnected()
        throw stopped(error)
      }),
    )
    const kill = (signal: number): void => {
      try {
        proc.kill(signal)
      } catch (error) {
        logger.debug?.(`cloudflare_container: ${command} was not stopped: ${String(error)}`)
      }
    }
    const input = proc.stdin.getWriter()
    let sent: Promise<void> = Promise.resolve()
    let broken = false
    // One write lands before the next is sent, and one that fails ends the command: bytes after a gap mean nothing.
    const send = (step: () => Promise<void>): void => {
      sent = sent
        .then(() => (broken ? undefined : step()))
        .catch((error: unknown) => {
          broken = true
          logger.debug?.(`cloudflare_container: ${command} took no input: ${String(error)}`)
          kill(15)
        })
    }
    let said: Uint8Array = new Uint8Array()
    const exited = Promise.all([
      drain(proc.stderr.getReader(), (data) => {
        said = concat([said, data]).subarray(-PIPE_DIAGNOSTIC_BYTES)
        return Promise.resolve()
      }),
      proc.exitCode,
    ]).then(
      () => undefined,
      (error: unknown) => {
        logger.debug?.(`cloudflare_container: ${command} ended: ${String(error)}`)
      },
    )
    return {
      reader: proc.stdout,
      writer: {
        write: (data) => {
          const copy = data.slice()
          send(() => input.write(copy))
        },
        end: () => {
          send(() => input.close())
        },
      },
      stop: async () => {
        for (const signal of [15, 9]) {
          kill(signal)
          if (await settledWithin(exited, STOP_GRACE_SECONDS)) return
        }
        logger.debug?.(`cloudflare_container: ${command} did not exit`)
      },
      diagnostic: async () => {
        await settledWithin(exited, PIPE_DIAGNOSTIC_WAIT_SECONDS)
        return DEC.decode(said).trim()
      },
    }
  }
}

registerMachine('cloudflare_container', ContainerMachine)
