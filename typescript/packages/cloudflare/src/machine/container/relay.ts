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

import {
  RELAY_EXEC,
  RELAY_HEARTBEAT_SECONDS,
  RELAY_MONITOR,
  RELAY_START,
  RELAY_TOKEN,
  STDERR_CHANNEL,
  STDOUT_CHANNEL,
} from '@struktoai/mirage-core/machine/cloudflare_container/constants'
import { bytesOf, frameOf } from '@struktoai/mirage-core/machine/cloudflare_container/relay'
import type {
  Container,
  ExecProcess,
  RelayEvent,
  RelayRequest,
  RelaySocket,
} from '@struktoai/mirage-core/machine/cloudflare_container/types'
import { logger } from '@struktoai/mirage-core/machine/handle'
import { concat } from '@struktoai/mirage-core/utils/bytes'

const ENC = new TextEncoder()
const PIPES = { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } as const

/** A Durable Object's container: what `ContainerRelay` drives, and how it starts one. */
export interface RelayedContainer extends Container {
  readonly running: boolean
  start(options?: unknown): void
}

/** The part of a Durable Object namespace `relayFetch` routes through. */
export interface RelayNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

/** Whether two tokens are the same, in time that does not depend on where they differ. */
function same(given: string, expected: string): boolean {
  const [a, b] = [ENC.encode(given), ENC.encode(expected)]
  let differ = a.length ^ b.length
  for (let at = 0; at < b.length; at++) differ |= (a[at] ?? 0) ^ (b[at] ?? 0)
  return differ === 0
}

