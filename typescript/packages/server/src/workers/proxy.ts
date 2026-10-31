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
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import proxyaddr from '@fastify/proxy-addr'
import { isCrossOrigin, isHostAllowed } from '../host_validation.ts'
import { MAX_REQUEST_PART } from '../multipart.ts'
import { COUNTED_HEADER } from '../rate_limit.ts'
import { AUTH_PROBE, UNAVAILABLE } from './constants.ts'
import { answered, discard, headersFor, passable, pathParts, sendAnswer, sendJson } from './http.ts'
import { idOf, peek } from './peek.ts'
import type { Answer, WorkerProxyOptions } from './types.ts'
import type { Worker } from './worker.ts'

/**
 * The daemon's server when it runs workers: it sends each request to the
 * worker holding its workspace and answers health, readiness and lists
 * over all of them. Mirrors Python's `WorkerProxy`.
 */
export class WorkerProxy {
  readonly server: Server
  private draining = false
  private idleTimer: NodeJS.Timeout | null = null
  private readonly startedAt = Date.now() / 1000
  private readonly trust: (addr: string, i: number) => boolean

  constructor(private readonly options: WorkerProxyOptions) {
    const proxies = options.proxies
    this.trust = proxies.includes('*')
      ? () => true
      : proxies.length > 0
        ? proxyaddr.compile([...proxies])
        : () => false
    options.pool.onLost = () => {
      this.idleCheck()
    }
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        console.error('mirage: a worker request failed:', error)
        if (!res.headersSent) sendJson(res, 502, UNAVAILABLE)
        else res.destroy()
      })
    })
    this.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.upgrade(req, socket, head)
    })
  }

  async listen(port: number, host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
  }

  /** Refuse new work, stop the workers and close the server. */
  async close(): Promise<void> {
    this.draining = true
    this.cancelIdle()
    const closed = new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve()
      })
    })
    await this.options.pool.stop()
    this.server.closeAllConnections()
    await closed
  }

  private client(req: IncomingMessage): string {
    return proxyaddr(req, this.trust)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pool } = this.options
    const first = pool.first()
    if (first === undefined) {
      sendJson(res, 502, UNAVAILABLE)
      return
    }
    if (this.refusedHere(req, res)) return
    const url = new URL(req.url ?? '/', 'http://daemon')
    const parts = pathParts(req.url)
    if (parts === null) {
      sendJson(res, 400, { detail: 'path is not percent-encoded' })
      discard(req)
      return
    }
    const method = req.method ?? 'GET'
    if (parts[0] !== 'v1') return this.pass(first, req, res)
    const [, resource, id, action] = parts
    const own = parts.length === 2 && method === 'GET'
    if (own && resource === 'health') {
      sendJson(res, 200, {
        status: 'ok',
        workspaces: pool.count(),
        uptime_s: Math.round((Date.now() / 1000 - this.startedAt) * 1000) / 1000,
        workers: pool.workers.filter((worker) => !worker.dead).length,
      })
      return
    }
    if (own && resource === 'ready') {
      const status = this.draining ? 'shutting_down' : this.hasRoom(1) ? 'ready' : 'full'
      sendJson(res, status === 'ready' ? 200 : 503, { status })
      return
    }
    if (resource === 'shutdown' && parts.length === 2 && method === 'POST') {
      // A worker answers whether the caller may stop the daemon.
      const answer = await this.fetch(first, req, null, true)
      if (answer.status !== 200) {
        sendAnswer(res, answer)
        return
      }
      sendJson(res, 200, { status: 'shutting_down', pid: process.pid })
      this.options.exit()
      return
    }
    if (resource !== 'workspaces') return this.pass(first, req, res)
    if (id === undefined) {
      if (method === 'GET') return this.gather(req, res)
      // An explain builds nothing, so it holds no slot.
      const explain = url.searchParams.get('explain')
      if (method === 'POST' && explain !== null && explain !== 'false') {
        return this.pass(first, req, res)
      }
      if (method === 'POST') return this.create(req, res, null)
      return this.pass(first, req, res)
    }
    if (id === 'load' && parts.length === 3 && method === 'POST') return this.create(req, res, null)
    const home = pool.home(id)
    if (home === undefined || home.dead) return this.pass(first, req, res)
    if (action === 'clone' && parts.length === 4 && method === 'POST') {
      return this.create(req, res, home)
    }
    const deletes = action === undefined && method === 'DELETE'
    const closes = action === 'close' && parts.length === 4 && method === 'POST'
    if (deletes || closes) {
      const answer = await this.fetch(home, req, null, true)
      // A close or delete that fails in the worker may still have removed
      // the workspace. A refusal (4xx) leaves it, and may hide it from this
      // caller, so only a 5xx is checked.
      const gone =
        answer.status < 300 || (answer.status >= 500 && !(await this.holds(home, req, id)))
      if (gone) {
        if (deletes) pool.forget(id)
        else pool.release(id)
        this.idleCheck()
      }
      sendAnswer(res, answer)
      return
    }
    return this.pass(home, req, res)
  }

  /**
   * A create, load or clone: to the worker holding or creating the id it
   * names, else to `source`'s for a clone, else to a worker at random.
   */
  private async create(
    req: IncomingMessage,
    res: ServerResponse,
    source: Worker | null,
  ): Promise<void> {
    const { pool } = this.options
    if (this.draining) {
      sendJson(res, 503, { detail: 'server is shutting down' })
      return
    }
    let reserved = false
    try {
      const refused = await this.refused(req, source ?? pool.first())
      if (refused !== null) {
        sendAnswer(res, refused)
        return
      }
      const peeked = await peek(req)
      if (peeked.lost) {
        sendJson(res, 413, {
          detail: `the workspace id must come in the body's first ${String(MAX_REQUEST_PART)} bytes`,
        })
        return
      }
      if (peeked.twice) {
        sendJson(res, 400, { detail: "multipart body has more than one 'request' part" })
        return
      }
      const home = peeked.id === undefined ? undefined : pool.home(peeked.id)
      const live = home?.live.has(peeked.id ?? '') === true
      // A retry of a live id goes to its worker even when full, but holds a
      // slot too: the worker may close that id first and build it again.
      if (!live && !this.hasRoom(1)) {
        sendJson(res, 503, {
          detail: `server is at max_workspaces (${String(this.options.maxWorkspaces)})`,
        })
        return
      }
      const building = peeked.id === undefined ? undefined : pool.building(peeked.id)
      if (source !== null && building !== undefined && building !== source) {
        sendJson(res, 409, { detail: `workspace id already exists: ${String(peeked.id)}` })
        return
      }
      // A clone builds on its source's worker, so an id another worker
      // holds, even closed, stays there: a create reaches it.
      if (source !== null && home?.dead === false && home !== source) {
        const detail = live
          ? `workspace id already exists: ${String(peeked.id)}`
          : `workspace id was used on another worker; create it there instead: ${String(peeked.id)}`
        sendJson(res, 409, { detail })
        return
      }
      const worker = source ?? (home?.dead === false ? home : undefined) ?? pool.random()
      if (worker === undefined) {
        sendJson(res, 502, UNAVAILABLE)
        return
      }
      // Nothing is awaited between the check above and here, so creates
      // racing each other cannot pass max_workspaces.
      pool.reserved += 1
      reserved = true
      const settle = peeked.id === undefined ? () => undefined : pool.claim(peeked.id, worker)
      this.cancelIdle()
      try {
        const answer = await this.fetch(worker, req, peeked.head, peeked.more, true)
        if (answer.status === 201) {
          const made = idOf(answer.body)
          if (made !== undefined) pool.adopt(made, worker)
        }
        sendAnswer(res, answer)
      } finally {
        settle()
      }
    } finally {
      if (reserved) pool.reserved -= 1
      discard(req)
      this.idleCheck()
    }
  }

  /** The workspace list: every worker's, merged by creation time. */
  private async gather(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const running = this.options.pool.workers.filter((worker) => !worker.dead)
    const answers = await Promise.all(running.map((worker) => this.fetch(worker, req, null)))
    const failed = answers.find((answer) => answer.status !== 200)
    if (failed !== undefined) {
      sendAnswer(res, failed)
      return
    }
    const items = answers.flatMap((answer) => JSON.parse(answer.body.toString()) as unknown[])
    const key = (item: unknown): number =>
      Number((item as Record<string, unknown> | null)?.created_at ?? 0)
    items.sort((a, b) => key(a) - key(b))
    sendJson(res, 200, items)
  }

  /**
   * A worker's refusal of the caller, asked before a body is read: null
   * when the caller may go on.
   */
  private async refused(req: IncomingMessage, worker: Worker | undefined): Promise<Answer | null> {
    if (worker === undefined) return null
    const headers = headersFor(req, this.client(req))
    delete headers['content-length']
    delete headers['content-type']
    const probe = this.open(worker, 'GET', AUTH_PROBE, headers)
    probe.end()
    const answer = await answered(probe)
    return answer.status === 404 ? null : answer
  }

  /**
   * Answer 400 for a Host or a browser Origin the workers refuse, as they
   * would, since the daemon answers some requests itself: true when it did.
   */
  private refusedHere(req: IncomingMessage, res: ServerResponse): boolean {
    const { host, origin, 'sec-fetch-site': fetchSite } = req.headers
    if (!isHostAllowed(host, this.options.allowedHosts)) {
      sendJson(res, 400, { detail: 'Invalid host header' })
      return true
    }
    if (isCrossOrigin(host, origin, fetchSite)) {
      sendJson(res, 400, { detail: 'Cross-origin request refused' })
      return true
    }
    return false
  }

  /** Whether `worker` still holds workspace `id`. */
  private async holds(worker: Worker, req: IncomingMessage, id: string): Promise<boolean> {
    const headers = headersFor(req, this.client(req))
    delete headers['content-length']
    delete headers['content-type']
    headers[COUNTED_HEADER] = this.options.pool.token
    const probe = this.open(worker, 'GET', `/v1/workspaces/${encodeURIComponent(id)}`, headers)
    probe.end()
    return (await answered(probe)).status !== 404
  }

  /** Whether `extra` more workspaces fit under `max_workspaces`. */
  private hasRoom(extra: number): boolean {
    const cap = this.options.maxWorkspaces
    return cap === null || this.options.pool.held() + extra <= cap
  }

  /** Pass a request through to `worker`, streaming both ways. */
  private async pass(worker: Worker, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const upstream = this.open(
      worker,
      req.method ?? 'GET',
      req.url ?? '/',
      headersFor(req, this.client(req)),
    )
    const done = new Promise<void>((resolve, reject) => {
      upstream.once('response', (answer) => {
        res.writeHead(answer.statusCode ?? 502, passable(answer.headers))
        res.flushHeaders()
        answer.pipe(res)
        answer.once('end', resolve)
        answer.once('error', reject)
      })
      upstream.once('error', reject)
    })
    // A client gone before the answer ends stops the worker's side too.
    res.once('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    req.pipe(upstream)
    await done
  }

  /**
   * Send `body`, then the rest of the request when `more`, and read the
   * whole answer.
   */
  private async fetch(
    worker: Worker,
    req: IncomingMessage,
    body: Buffer | null,
    more = false,
    counted = false,
  ): Promise<Answer> {
    const headers = headersFor(req, this.client(req))
    // The caller check counted it already against the rate limits.
    if (counted) headers[COUNTED_HEADER] = this.options.pool.token
    if (!more) {
      if (body === null || body.byteLength === 0) delete headers['content-length']
      else headers['content-length'] = String(body.byteLength)
    }
    const upstream = this.open(worker, req.method ?? 'GET', req.url ?? '/', headers)
    const answer = answered(upstream)
    if (body !== null && body.byteLength > 0) upstream.write(body)
    if (more && !req.readableEnded) req.pipe(upstream)
    else upstream.end()
    return answer
  }

  private open(
    worker: Worker,
    method: string,
    path: string,
    headers: OutgoingHttpHeaders,
  ): ClientRequest {
    return httpRequest({ socketPath: worker.socket, method, path, headers })
  }

  /** A WebSocket's upgrade: the raw connection, to the workspace's worker. */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const { pool } = this.options
    const parts = pathParts(req.url)
    if (parts === null) {
      socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }
    const home =
      parts[1] === 'workspaces' && parts[2] !== undefined ? pool.home(parts[2]) : undefined
    const worker = home?.dead === false ? home : pool.first()
    if (worker === undefined) {
      socket.destroy()
      return
    }
    const upstream: Socket = connect(worker.socket)
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] ?? ''
      if (!['x-forwarded-for', COUNTED_HEADER].includes(name.toLowerCase()))
        lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ''}`)
    }
    lines.push(`X-Forwarded-For: ${this.client(req)}`)
    upstream.once('connect', () => {
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.byteLength > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', (error) => {
      console.debug(`mirage: worker ${String(worker.index)}'s WebSocket failed:`, error)
      socket.destroy()
    })
    socket.on('error', (error) => {
      console.debug("mirage: a client's WebSocket failed:", error)
      upstream.destroy()
    })
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
  }

  /** Exit once no worker holds a workspace for `idleGraceSeconds`. */
  private idleCheck(): void {
    if (this.draining || this.options.pool.held() > 0) return
    if (this.options.idleGraceSeconds <= 0) {
      this.options.exit()
      return
    }
    if (this.idleTimer !== null) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.draining && this.options.pool.held() === 0) this.options.exit()
    }, this.options.idleGraceSeconds * 1000)
  }

  private cancelIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}

/**
 * The daemon's server over a started pool. Mirrors Python's
 * `build_worker_proxy`.
 */
export function buildWorkerProxy(options: WorkerProxyOptions): WorkerProxy {
  return new WorkerProxy(options)
}
