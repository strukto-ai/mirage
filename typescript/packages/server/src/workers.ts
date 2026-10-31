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

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker as Thread } from 'node:worker_threads'
import proxyaddr from '@fastify/proxy-addr'
import { DaemonConfigError, readDaemonTable } from './daemon_config.ts'
import { ENV_FORWARDED_ALLOW_IPS, ENV_WORKER_SOCKET, ENV_WORKER_TYPE, ENV_WORKERS } from './env.ts'
import { MAX_REQUEST_PART, partEvents } from './multipart.ts'
import { mirageHome } from './paths.ts'

// How long a worker has to answer its health check once started.
const READY_SECONDS = 60
// How long a stopped worker has to exit before it is killed, past the
// graceful timeout it drains for.
const EXIT_SECONDS = 10
// A request that needs no workspace and answers only a signed-in caller:
// what a worker says to it says whether the caller may go on.
const AUTH_PROBE = '/v1/jobs?workspace_id=-'
// What a request gets when no worker can answer it.
const UNAVAILABLE = { detail: 'worker unavailable' }
// Headers that belong to one connection, which are not passed on.
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** What a worker is: a process of its own, or a thread of the daemon's. */
export enum WorkerType {
  Process = 'process',
  Thread = 'thread',
}

/**
 * How many workers the daemon runs: `workers` when given, else
 * `$MIRAGE_WORKERS`, else the `workers` key in config.toml's `[daemon]`
 * table, else 1, a daemon that holds every workspace itself. Mirrors
 * Python's `resolve_workers`.
 */
export function resolveWorkers(
  workers?: number | null,
  env: Record<string, string | undefined> = process.env,
): number {
  let value: string | number | undefined = workers ?? undefined
  if (value === undefined) {
    const fromEnv = env[ENV_WORKERS]
    value =
      fromEnv !== undefined && fromEnv !== '' ? fromEnv : readDaemonTable(mirageHome(env)).workers
    if (value === undefined || value === '') return 1
  }
  const count = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : 0
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new DaemonConfigError(
      `workers must be a positive whole number, got ${JSON.stringify(value)}`,
    )
  }
  return count
}

/**
 * What the workers are: `workerType` when given, else
 * `$MIRAGE_WORKER_TYPE`, else the `worker_type` key in config.toml's
 * `[daemon]` table, else threads, each with an event loop of its own.
 * Mirrors Python's `resolve_worker_type`.
 */
export function resolveWorkerType(
  workerType?: string | null,
  env: Record<string, string | undefined> = process.env,
): WorkerType {
  let value = workerType ?? undefined
  if (value === undefined) {
    const fromEnv = env[ENV_WORKER_TYPE]
    value =
      fromEnv !== undefined && fromEnv !== ''
        ? fromEnv
        : readDaemonTable(mirageHome(env)).worker_type
    if (value === undefined || value === '') return WorkerType.Thread
  }
  const type = Object.values(WorkerType).find((known) => known === (value as WorkerType))
  if (type !== undefined) return type
  throw new DaemonConfigError(`worker_type must be process or thread, got ${JSON.stringify(value)}`)
}

export interface WorkerOptions {
  index: number
  /** The Unix socket it serves on. */
  socket: string
  /** The daemon's entry, which runs as the worker. */
  entry: string
  /**
   * Node's flags for the worker; undefined takes the daemon's. A thread
   * cannot take V8 flags such as `--max-old-space-size` here.
   */
  execArgv?: readonly string[]
  env: Record<string, string | undefined>
  /** A Host the worker accepts, for its health check. */
  host: string
}

/**
 * One worker: the whole server, on a socket of its own. A worker that
 * exits stays gone, and so do its workspaces. Mirrors Python's `Worker`.
 */
export abstract class Worker {
  /** The ids of the workspaces it holds. */
  readonly live = new Set<string>()
  dead = false
  onExit: () => void = () => undefined

  constructor(readonly options: WorkerOptions) {}

  get index(): number {
    return this.options.index
  }

  get socket(): string {
    return this.options.socket
  }

