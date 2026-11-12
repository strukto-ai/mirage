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

import { logger } from '../handle.ts'
import {
  RELAY_EXEC,
  RELAY_MONITOR,
  RELAY_START,
  STDERR_CHANNEL,
  STDOUT_CHANNEL,
} from './constants.ts'
import type {
  Container,
  ExecOptions,
  ExecProcess,
  RelayControl,
  RelayRequest,
  RelaySocket,
} from './types.ts'

/**
 * The object a text frame carries, or null for a frame that is not one. Its
 * fields come off the network, so each reader checks the type of the ones
 * it takes.
 */
export function frameOf(data: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof data !== 'string') return null
  try {
    const frame: unknown = JSON.parse(data)
    return typeof frame === 'object' && frame !== null && !Array.isArray(frame)
      ? (frame as Record<string, unknown>)
      : null
  } catch (error) {
    logger.debug?.(`cloudflare_container: a frame that is not an event: ${String(error)}`)
    return null
  }
}

/** The bytes of a binary frame, as a browser, Node, workerd or a test delivers them; null for text. */
export function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}

/** One output stream of a relayed process, fed from its socket. */
class Channel {
  readonly stream: ReadableStream<Uint8Array>
  done = false
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null

  constructor(private readonly finished: () => void) {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
      },
      cancel: () => {
        this.end()
      },
    })
  }

  push(data: Uint8Array): void {
    if (!this.done) this.controller?.enqueue(data)
  }

  close(): void {
    if (this.done) return
    this.controller?.close()
    this.end()
  }

  fail(error: Error): void {
    if (this.done) return
    this.controller?.error(error)
    this.end()
  }

  private end(): void {
    this.done = true
    this.finished()
  }
}

/**
 * A process a relay runs: its stdin sent as binary frames and ended by an
 * `eof`, its output fed from the frames that come back. The socket closes
 * once the process has exited and both its output streams are done; one
 * that closes sooner errors what is still open, as a lost connection.
 */
class RelayProcess implements ExecProcess {
  readonly stdin: WritableStream<Uint8Array>
  readonly exitCode: Promise<number>
  private readonly out = new Channel(() => {
    this.settle()
  })
  private readonly err = new Channel(() => {
    this.settle()
  })
  private exited = false
  private closed = false
  private resolveExit: (code: number) => void = () => undefined
  private rejectExit: (error: Error) => void = () => undefined

  constructor(private readonly socket: RelaySocket) {
    this.exitCode = new Promise<number>((resolve, reject) => {
      this.resolveExit = resolve
      this.rejectExit = reject
    })
    this.exitCode.catch((error: unknown) => {
      logger.debug?.(
        `cloudflare_container: a relayed process ended without its status: ${String(error)}`,
      )
    })
    this.stdin = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.send(chunk.slice())
      },
      close: () => {
        this.control({ eof: true })
      },
      abort: () => {
        this.control({ eof: true })
      },
    })
  }

  get stdout(): ReadableStream<Uint8Array> {
    return this.out.stream
  }

  get stderr(): ReadableStream<Uint8Array> {
    return this.err.stream
  }

  kill(signal = 15): void {
    if (!this.closed) this.control({ kill: signal })
  }

  /** Take one frame the relay sent after `started`. */
  take(data: unknown): void {
    const bytes = bytesOf(data)
    if (bytes !== null) {
      const channel =
        bytes[0] === STDOUT_CHANNEL ? this.out : bytes[0] === STDERR_CHANNEL ? this.err : null
      channel?.push(bytes.slice(1))
      return
    }
    const event = frameOf(data)
    if (event === null) return
    if (event.closed === 'stdout' || event.closed === 'stderr')
      (event.closed === 'stdout' ? this.out : this.err).close()
    else if (typeof event.exit === 'number') {
      this.exited = true
      this.resolveExit(event.exit)
      this.settle()
    } else if (typeof event.stopped === 'string') this.lost(new Error(event.stopped))
  }

  /** The socket closed: whatever is still open lost its connection. */
  lost(error: Error = new Error('the connection to the relay closed')): void {
    this.closed = true
    this.out.fail(error)
    this.err.fail(error)
    if (!this.exited) this.rejectExit(error)
  }

  private send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.closed) throw new Error('the connection to the relay closed')
    this.socket.send(data)
  }

  private control(control: RelayControl): void {
    this.send(JSON.stringify(control))
  }

  private settle(): void {
    if (this.exited && this.out.done && this.err.done && !this.closed) {
      this.closed = true
      this.socket.close()
    }
  }
}

