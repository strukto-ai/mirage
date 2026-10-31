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

/**
 * The daemon as a front and worker processes.
 *
 * With `workers` above 1 the daemon's process is a front: it starts that
 * many workers, each the whole server on a socket of its own, and hands
 * each new workspace to the worker holding the fewest. Every request
 * about a workspace goes to the worker holding it, so each worker's
 * workspaces share its event loop and nothing else. Lists, health and
 * readiness are the front's own, over every worker. On Linux, `cpus`
 * pins worker i to the i-th CPU of the list, with `taskset`.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect, type Socket } from 'node:net'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import proxyaddr from '@fastify/proxy-addr'
import { DaemonConfigError, readDaemonTable } from './daemon_config.ts'
import { ENV_CPUS, ENV_FORWARDED_ALLOW_IPS, ENV_WORKER_SOCKET, ENV_WORKERS } from './env.ts'
import { MAX_REQUEST_PART, MAX_SNAPSHOT_PART, partEvents } from './multipart.ts'
import { mirageHome } from './paths.ts'

// How long a worker has to answer its health check once started.
const READY_SECONDS = 60
// How long a stopped worker has to exit before it is killed, past the
// graceful timeout it drains for.
const EXIT_SECONDS = 10
// How long the front waits before starting a worker that exited again.
const RESTART_SECONDS = 1
// The most CPUs one range of a `cpus` list may name.
const MAX_CPUS = 4096
// One item of a `cpus` list: a CPU or a range of them.
const CPU_RANGE = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/
// Headers that belong to one connection, which the front does not pass on.
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * The CPUs a `cpus` setting names, in order: `0-3,6` is 0, 1, 2, 3 and 6.
 * Throws DaemonConfigError for anything else. Mirrors Python's
 * `parse_cpu_list`.
 */
export function parseCpuList(text: string): number[] {
  const cpus: number[] = []
  for (const item of text.split(',')) {
    const match = CPU_RANGE.exec(item)
    const first = match === null ? NaN : Number(match[1])
    const last = match?.[2] === undefined ? first : Number(match[2])
    if (!Number.isSafeInteger(first) || last < first || last - first >= MAX_CPUS) {
      throw new DaemonConfigError(
        `cpus must be a CPU list such as 0-3,6, got ${JSON.stringify(text)}`,
      )
    }
    for (let cpu = first; cpu <= last; cpu++) if (!cpus.includes(cpu)) cpus.push(cpu)
  }
  return cpus
}

/**
 * The CPUs the workers are pinned to: `cpus` when given, else
 * `$MIRAGE_CPUS`, else the `cpus` key in config.toml's `[daemon]` table,
 * else null for none. Mirrors Python's `resolve_cpus`.
 */
export function resolveCpus(
  cpus?: string | null,
  env: Record<string, string | undefined> = process.env,
): number[] | null {
  let value = cpus ?? undefined
  if (value === undefined) {
    const fromEnv = env[ENV_CPUS]
    value =
      fromEnv !== undefined && fromEnv !== '' ? fromEnv : readDaemonTable(mirageHome(env)).cpus
    if (value === undefined || value === '') return null
  }
  return parseCpuList(value)
}

/**
 * How many worker processes the daemon runs: `workers` when given, else
 * `$MIRAGE_WORKERS`, else the `workers` key in config.toml's `[daemon]`
 * table, else one per CPU of `cpus`, else 1, a daemon of one process.
 * Mirrors Python's `resolve_workers`.
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
    if (value === undefined || value === '') return resolveCpus(undefined, env)?.length ?? 1
  }
  const count = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : 0
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new DaemonConfigError(
      `workers must be a positive whole number, got ${JSON.stringify(value)}`,
    )
  }
  return count
}

/** One worker process: the whole server, on a socket of its own. */
export interface Worker {
  readonly index: number
  readonly socket: string
  /** The CPU it is pinned to, null when it is not. */
  readonly cpu: number | null
  child: ChildProcess | null
  /** The ids of the workspaces it holds. */
  readonly live: Set<string>
  /** The creates in flight on it. */
  building: number
}

export interface WorkerPoolOptions {
  count: number
  /** The CPUs to pin the workers to, in order; null pins none. */
  cpus: readonly number[] | null
  /** The command a worker runs: an executable and its arguments. */
  command: readonly string[]
  env: Record<string, string | undefined>
  /** How long a stopped worker drains its lines for. */
  gracefulTimeout: number
}

/**
 * The worker processes and which holds each workspace. A workspace's home
 * outlives its close, so its jobs and a create under its id reach the
 * worker that has them; a delete forgets it. Mirrors Python's
 * `WorkerPool`.
 */