  /** Start it and wait until it answers. */
  async start(): Promise<void> {
    this.launch({
      ...this.options.env,
      [ENV_WORKER_SOCKET]: this.socket,
      [ENV_WORKERS]: '1',
      // Only the daemon reaches a worker's socket, and it names the
      // client it served.
      [ENV_FORWARDED_ALLOW_IPS]: '*',
    })
    const deadline = Date.now() + READY_SECONDS * 1000
    for (;;) {
      if (this.dead) throw new Error(`mirage: worker ${String(this.index)} exited as it started`)
      if (await answers(this.socket, this.options.host)) return
      if (Date.now() > deadline) {
        await this.stop(0)
        throw new Error(`mirage: worker ${String(this.index)} did not answer`)
      }
      await delay(100)
    }
  }

  /** Stop it: it drains for `gracefulTimeout`, then exits or is ended. */
  abstract stop(gracefulTimeout: number): Promise<void>

  protected abstract launch(env: Record<string, string | undefined>): void

  protected exited(code: number | null): void {
    if (this.dead) return
    this.dead = true
    this.onExit()
    if (code !== 0) console.error(`mirage: worker ${String(this.index)} exited (${String(code)})`)
  }
}

/** A worker in a process of its own. Mirrors Python's `ProcessWorker`. */
class ProcessWorker extends Worker {
  private child: ChildProcess | null = null

  protected launch(env: Record<string, string | undefined>): void {
    const execArgv = this.options.execArgv ?? process.execArgv
    const child = spawn(process.execPath, [...execArgv, this.options.entry], {
      env,
      // A worker exits when its stdin closes: the daemon is gone.
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    this.child = child
    child.once('exit', (code) => {
      this.exited(code)
    })
    child.once('error', (error) => {
      console.error(`mirage: worker ${String(this.index)} did not start:`, error)
      this.exited(null)
    })
  }

  async stop(gracefulTimeout: number): Promise<void> {
    const child = this.child
    if (child === null || this.dead) return
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => {
        resolve()
      }),
    )
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), (gracefulTimeout + EXIT_SECONDS) * 1000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * A worker on a thread of the daemon's, with an event loop of its own.
 * Mirrors Python's `ThreadWorker`.
 */
class ThreadWorker extends Worker {
  private thread: Thread | null = null

  protected launch(env: Record<string, string | undefined>): void {
    const { execArgv } = this.options
    const thread = new Thread(this.options.entry, {
      env,
      ...(execArgv === undefined ? {} : { execArgv: [...execArgv] }),
      workerData: { socket: this.socket },
    })
    this.thread = thread
    thread.once('exit', (code) => {
      this.exited(code)
    })
    thread.once('error', (error) => {
      console.error(`mirage: worker ${String(this.index)} failed:`, error)
    })
  }