/**
 * A Cloudflare Container reached through a `ContainerRelay`, from anywhere
 * that has `fetch` and `WebSocket`: Node, a browser or another Worker.
 *
 * `url` is the relay route that names the container. `start` is one POST;
 * each exec and each monitor is a socket of its own whose first frame
 * carries the token. A socket that closes before its process exits is a
 * lost connection, as an exec on a container that stopped is.
 */
export class RelayContainer implements Container {
  private readonly base: string

  /**
   * @param url the relay route that names the container.
   * @param token the relay's token.
   */
  constructor(
    url: string,
    private readonly token: string,
  ) {
    this.base = url.replace(/\/+$/, '')
  }

  /** Start the container when it is not running; a refusal fails with the relay's words. */
  async start(): Promise<void> {
    const response = await this.post(`${this.base}/${RELAY_START}`)
    if (response.ok) return
    const said = (await response.text()).trim()
    throw new Error(
      `cloudflare_container: the relay answered ${String(response.status)} to start` +
        (said === '' ? '' : `: ${said}`),
    )
  }

  async exec(cmd: string[], options?: ExecOptions): Promise<ExecProcess> {
    const socket = await this.openSocket(`${this.base}/${RELAY_EXEC}`)
    const proc = new RelayProcess(socket)
    return new Promise<ExecProcess>((resolve, reject) => {
      let started = false
      socket.addEventListener('message', ({ data }) => {
        if (started) {
          proc.take(data)
          return
        }
        const event = frameOf(data)
        if (event === null) return
        const refusal = event.stopped ?? event.refused
        if (event.started === true) {
          started = true
          resolve(proc)
        } else if (typeof refusal === 'string') {
          socket.close()
          reject(new Error(refusal))
        }
      })
      socket.addEventListener('close', () => {
        proc.lost()
        reject(new Error('the relay closed the exec before it started'))
      })
      const request: RelayRequest = { token: this.token, argv: cmd, env: options?.env ?? {} }
      socket.send(JSON.stringify(request))
    })
  }

  async monitor(): Promise<void> {
    const socket = await this.openSocket(`${this.base}/${RELAY_MONITOR}`)
    return new Promise<void>((resolve, reject) => {
      socket.addEventListener('message', ({ data }) => {
        const event = frameOf(data)
        if (event === null) return
        if (typeof event.refused === 'string') {
          socket.close()
          reject(new Error(event.refused))
        } else if (event.exited === null || typeof event.exited === 'string') {
          socket.close()
          if (event.exited === null) resolve()
          else reject(new Error(event.exited))
        }
      })
      socket.addEventListener('close', () => {
        reject(new Error('the relay closed the monitor'))
      })
      const request: RelayRequest = { token: this.token }
      socket.send(JSON.stringify(request))
    })
  }

  // The network as two seams: tests substitute an in-memory relay here.
  protected post(url: string): Promise<Response> {
    return fetch(url, { method: 'POST', headers: { authorization: `Bearer ${this.token}` } })
  }

  protected openSocket(url: string): Promise<RelaySocket> {
    const socket = new WebSocket(url.replace(/^http/, 'ws'))
    socket.binaryType = 'arraybuffer'
    return new Promise<RelaySocket>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve(socket)
      })
      socket.addEventListener('error', () => {
        reject(new Error(`could not reach the relay at ${url}`))
      })
    })
  }
}