export class WorkerPool {
  readonly workers: Worker[]
  private readonly homes = new Map<string, Worker>()
  private readonly directory: string
  private stopping = false
  /** Called when a worker's workspaces are gone with it. */
  onLost: () => void = () => undefined

  constructor(private readonly options: WorkerPoolOptions) {
    let cpus = options.cpus
    if (cpus !== null && platform() !== 'linux') {
      console.warn('mirage: cpus pins workers on Linux only; the workers run unpinned')
      cpus = null
    }
    if (cpus !== null && spawnSync('taskset', ['-V']).error !== undefined) {
      throw new DaemonConfigError('cpus pins workers with taskset, which is not on PATH')
    }
    this.directory = mkdtempSync(join(tmpdir(), 'mirage-workers-'))
    this.workers = Array.from({ length: options.count }, (_, index) => ({
      index,
      socket: join(this.directory, `${String(index)}.sock`),
      cpu: cpus === null || cpus.length === 0 ? null : (cpus[index % cpus.length] ?? null),
      child: null,
      live: new Set<string>(),
      building: 0,
    }))
  }

  /** Start every worker and wait until each answers. */
  async start(): Promise<void> {
    await Promise.all(this.workers.map((worker) => this.launch(worker)))
  }

  /** Stop every worker: each drains, then exits or is killed. */
  async stop(): Promise<void> {
    this.stopping = true
    await Promise.all(this.workers.map((worker) => this.halt(worker)))
    rmSync(this.directory, { recursive: true, force: true })
  }

  /** The first worker, which answers requests no workspace owns. */
  first(): Worker {
    const worker = this.workers[0]
    if (worker === undefined) throw new Error('a worker pool has at least one worker')
    return worker
  }

  /** The worker holding or last holding `id`, else undefined. */
  home(id: string): Worker | undefined {
    return this.homes.get(id)
  }

  /** The worker a new workspace goes to: the one holding the fewest. */
  leastLoaded(): Worker {
    let best = this.first()
    for (const worker of this.workers) {
      if (worker.live.size + worker.building < best.live.size + best.building) best = worker
    }
    return best
  }

  /** Record `id` as held by `worker`. */
  adopt(id: string, worker: Worker): void {
    const previous = this.homes.get(id)
    if (previous !== undefined && previous !== worker) previous.live.delete(id)
    this.homes.set(id, worker)
    worker.live.add(id)
  }

  /** Record `id` as closed: its home stays. */
  release(id: string): void {
    this.homes.get(id)?.live.delete(id)
  }

  /** Record `id` as deleted. */
  forget(id: string): void {
    this.release(id)
    this.homes.delete(id)
  }

  /** How many workspaces the workers hold, and how many are being built. */
  held(): number {
    return this.workers.reduce((sum, worker) => sum + worker.live.size + worker.building, 0)
  }

  /** How many workspaces the workers hold. */
  live(): number {
    return this.workers.reduce((sum, worker) => sum + worker.live.size, 0)
  }