  async stop(gracefulTimeout: number): Promise<void> {
    const thread = this.thread
    if (thread === null || this.dead) return
    const exited = new Promise<void>((resolve) =>
      thread.once('exit', () => {
        resolve()
      }),
    )
    thread.postMessage('stop')
    const timer = setTimeout(() => void thread.terminate(), (gracefulTimeout + EXIT_SECONDS) * 1000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface WorkerPoolOptions {
  count: number
  type: WorkerType
  /** The daemon's entry, which each worker runs. */
  entry: string
  /**
   * Node's flags for each worker; undefined takes the daemon's. A thread
   * cannot take V8 flags such as `--max-old-space-size` here.
   */
  execArgv?: readonly string[]
  env: Record<string, string | undefined>
  /** A Host the workers accept, for their health checks. */
  host: string
  /** How long a stopped worker drains its lines for. */
  gracefulTimeout: number
}

/**
 * The workers and which holds each workspace. A workspace's worker
 * outlives its close, so its jobs and a create under its id reach the
 * worker that has them; a delete forgets it. Mirrors Python's
 * `WorkerPool`.
 */
export class WorkerPool {
  readonly workers: Worker[]
  /** Creates being answered, each holding a slot under `max_workspaces`. */
  reserved = 0
  /** Called when a worker's workspaces are gone with it. */
  onLost: () => void = () => undefined
  private readonly homes = new Map<string, Worker>()
  /** The worker each id being created goes to, until its create ends. */
  private readonly pending = new Map<string, Worker>()
  private readonly directory: string
  private stopping = false

  constructor(private readonly options: WorkerPoolOptions) {
    this.directory = mkdtempSync(join(tmpdir(), 'mirage-workers-'))
    const Kind = options.type === WorkerType.Process ? ProcessWorker : ThreadWorker
    this.workers = Array.from({ length: options.count }, (_, index) => {
      const worker = new Kind({
        index,
        socket: join(this.directory, `${String(index)}.sock`),
        entry: options.entry,
        execArgv: options.execArgv,
        env: options.env,
        host: options.host,
      })
      worker.onExit = () => {
        this.lost(worker)
      }
      return worker
    })
  }

  /** Start every worker and wait until each answers. */
  async start(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.start()))
  }

  /** Stop every worker: each drains, then exits or is ended. */
  async stop(): Promise<void> {
    this.stopping = true
    await Promise.all(this.workers.map((worker) => worker.stop(this.options.gracefulTimeout)))
    rmSync(this.directory, { recursive: true, force: true })
  }

  /** The first worker still running, which answers what no workspace owns. */
  first(): Worker | undefined {
    return this.workers.find((worker) => !worker.dead)
  }

  /** A worker still running, at random: where a new workspace goes. */
  random(): Worker | undefined {
    const running = this.workers.filter((worker) => !worker.dead)
    return running[Math.floor(Math.random() * running.length)]
  }

  /** The worker holding, last holding or now creating `id`, else undefined. */
  home(id: string): Worker | undefined {
    return this.homes.get(id) ?? this.pending.get(id)
  }

  /** Send the creates of `id` to `worker` until `settle` is called. */
  claim(id: string, worker: Worker): () => void {
    this.pending.set(id, worker)
    return () => {
      if (this.pending.get(id) === worker) this.pending.delete(id)
    }
  }

  /** Record `id` as held by `worker`. */
  adopt(id: string, worker: Worker): void {
    if (worker.dead) return
    const previous = this.homes.get(id)
    if (previous !== undefined && previous !== worker) previous.live.delete(id)
    this.homes.set(id, worker)
    worker.live.add(id)
  }

  /** Record `id` as closed: its worker stays its home. */
  release(id: string): void {
    this.homes.get(id)?.live.delete(id)
  }

  /** Record `id` as deleted. */
  forget(id: string): void {
    this.release(id)
    this.homes.delete(id)
  }

  /** How many workspaces the workers hold, those being created among them. */
  held(): number {
    return this.count() + this.reserved
  }

  /** How many workspaces the workers hold. */
  count(): number {
    return this.workers.reduce((sum, worker) => sum + worker.live.size, 0)
  }

  /** A worker that exited: its workspaces are gone with it. */
  private lost(worker: Worker): void {
    if (this.stopping) return
    for (const [id, home] of this.homes) if (home === worker) this.homes.delete(id)
    worker.live.clear()
    this.onLost()
  }
}

export interface WorkerProxyOptions {
  pool: WorkerPool
  /** The most workspaces the workers hold together; null for no cap. */
  maxWorkspaces: number | null
  /** The proxies whose `X-Forwarded-For` names the client. */
  proxies: readonly string[]
  idleGraceSeconds: number
  /** Stops the daemon: after idling, or on a shutdown a worker let through. */
  exit: () => void
}

/** What a worker answered, whole. */
interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

/** A request's body as far as it was read, and whether more follows. */
interface Peeked {
  head: Buffer
  more: boolean
  /** The workspace id the body names, if it names one. */
  id: string | undefined
  /** Whether the body passed `MAX_REQUEST_PART` before naming its id. */
  lost: boolean
}

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
        if (!res.headersSent) send(res, 502, UNAVAILABLE)
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
      send(res, 502, UNAVAILABLE)
      return
    }
    const url = new URL(req.url ?? '/', 'http://daemon')
    const parts = pathParts(req.url)
    const method = req.method ?? 'GET'
    if (parts[0] !== 'v1') return this.pass(first, req, res)
    const [, resource, id, action] = parts
    if (resource === 'health' && parts.length === 2 && method === 'GET') {
      send(res, 200, {
        status: 'ok',
        workspaces: pool.count(),
        uptime_s: Math.round((Date.now() / 1000 - this.startedAt) * 1000) / 1000,
        workers: pool.workers.filter((worker) => !worker.dead).length,
      })
      return
    }
    if (resource === 'ready' && parts.length === 2 && method === 'GET') {
      const status = this.draining ? 'shutting_down' : this.hasRoom(1) ? 'ready' : 'full'
      send(res, status === 'ready' ? 200 : 503, { status })
      return
    }
    if (resource === 'shutdown' && parts.length === 2 && method === 'POST') {
      // A worker answers whether the caller may stop the daemon.
      const answer = await this.fetch(first, req, null, true)
      if (answer.status !== 200) {
        reply(res, answer)
        return
      }
      send(res, 200, { status: 'shutting_down', pid: process.pid })
      this.options.exit()
      return
    }
    if (resource === 'jobs') {
      if (id === undefined) {
        const owner = url.searchParams.get('workspace_id')
        if (owner !== null) return this.pass(pool.home(owner) ?? first, req, res)
        return this.gather(req, res, 'submitted_at')
      }
      return this.find(req, res, first)
    }
    if (resource !== 'workspaces') return this.pass(first, req, res)
    if (id === undefined) {
      if (method === 'GET') return this.gather(req, res, 'created_at')
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
      if (answer.status < 300) {
        if (deletes) pool.forget(id)
        else pool.release(id)
        this.idleCheck()
      }
      reply(res, answer)
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
      send(res, 503, { detail: 'server is shutting down' })
      return
    }
    let reserved = false
    try {
      const refused = await this.refused(req, source ?? pool.first())
      if (refused !== null) {
        reply(res, refused)
        return
      }
      const peeked = await peek(req)
      if (peeked.lost) {
        send(res, 413, {
          detail: `the workspace id must come in the body's first ${String(MAX_REQUEST_PART)} bytes`,
        })
        return
      }
      const home = peeked.id === undefined ? undefined : pool.home(peeked.id)
      const live = home?.live.has(peeked.id ?? '') === true
      // A retry of a live id goes to its worker even when full, but holds a
      // slot too: the worker may close that id first and build it again.
      if (!live && !this.hasRoom(1)) {
        send(res, 503, {
          detail: `server is at max_workspaces (${String(this.options.maxWorkspaces)})`,
        })
        return
      }
      if (source !== null && live && home !== source) {
        send(res, 409, { detail: `workspace id already exists: ${String(peeked.id)}` })
        return
      }
      const worker = source ?? (home?.dead === false ? home : undefined) ?? pool.random()
      if (worker === undefined) {
        send(res, 502, UNAVAILABLE)
        return
      }
      // Nothing is awaited between the check above and here, so creates
      // racing each other cannot pass max_workspaces.
      pool.reserved += 1
      reserved = true
      const settle = peeked.id === undefined ? () => undefined : pool.claim(peeked.id, worker)
      this.cancelIdle()
      try {
        const answer = await this.fetch(worker, req, peeked.head, peeked.more)
        if (answer.status === 201) {
          const made = idOf(answer.body)
          if (made !== undefined) pool.adopt(made, worker)
        }
        reply(res, answer)
      } finally {
        settle()
      }
    } finally {
      if (reserved) pool.reserved -= 1
      this.idleCheck()
    }
  }

  /** A list: every worker's, merged in `order`. */
  private async gather(req: IncomingMessage, res: ServerResponse, order: string): Promise<void> {
    const running = this.options.pool.workers.filter((worker) => !worker.dead)
    const answers = await Promise.all(running.map((worker) => this.fetch(worker, req, null)))
    const failed = answers.find((answer) => answer.status !== 200)
    if (failed !== undefined) {
      reply(res, failed)
      return
    }
    const items = answers.flatMap((answer) => JSON.parse(answer.body.toString()) as unknown[])
    const key = (item: unknown): number =>
      Number((item as Record<string, unknown> | null)?.[order] ?? 0)
    items.sort((a, b) => key(a) - key(b))
    send(res, 200, items)
  }

  /** A job's request: the worker that knows the job answers. */
  private async find(req: IncomingMessage, res: ServerResponse, first: Worker): Promise<void> {
    const refused = await this.refused(req, first)
    if (refused !== null) {
      reply(res, refused)
      return
    }
    const body = await readUpTo(req, MAX_REQUEST_PART)
    if (body === null) {
      send(res, 413, { detail: 'request body too large' })
      return
    }
    let last: Answer | null = null
    for (const worker of this.options.pool.workers) {
      if (worker.dead) continue
      last = await this.fetch(worker, req, body)
      if (last.status !== 404) break
    }
    if (last === null) send(res, 502, UNAVAILABLE)
    else reply(res, last)
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
    return answer.status < 300 ? null : answer
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
  ): Promise<Answer> {
    const headers = headersFor(req, this.client(req))
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
      if (name.toLowerCase() !== 'x-forwarded-for')
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

/** The decoded segments of a request's path. */
function pathParts(url: string | undefined): string[] {
  return new URL(url ?? '/', 'http://daemon').pathname
    .split('/')
    .slice(1)
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
}

/** Whether the server on `socket` answers its health check. */
function answers(socket: string, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = httpRequest(
      { socketPath: socket, path: '/v1/health', method: 'GET', headers: { host } },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    probe.once('error', () => {
      resolve(false)
    })
    probe.end()
  })
}

