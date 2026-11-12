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

import { judgeSocket } from '@struktoai/mirage-core/io/web/network'
import { currentRequest, type IncomingRequest } from '@struktoai/mirage-core/io/web/request'
import { concat } from '@struktoai/mirage-core/utils/bytes'

/**
 * One TCP connection as a host hands it back: a byte stream each way.
 * Cloudflare's `connect()` (`cloudflare:sockets`) returns one, and so does
 * Deno's.
 */
export interface SocketLike {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  close(): Promise<void>
}

/** Open a TCP connection to `hostname:port`, over TLS when `tls` is set. */
export type Connect = (
  hostname: string,
  port: number,
  tls: boolean,
) => SocketLike | Promise<SocketLike>

export type RespArg = string | number | Uint8Array

export type RespReply = string | number | Uint8Array | null | RespError | RespReply[]

/** An error reply: the server refused one command, and the connection lives on. */
export class RespError extends Error {
  override readonly name: string = 'RespError'
}

const LF = 10
const CRLF = new Uint8Array([13, 10])
const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

interface Target {
  hostname: string
  port: number
  tls: boolean
  username: string
  password: string
  db: number
}

// A redis url: `redis://` in the clear, `rediss://` over TLS, with the
// credentials and database index node and python take from it.
function target(url: string): Target {
  const parsed = new URL(url)
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`a redis url starts redis:// or rediss://, got ${JSON.stringify(url)}`)
  }
  const db = parsed.pathname.replace(/^\//, '')
  return {
    hostname: parsed.hostname,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    tls: parsed.protocol === 'rediss:',
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    db: db === '' ? 0 : Number(db),
  }
}

/** Commands as RESP arrays of bulk strings, back to back for one write. */
export function encode(commands: readonly (readonly RespArg[])[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const args of commands) {
    parts.push(ENCODER.encode(`*${String(args.length)}\r\n`))
    for (const arg of args) {
      const bytes = arg instanceof Uint8Array ? arg : ENCODER.encode(String(arg))
      parts.push(ENCODER.encode(`$${String(bytes.byteLength)}\r\n`), bytes, CRLF)
    }
  }
  return concat(parts)
}

/**
 * RESP2 replies pulled off a byte stream one at a time. A bulk string is
 * copied once into a buffer of its declared size, so a file of many
 * megabytes costs its own bytes rather than a regrowing buffer.
 */
export class ReplyReader {
  private chunk: Uint8Array = new Uint8Array(0)
  private at = 0

  constructor(private readonly source: ReadableStreamDefaultReader<Uint8Array>) {}

  private async more(): Promise<void> {
    const { value, done } = await this.source.read()
    if (done) throw new Error('redis: the server closed the connection')
    this.chunk = value
    this.at = 0
  }

  // One line without its CRLF; RESP lines hold no LF of their own.
  private async line(): Promise<string> {
    const parts: Uint8Array[] = []
    for (;;) {
      if (this.at >= this.chunk.byteLength) await this.more()
      const end = this.chunk.indexOf(LF, this.at)
      if (end === -1) {
        parts.push(this.chunk.subarray(this.at))
        this.at = this.chunk.byteLength
        continue
      }
      parts.push(this.chunk.subarray(this.at, end))
      this.at = end + 1
      const bytes = concat(parts)
      return DECODER.decode(bytes.subarray(0, bytes.byteLength - 1))
    }
  }

  private async bytes(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      if (this.at >= this.chunk.byteLength) await this.more()
      const take = Math.min(n - filled, this.chunk.byteLength - this.at)
      out.set(this.chunk.subarray(this.at, this.at + take), filled)
      filled += take
      this.at += take
    }
    return out
  }

  async reply(): Promise<RespReply> {
    const line = await this.line()
    const rest = line.slice(1)
    switch (line[0]) {
      case '+':
        return rest
      case '-':
        return new RespError(rest)
      case ':':
        return Number(rest)
      case '$': {
        const n = Number(rest)
        if (n < 0) return null
        const data = await this.bytes(n)
        await this.bytes(CRLF.byteLength)
        return data
      }
      case '*': {
        const n = Number(rest)
        if (n < 0) return null
        const items: RespReply[] = []
        for (let i = 0; i < n; i++) items.push(await this.reply())
        return items
      }
      default:
        throw new Error(`redis: unreadable reply ${JSON.stringify(line)}`)
    }
  }
}

interface Waiter {
  resolve(reply: RespReply): void
  reject(err: unknown): void
}

interface Connection {
  readonly socket: SocketLike
  readonly writer: WritableStreamDefaultWriter<Uint8Array>
  readonly waiting: Waiter[]
  failed: unknown
}