  private async launch(worker: Worker): Promise<void> {
    const [executable, ...args] = this.options.command as [string, ...string[]]
    const argv = worker.cpu === null ? args : ['-c', String(worker.cpu), executable, ...args]
    const child = spawn(worker.cpu === null ? executable : 'taskset', argv, {
      env: {
        ...this.options.env,
        [ENV_WORKER_SOCKET]: worker.socket,
        [ENV_WORKERS]: '1',
        // Only the front reaches a worker's socket, and it names the
        // client it served.
        [ENV_FORWARDED_ALLOW_IPS]: '*',
      },
      // A worker exits when its stdin closes: the front is gone.
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    worker.child = child
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code)
      })
      child.once('error', (error) => {
        console.error(`mirage: worker ${String(worker.index)} did not start:`, error)
        resolve(null)
      })
    })
    void exited.then((code) => {
      if (worker.child === child) worker.child = null
      this.lost(worker, code)
    })
    const deadline = Date.now() + READY_SECONDS * 1000
    for (;;) {
      if (worker.child !== child) {
        throw new Error(`mirage: worker ${String(worker.index)} exited as it started`)
      }
      if (await answers(worker.socket)) return
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
        throw new Error(`mirage: worker ${String(worker.index)} did not answer`)
      }
      await delay(100)
    }
  }

  /** A worker that exited: its workspaces are gone, and it starts again. */
  private lost(worker: Worker, code: number | null): void {
    if (this.stopping) return
    console.error(`mirage: worker ${String(worker.index)} exited (${String(code)}); restarting it`)
    for (const id of worker.live) this.homes.delete(id)
    for (const [id, home] of this.homes) if (home === worker) this.homes.delete(id)
    worker.live.clear()
    this.onLost()
    setTimeout(() => {
      if (this.stopping) return
      this.launch(worker).catch((error: unknown) => {
        console.error(String(error))
      })
    }, RESTART_SECONDS * 1000)
  }

  private async halt(worker: Worker): Promise<void> {
    const child = worker.child
    if (child?.exitCode !== null) return
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve()
      })
    })
    child.kill('SIGTERM')
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      (this.options.gracefulTimeout + EXIT_SECONDS) * 1000,
    )
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface FrontOptions {
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

/** A request's body as far as the front read it, and whether more follows. */
interface Peeked {
  head: Buffer
  more: boolean
  /** The workspace id the body names, if it names one. */
  id: string | undefined
}

/**
 * The front: an HTTP server that sends each request to the worker holding
 * its workspace. Mirrors Python's `Front`.
 */
export class Front {
  readonly server: Server
  private draining = false
  private idleTimer: NodeJS.Timeout | null = null
  private readonly startedAt = Date.now() / 1000
  private readonly trust: (addr: string, i: number) => boolean

  constructor(private readonly options: FrontOptions) {
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
        console.error('mirage front:', error)
        if (!res.headersSent) send(res, 502, { detail: 'worker unavailable' })
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
    const url = new URL(req.url ?? '/', 'http://front')
    const parts = pathParts(req.url)
    const method = req.method ?? 'GET'
    if (parts[0] !== 'v1') return this.pass(pool.first(), req, res)
    const [, resource, id, action] = parts
    if (resource === 'health' && parts.length === 2 && method === 'GET') {
      send(res, 200, {
        status: 'ok',
        workspaces: pool.live(),
        uptime_s: Math.round((Date.now() / 1000 - this.startedAt) * 1000) / 1000,
        workers: pool.workers.length,
      })
      return
    }
    if (resource === 'ready' && parts.length === 2 && method === 'GET') {
      const status = this.draining ? 'shutting_down' : this.hasRoom(false) ? 'ready' : 'full'
      send(res, status === 'ready' ? 200 : 503, { status })
      return
    }
    if (resource === 'shutdown' && parts.length === 2 && method === 'POST') {
      // A worker answers whether the caller may stop the daemon.
      const answer = await this.fetch(pool.first(), req, await readAll(req))
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
        if (owner !== null) return this.pass(pool.home(owner) ?? pool.first(), req, res)
        return this.gather(req, res, 'submitted_at')
      }
      return this.find(req, res)
    }
    if (resource !== 'workspaces') return this.pass(pool.first(), req, res)
    if (id === undefined) {
      if (method === 'GET') return this.gather(req, res, 'created_at')
      if (method === 'POST') return this.create(req, res, null)
      return this.pass(pool.first(), req, res)
    }
    if (id === 'load' && parts.length === 3 && method === 'POST') return this.create(req, res, null)
    const home = pool.home(id)
    if (home === undefined) return this.pass(pool.first(), req, res)
    if (action === 'clone' && parts.length === 4 && method === 'POST') {
      return this.create(req, res, home)
    }
    if (action === undefined && method === 'DELETE') {
      const answer = await this.fetch(home, req, await readAll(req))
      if (answer.status < 300) {
        pool.forget(id)
        this.idleCheck()
      }
      reply(res, answer)
      return
    }
    if (action === 'close' && parts.length === 4 && method === 'POST') {
      const answer = await this.fetch(home, req, await readAll(req))
      if (answer.status < 300) {
        pool.release(id)
        this.idleCheck()
      }
      reply(res, answer)
      return
    }
    return this.pass(home, req, res)
  }

  /**
   * A create, load or clone: to the worker already holding the id it
   * names, else to `source`'s for a clone, else to the least loaded.
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
    if (!this.hasRoom(false)) {
      send(res, 503, {
        detail: `server is at max_workspaces (${String(this.options.maxWorkspaces)})`,
      })
      return
    }
    const peeked = await peek(req)
    const held = peeked.id === undefined ? undefined : pool.home(peeked.id)
    if (
      source !== null &&
      held !== undefined &&
      held !== source &&
      held.live.has(peeked.id ?? '')
    ) {
      send(res, 409, { detail: `workspace id already exists: ${String(peeked.id)}` })
      return
    }
    const worker = source ?? held ?? pool.leastLoaded()
    worker.building += 1
    this.cancelIdle()
    try {
      const answer = await this.fetch(worker, req, peeked.head, peeked.more)
      if (answer.status === 201) {
        const made = idOf(answer.body)
        if (made !== undefined) pool.adopt(made, worker)
      }
      reply(res, answer)
    } finally {
      worker.building -= 1
      this.idleCheck()
    }
  }

  /** A list: every worker's, merged in `order`. */
  private async gather(req: IncomingMessage, res: ServerResponse, order: string): Promise<void> {
    const { pool } = this.options
    const answers = await Promise.all(pool.workers.map((worker) => this.fetch(worker, req, null)))
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
  private async find(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readAll(req)
    const [first, ...rest] = this.options.pool.workers
    let last = await this.fetch(first ?? this.options.pool.first(), req, body)
    for (const worker of rest) {
      if (last.status !== 404) break
      last = await this.fetch(worker, req, body)
    }
    reply(res, last)
  }

  private hasRoom(own: boolean): boolean {
    const cap = this.options.maxWorkspaces
    return cap === null || this.options.pool.held() + (own ? 0 : 1) <= cap
  }

  /** Pass a request through to `worker`, streaming both ways. */
  private async pass(worker: Worker, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const upstream = this.open(worker, req, headersFor(req, this.client(req)))
    const answered = new Promise<void>((resolve, reject) => {
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
    await answered
  }

  /** Send `body`, and the rest of the request when `more`, and read the whole answer. */
  private async fetch(
    worker: Worker,
    req: IncomingMessage,
    body: Buffer | null,
    more = false,
  ): Promise<Answer> {
    const headers = headersFor(req, this.client(req))
    if (!more) {
      headers['content-length'] = String(body?.byteLength ?? 0)
      if (body === null || body.byteLength === 0) delete headers['content-length']
    }
    const upstream = this.open(worker, req, headers)
    const answer = new Promise<Answer>((resolve, reject) => {
      upstream.once('response', (response) => {
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
      upstream.once('error', reject)
    })
    if (body !== null && body.byteLength > 0) upstream.write(body)
    if (more && !req.readableEnded) req.pipe(upstream)
    else upstream.end()
    return answer
  }

  private open(worker: Worker, req: IncomingMessage, headers: OutgoingHttpHeaders) {
    return httpRequest({
      socketPath: worker.socket,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers,
    })
  }

  /** A WebSocket's upgrade: the raw connection, to the workspace's worker. */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const { pool } = this.options
    const parts = pathParts(req.url)
    const home =
      parts[1] === 'workspaces' && parts[2] !== undefined ? pool.home(parts[2]) : undefined
    const worker = home ?? pool.first()
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
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
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

/** Build the front over a started pool. Mirrors Python's `build_front`. */
export function buildFront(options: FrontOptions): Front {
  return new Front(options)
}

/** The decoded segments of a request's path. */
function pathParts(url: string | undefined): string[] {
  return new URL(url ?? '/', 'http://front').pathname
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
function answers(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = httpRequest({ socketPath: socket, path: '/v1/health', method: 'GET' }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    probe.once('error', () => {
      resolve(false)
    })
    probe.end()
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

function idOf(body: Buffer): string | undefined {
  try {
    const id = (JSON.parse(body.toString()) as { id?: unknown }).id
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
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
 * Read a create's body until the workspace id it names is known: a JSON
 * body whole, up to `MAX_REQUEST_PART`, or a multipart load's parts up to
 * the end of its `request` part. What was read is sent on first.
 */
async function peek(req: IncomingMessage): Promise<Peeked> {
  const type = req.headers['content-type'] ?? ''
  const read: Buffer[] = []
  let size = 0
  if (!type.startsWith('multipart/')) {
    for await (const chunk of chunks(req)) {
      read.push(chunk)
      size += chunk.byteLength
      if (size > MAX_REQUEST_PART) return { head: Buffer.concat(read), more: true, id: undefined }
    }
    const head = Buffer.concat(read)
    return { head, more: false, id: idOf(head) }
  }
  // The parts are read from what has arrived; the request part's JSON
  // names the id.
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
  try {
    for await (const event of partEvents(kept(), type)) {
      if (event.kind === 'begin') {
        if (name === 'request') break
        name = event.name
      } else if (event.kind === 'data' && name === 'request') {
        request.push(Buffer.from(event.data))
      } else if (event.kind === 'end' && name === 'request') {
        break
      }
      if (size > MAX_REQUEST_PART + MAX_SNAPSHOT_PART) break
    }
  } catch {
    // A malformed body goes on as it is, for the worker to refuse.
  }
  return { head: Buffer.concat(read), more: !done, id: idOf(Buffer.concat(request)) }
}