/** The whole answer to `request`. */
function answered(request: ClientRequest): Promise<Answer> {
  return new Promise((resolve, reject) => {
    request.once('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => {
        resolve({
          status: response.statusCode ?? 502,
          headers: response.headers,
          body: Buffer.concat(chunks),
        })
      })
      response.once('error', reject)
    })
    request.once('error', reject)
  })
}

function headersFor(req: IncomingMessage, client: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name) && name !== 'x-forwarded-for' && value !== undefined) {
      headers[name] = value
    }
  }
  headers['x-forwarded-for'] = client
  return headers
}

function passable(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name) && value !== undefined) out[name] = value
  }
  return out
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function reply(res: ServerResponse, answer: Answer): void {
  const headers = passable(answer.headers)
  headers['content-length'] = answer.body.byteLength
  res.writeHead(answer.status, headers)
  res.end(answer.body)
}

/** The workspace id a create names: its `id`, else its config's `workspace_id`. */
function idOf(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString()) as {
      id?: unknown
      config?: { workspace_id?: unknown } | null
    }
    const id = parsed.id ?? parsed.config?.workspace_id
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/** The whole of `req`, null past `limit` bytes. */
async function readUpTo(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const read: Buffer[] = []
  let size = 0
  for await (const chunk of chunks(req)) {
    size += chunk.byteLength
    if (size > limit) return null
    read.push(chunk)
  }
  return Buffer.concat(read)
}