/**
 * A redis client over a host's TCP API, speaking RESP2: any redis, Upstash
 * included, at the url node and python take.
 *
 * Commands are pipelined: each call writes at once and its replies come
 * back in order, so many calls in flight cost one round trip. A Worker
 * cancels a socket with the request that opened it, so each request
 * keeps its own connection, let go with the request; a host that binds
 * no request shares one.
 */
export class RespClient {
  // The connection outside any incoming request, shared by every call.
  private shared: Promise<Connection> | null = null
  private perRequest = new WeakMap<IncomingRequest, Promise<Connection>>()

  constructor(
    readonly url: string,
    private readonly connect: Connect,
  ) {}

  private slot(request: IncomingRequest | null): Promise<Connection> | null {
    return request === null ? this.shared : (this.perRequest.get(request) ?? null)
  }

  private setSlot(request: IncomingRequest | null, conn: Promise<Connection> | null): void {
    if (request === null) this.shared = conn
    else if (conn === null) this.perRequest.delete(request)
    else this.perRequest.set(request, conn)
  }

  private connection(): Promise<Connection> {
    const request = currentRequest()
    const current = this.slot(request)
    if (current !== null) return current
    const pending = this.open(() => {
      if (this.slot(request) === pending) this.setSlot(request, null)
    })
    this.setSlot(request, pending)
    pending.catch(() => {
      if (this.slot(request) === pending) this.setSlot(request, null)
    })
    return pending
  }

  private async open(drop: () => void): Promise<Connection> {
    const at = target(this.url)
    const socket = await this.connect(at.hostname, at.port, at.tls)
    const conn: Connection = {
      socket,
      writer: socket.writable.getWriter(),
      waiting: [],
      failed: null,
    }
    void this.read(conn, new ReplyReader(socket.readable.getReader()), drop)
    const hello: RespArg[][] = []
    if (at.password !== '') {
      hello.push(at.username === '' ? ['AUTH', at.password] : ['AUTH', at.username, at.password])
    }
    if (at.db !== 0) hello.push(['SELECT', at.db])
    try {
      for (const reply of await this.send(conn, hello)) {
        if (reply instanceof RespError) throw reply
      }
    } catch (err) {
      await this.fail(conn, err)
      drop()
      throw err
    }
    return conn
  }

  // Hand each reply to the call waiting longest, until the connection ends.
  private async read(conn: Connection, reader: ReplyReader, drop: () => void): Promise<void> {
    try {
      for (;;) {
        const reply = await reader.reply()
        const waiter = conn.waiting.shift()
        if (waiter === undefined) throw new Error('redis: a reply no command asked for')
        waiter.resolve(reply)
      }
    } catch (err) {
      await this.fail(conn, err)
      drop()
    }
  }

  // End a connection: every call still waiting on it fails with `err`.
  private async fail(conn: Connection, err: unknown): Promise<void> {
    if (conn.failed !== null) return
    conn.failed = err
    for (const waiter of conn.waiting.splice(0)) waiter.reject(err)
    try {
      await conn.socket.close()
    } catch (closeErr) {
      console.debug('redis: closing an ended connection', closeErr)
    }
  }

  private send(conn: Connection, commands: readonly (readonly RespArg[])[]): Promise<RespReply[]> {
    if (commands.length === 0) return Promise.resolve([])
    if (conn.failed !== null) return Promise.reject(conn.failed as Error)
    const replies = commands.map(
      () =>
        new Promise<RespReply>((resolve, reject) => {
          conn.waiting.push({ resolve, reject })
        }),
    )
    conn.writer.write(encode(commands)).catch((err: unknown) => this.fail(conn, err))
    return Promise.all(replies)
  }

  /**
   * Run commands as one pipeline: written together, answered in order. A
   * Workers isolate opens the socket past its fetch guard, so the network
   * rule in force is asked here, before every pipeline: a connection one
   * workspace opened is not another's to use under a narrower rule.
   * Elsewhere this is a no-op.
   */
  async pipeline(commands: readonly (readonly RespArg[])[]): Promise<RespReply[]> {
    const at = target(this.url)
    judgeSocket(at.hostname, at.port)
    return this.send(await this.connection(), commands)
  }

  /** Run one command; an error reply throws as `RespError`. */
  async call(...args: RespArg[]): Promise<RespReply> {
    const [reply] = await this.pipeline([args])
    if (reply instanceof RespError) throw reply
    return reply ?? null
  }

  /** Close this request's connection, or the shared one outside a request. */
  async close(): Promise<void> {
    // Another request's connection is let go: closing it from here is I/O
    // a Worker refuses.
    const current = this.slot(currentRequest())
    this.shared = null
    this.perRequest = new WeakMap()
    if (current === null) return
    let conn: Connection
    try {
      conn = await current
    } catch (err) {
      // The open already failed the call that started it; there is nothing
      // left to close.
      console.debug('redis: closing a connection that never opened', err)
      return
    }
    await this.fail(conn, new Error('redis: the client is closed'))
  }
}