/** The request a socket's first frame makes, or null for a frame that is not one. */
function requestOf(frame: Readonly<Record<string, unknown>>): RelayRequest | null {
  const { token, argv, env } = frame
  if (typeof token !== 'string') return null
  if (argv !== undefined && !(Array.isArray(argv) && argv.every((arg) => typeof arg === 'string')))
    return null
  if (
    env !== undefined &&
    !(
      typeof env === 'object' &&
      env !== null &&
      Object.values(env).every((value) => typeof value === 'string')
    )
  )
    return null
  return {
    token,
    ...(argv !== undefined ? { argv } : {}),
    ...(env !== undefined ? { env: env as Record<string, string> } : {}),
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Route a Worker's request for `/<name>/<call>`, under any prefix, to the
 * relay Durable Object named `name`.
 *
 * @param request the Worker's request.
 * @param relays the relay class's Durable Object namespace.
 */
export function relayFetch(request: Request, relays: RelayNamespace): Promise<Response> {
  const [name, call] = new URL(request.url).pathname.split('/').filter(Boolean).slice(-2)
  if (name === undefined || call === undefined)
    return Promise.resolve(new Response('a relay route is /<name>/<call>\n', { status: 404 }))
  return relays.get(relays.idFromName(name)).fetch(request)
}

/**
 * A Durable Object that hands its container to a `cloudflare_container`
 * machine anywhere: Mirage in Node, a browser or another Worker.
 *
 * Bind it with a container in wrangler config and route requests to it
 * with `relayFetch`. `POST <route>/start` starts the container when it is
 * not running; `<route>/exec` and `<route>/monitor` are WebSockets, one per
 * exec and one per watch for the container's exit. Every call carries the
 * token, which must equal the MIRAGE_RELAY_TOKEN secret; without that
 * secret every call is refused.
 *
 * `startContainer` starts it with the image wrangler config names; a
 * subclass overrides it to pass options (network, env, entrypoint).
 */
export class ContainerRelay<Env = unknown> {
  /**
   * @param ctx the Durable Object's state, with its `container`.
   * @param env the Worker's bindings, with the MIRAGE_RELAY_TOKEN secret.
   */
  constructor(
    protected readonly ctx: { readonly container?: RelayedContainer },
    protected readonly env: Env,
  ) {}

  /** Start the container when it is not running. */
  protected startContainer(): Promise<void> {
    const container = this.container()
    if (!container.running) container.start()
    return Promise.resolve()
  }

  /** The container this relay drives. */
  protected container(): RelayedContainer {
    const container = this.ctx.container
    if (container === undefined)
      throw new Error('ContainerRelay needs a container: bind its class to one in wrangler config')
    return container
  }

  async fetch(request: Request): Promise<Response> {
    const call = new URL(request.url).pathname.split('/').filter(Boolean).at(-1)
    if (call === RELAY_START) {
      if (request.method !== 'POST') return new Response('start is a POST\n', { status: 405 })
      const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
      const refusal = this.refusal(bearer)
      if (refusal !== null) return new Response(`${refusal}\n`, { status: 401 })
      try {
        await this.startContainer()
      } catch (error) {
        return new Response(`${message(error)}\n`, { status: 500 })
      }
      return new Response(null, { status: 204 })
    }
    if (call !== RELAY_EXEC && call !== RELAY_MONITOR)
      return new Response(`no relay call ${String(call)}\n`, { status: 404 })
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response(`${call} is a WebSocket\n`, { status: 426 })
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()
    // Recent compatibility dates hand binary frames over as Blobs, which read only asynchronously.
    server.binaryType = 'arraybuffer'
    this.serve(call, server as RelaySocket)
    return new Response(null, { status: 101, webSocket: client })
  }

  /** Why `token` is refused, or null for the relay's own. */
  protected refusal(token: string): string | null {
    const expected = (this.env as Record<string, unknown> | undefined)?.[RELAY_TOKEN]
    if (typeof expected !== 'string' || expected === '')
      return `the relay has no ${RELAY_TOKEN} secret, so it refuses every call`
    return same(token, expected) ? null : 'the relay refused the token'
  }

  /**
   * Serve one socket: its first frame is the request, and a request with
   * the wrong token is refused before anything runs.
   *
   * @param call exec or monitor.
   * @param socket the relay's end of the socket, accepted.
   */
  protected serve(call: string, socket: RelaySocket): void {
    let asked = false
    socket.addEventListener('message', ({ data }) => {
      if (asked) return
      asked = true
      const frame = frameOf(data)
      const refusal = this.refusal(typeof frame?.token === 'string' ? frame.token : '')
      const request = frame === null ? null : requestOf(frame)
      if (
        request === null ||
        refusal !== null ||
        (call === RELAY_EXEC && request.argv === undefined)
      ) {
        say(socket, { refused: refusal ?? 'the first frame is not a request' })
        socket.close(1008, 'refused')
        return
      }
      if (call === RELAY_MONITOR) this.watch(socket)
      else void this.exec(socket, request)
    })
  }

  /** Tell `socket` once the container exits. */
  private watch(socket: RelaySocket): void {
    const quiet = heartbeat(socket)
    this.container()
      .monitor()
      .then(
        () => {
          say(socket, { exited: null })
        },
        (error: unknown) => {
          say(socket, { exited: message(error) })
        },
      )
      .finally(() => {
        clearInterval(quiet)
        socket.close()
      })
  }

  /** Run one exec for `socket`: its stdin from the socket's frames, its output and status back. */
  private async exec(socket: RelaySocket, request: RelayRequest): Promise<void> {
    let proc: ExecProcess
    try {
      proc = await this.container().exec([...(request.argv ?? [])], {
        env: { ...request.env },
        ...PIPES,
      })
    } catch (error) {
      say(socket, { stopped: message(error) })
      socket.close()
      return
    }
    const state = { exited: false, gone: false, pumping: 2 }
    const quiet = heartbeat(socket)
    const readers = [proc.stdout?.getReader(), proc.stderr?.getReader()]
    const input = proc.stdin?.getWriter()
    // One write lands before the next: a program reads its input in order.
    let writing: Promise<void> = Promise.resolve()
    const write = (step: () => Promise<void> | undefined): void => {
      writing = writing.then(step).catch((error: unknown) => {
        logger.debug?.(`cloudflare relay: input not taken: ${message(error)}`)
      })
    }
    const finish = (): void => {
      if (!state.exited || state.pumping > 0 || state.gone) return
      state.gone = true
      clearInterval(quiet)
      socket.close()
    }
    socket.addEventListener('message', ({ data }) => {
      const bytes = bytesOf(data)
      if (bytes !== null) {
        const chunk = bytes.slice()
        write(() => input?.write(chunk))
        return
      }
      const control = frameOf(data)
      if (control?.eof === true) write(() => input?.close())
      else if (typeof control?.kill === 'number') kill(proc, control.kill)
    })
    socket.addEventListener('close', () => {
      state.gone = true
      clearInterval(quiet)
      // A client gone before its process ended leaves nothing to read it.
      if (!state.exited) kill(proc, 9)
      for (const reader of readers) {
        reader?.cancel().catch((error: unknown) => {
          logger.debug?.(`cloudflare relay: output not released: ${message(error)}`)
        })
      }
    })
    say(socket, { started: true })
    const pump = async (
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      channel: number,
      name: 'stdout' | 'stderr',
    ): Promise<void> => {
      try {
        for (;;) {
          if (reader === undefined) break
          const { done, value } = await reader.read()
          if (done) break
          if (!state.gone) socket.send(concat([Uint8Array.of(channel), value]))
        }
        say(socket, { closed: name })
      } catch (error) {
        logger.debug?.(`cloudflare relay: ${name} ended: ${message(error)}`)
        say(socket, { stopped: message(error) })
      } finally {
        state.pumping -= 1
        finish()
      }
    }
    void pump(readers[0], STDOUT_CHANNEL, 'stdout')
    void pump(readers[1], STDERR_CHANNEL, 'stderr')
    proc.exitCode.then(
      (code) => {
        state.exited = true
        say(socket, { exit: code })
        finish()
      },
      (error: unknown) => {
        state.exited = true
        say(socket, { stopped: message(error) })
        state.gone = true
        clearInterval(quiet)
        socket.close()
      },
    )
  }
}

/** Send `event` on `socket`, which may have closed under it. */
function say(socket: RelaySocket, event: RelayEvent): void {
  try {
    socket.send(JSON.stringify(event))
  } catch (error) {
    logger.debug?.(`cloudflare relay: ${JSON.stringify(event)} not sent: ${message(error)}`)
  }
}

/** Keep `socket` speaking while it is quiet; the caller clears the timer. */
function heartbeat(socket: RelaySocket): ReturnType<typeof setInterval> {
  return setInterval(() => {
    say(socket, { alive: true })
  }, RELAY_HEARTBEAT_SECONDS * 1000)
}

function kill(proc: ExecProcess, signal: number): void {
  try {
    proc.kill(signal)
  } catch (error) {
    logger.debug?.(`cloudflare relay: the process was not signalled: ${message(error)}`)
  }
}