/**
 * The chunks of `req` as they arrive. The request is paused between
 * chunks and keeps no listener, so what is left once the reader stops can
 * still be piped.
 */
async function* chunks(req: IncomingMessage): AsyncGenerator<Buffer> {
  for (;;) {
    if (req.readableEnded) return
    const chunk = await new Promise<Buffer | null>((resolve, reject) => {
      const settle = (): void => {
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('error', onError)
        req.pause()
      }
      const onData = (data: Buffer): void => {
        settle()
        resolve(data)
      }
      const onEnd = (): void => {
        settle()
        resolve(null)
      }
      const onError = (error: Error): void => {
        settle()
        reject(error)
      }
      req.on('data', onData)
      req.once('end', onEnd)
      req.once('error', onError)
      req.resume()
    })
    if (chunk === null) return
    yield chunk
  }
}

/**
 * Read a create's body, up to `MAX_REQUEST_PART`, until the workspace id
 * it names is known: a JSON body whole, or a multipart load's parts up to
 * the end of its `request` part. What was read is sent on first; past the
 * limit the id is not known.
 */
async function peek(req: IncomingMessage): Promise<Peeked> {
  const type = req.headers['content-type'] ?? ''
  const read: Buffer[] = []
  let size = 0
  if (!type.startsWith('multipart/')) {
    for await (const chunk of chunks(req)) {
      read.push(chunk)
      size += chunk.byteLength
      if (size > MAX_REQUEST_PART) {
        return { head: Buffer.concat(read), more: true, id: undefined, lost: true }
      }
    }
    const head = Buffer.concat(read)
    return { head, more: false, id: idOf(head), lost: false }
  }
  let done = false
  const kept = async function* (): AsyncGenerator<Buffer> {
    for await (const chunk of chunks(req)) {
      read.push(chunk)
      size += chunk.byteLength
      yield chunk
    }
    done = true
  }
  const request: Buffer[] = []
  let name = ''
  let named = false
  try {
    for await (const event of partEvents(kept(), type)) {
      if (event.kind === 'begin') {
        if (name === 'request') {
          named = true
          break
        }
        name = event.name
      } else if (event.kind === 'data' && name === 'request') {
        request.push(Buffer.from(event.data))
      } else if (event.kind === 'end' && name === 'request') {
        named = true
        break
      }
      if (size > MAX_REQUEST_PART) break
    }
  } catch (error) {
    // A malformed body goes on as it is, for the worker to refuse.
    console.debug('mirage: a load body did not parse:', error)
  }
  return {
    head: Buffer.concat(read),
    more: !done,
    id: idOf(Buffer.concat(request)),
    lost: !named && size > MAX_REQUEST_PART,
  }
}
