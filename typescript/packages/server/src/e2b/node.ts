import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { HttpError } from '../errors.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import type { RouteRequest } from '../routes.ts'
import {
  checkSandboxAccess,
  dataRoutes,
  isDataRequest,
  isLifecycleRequest,
} from '../routers/e2b.ts'
import * as constants from './constants.ts'
import { isProcessStart } from './process.ts'
import { SandboxNotRunning } from './errors.ts'
import {
  type AccessHeaders,
  isLive,
  type LifecycleBackend,
  nowMs,
  Sandbox,
  type SandboxRecord,
  sandboxIdOf,
  verifyAccess,
} from './sandbox.ts'

/** The owner of the sandboxes a request with `account` creates and reaches. */
export function sandboxOwner(account: string | null): string {
  return account ?? constants.DEFAULT_OWNER
}

export function sandboxAccount(
  sandboxes: MemoryLifecycleBackend | null,
  headers: Parameters<MemoryLifecycleBackend['requireAccess']>[0],
): string | null {
  return sandboxAccess(sandboxes, headers)?.workspaceEntry.owner ?? null
}

function sandboxAccess(
  sandboxes: MemoryLifecycleBackend | null,
  headers: Parameters<MemoryLifecycleBackend['requireAccess']>[0],
): SandboxEntry | null {
  try {
    return sandboxes?.requireAccess(headers) ?? null
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    console.debug('sandbox access could not be verified:', error.message)
    return null
  }
}

export function sandboxWorkspace(
  sandboxes: MemoryLifecycleBackend | null,
  path: string,
  request: Pick<RouteRequest, 'method' | 'params' | 'account'> & {
    headers: Parameters<MemoryLifecycleBackend['requireAccess']>[0]
  },
): string | null {
  if (sandboxes === null) return null
  if (isDataRequest(request.method, path)) {
    return sandboxAccess(sandboxes, request.headers)?.workspaceEntry.id ?? null
  }
  const { params } = request
  if (
    !isLifecycleRequest(request.method, path) ||
    typeof params !== 'object' ||
    params === null ||
    !('id' in params) ||
    typeof params.id !== 'string'
  ) {
    return null
  }
  return sandboxes.owned(params.id, request.account)?.workspaceEntry.id ?? null
}

/** One sandbox the server keeps in memory, over a workspace in its registry, as `WorkspaceEntry` is one workspace. */
class SandboxEntry {
  timer?: ReturnType<typeof setTimeout>

  constructor(
    public record: SandboxRecord,
    readonly workspaceEntry: WorkspaceEntry,
    readonly sandbox: Sandbox,
  ) {}
}

/**
 * The server's lifecycle backend: sandboxes in memory, each expired by a
 * timer, over workspaces in the daemon's registry. `createWorkspace` builds
 * a new sandbox's workspace.
 */
export class MemoryLifecycleBackend implements LifecycleBackend {
  private readonly sandboxes = new Map<string, SandboxEntry>()
  private readonly removing = new Set<Promise<WorkspaceEntry>>()

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly createWorkspace: (owner: string | null) => Promise<WorkspaceEntry>,
  ) {}

  /** The server serves only the base template, which the routes check. */
  async start(owner: string): Promise<string> {
    return (await this.createWorkspace(this.registry.accountsRequired ? owner : null)).id
  }

  put(record: SandboxRecord): Promise<void> {
    const entry = this.registry.get(record.workspaceId)
    const held = new SandboxEntry(record, entry, new Sandbox(entry.runner.ws, record.envVars))
    this.sandboxes.set(record.sandboxId, held)
    this.schedule(held)
    entry.beforeStop = async () => {
      this.forget(held)
      await held.sandbox.stop()
    }
    return Promise.resolve()
  }

  get(id: string): Promise<SandboxRecord | null> {
    return Promise.resolve(this.active(id)?.record ?? null)
  }

  setExpiry(id: string, expiresAtMs: number, onlyExtend: boolean): Promise<SandboxRecord | null> {
    const held = this.sandboxes.get(id)
    if (held === undefined) return Promise.resolve(null)
    held.record = {
      ...held.record,
      expiresAtMs: onlyExtend ? Math.max(held.record.expiresAtMs, expiresAtMs) : expiresAtMs,
    }
    this.schedule(held)
    return Promise.resolve(held.record)
  }

  delete(id: string): Promise<void> {
    const held = this.sandboxes.get(id)
    if (held !== undefined) this.forget(held)
    return Promise.resolve()
  }

  async stop(workspaceId: string): Promise<void> {
    const held = this.sandboxes.get(workspaceId)
    if (held !== undefined) {
      await this.remove(held)
      return
    }
    const entry = this.entryOf(workspaceId)
    if (entry !== null) await this.removeEntry(entry)
  }

  requireAccess(headers: AccessHeaders): SandboxEntry {
    const id = sandboxIdOf(headers)
    const held = id === null ? null : this.active(id)
    verifyAccess(headers, held?.record ?? null)
    if (held === null) throw new SandboxNotRunning()
    return held
  }

  async close(): Promise<void> {
    for (const held of this.sandboxes.values()) this.expire(held)
    await Promise.allSettled(this.removing)
  }

  owned(id: string, account: string | null): SandboxEntry | null {
    const held = this.active(id)
    return held !== null && this.registry.visible(id, account) === held.workspaceEntry ? held : null
  }

  private entryOf(workspaceId: string): WorkspaceEntry | null {
    return this.registry.has(workspaceId) ? this.registry.get(workspaceId) : null
  }

  active(id: string): SandboxEntry | null {
    const held = this.sandboxes.get(id)
    if (held === undefined) return null
    if (!this.isRegistered(held)) {
      this.forget(held)
      return null
    }
    if (!isLive(held.record)) {
      this.expire(held)
      return null
    }
    return held
  }

  private isRegistered(held: SandboxEntry): boolean {
    const { workspaceEntry: entry } = held
    return entry.acceptingJobs && this.registry.visible(entry.id, entry.owner) === entry
  }

  private forget(held: SandboxEntry): void {
    clearTimeout(held.timer)
    if (this.sandboxes.get(held.record.sandboxId) === held)
      this.sandboxes.delete(held.record.sandboxId)
  }

  private async remove(held: SandboxEntry): Promise<void> {
    this.forget(held)
    if (!this.isRegistered(held)) return
    await this.removeEntry(held.workspaceEntry)
  }

  private async removeEntry(entry: WorkspaceEntry): Promise<void> {
    const removal = this.registry.remove(entry.id)
    this.removing.add(removal)
    try {
      await removal
    } finally {
      this.removing.delete(removal)
    }
  }

  private expire(held: SandboxEntry): void {
    void this.remove(held).catch((error: unknown) => {
      console.error(`removing sandbox ${held.workspaceEntry.id}:`, error)
    })
  }

  private schedule(held: SandboxEntry): void {
    clearTimeout(held.timer)
    held.timer = setTimeout(
      () => {
        if (this.sandboxes.get(held.record.sandboxId) !== held) return
        if (!this.isRegistered(held)) this.forget(held)
        else if (!isLive(held.record)) this.expire(held)
        else this.schedule(held)
      },
      Math.min(constants.MAX_TIMER_DELAY_MS, Math.ceil(held.record.expiresAtMs - nowMs())),
    )
  }
}

/** A request body as a web stream that leaves the socket open when it is dropped unread. */
function bodyStream(raw: IncomingMessage): ReadableStream<Uint8Array> {
  const source = raw.iterator({ destroyOnReturn: false }) as AsyncIterator<Uint8Array>
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await source.next()
        if (next.done === true) controller.close()
        else controller.enqueue(next.value)
      },
      async cancel() {
        await source.return?.()
      },
    },
    { highWaterMark: 0 },
  )
}

/** A web body as a Node stream that closes, without an error, when the body fails. */
function nodeStream(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader()
  const stream = new Readable({
    read() {
      reader.read().then(
        (next) => this.push(next.done ? null : next.value),
        () => this.destroy(),
      )
    },
    destroy(_error, done) {
      void reader.cancel().catch(() => undefined)
      done(null)
    },
  })
  reader.closed.catch(() => stream.destroy())
  return stream
}

/** Whether `req` carries a body, which an answer that leaves it unread must close the socket for. */
function hasBody(req: FastifyRequest): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return false
  const length = req.headers['content-length']
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0')
}

function webRequest(req: FastifyRequest): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const bodied = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers,
    signal: req.closed,
    ...(bodied ? { body: bodyStream(req.raw), duplex: 'half' } : {}),
  } as RequestInit)
}

/**
 * Answer a Fastify request through the web handlers every other host calls:
 * the lifecycle routes as the request's account, the data routes against
 * the sandbox its headers name.
 */
export function webForwarder(deps: {
  sandboxes: MemoryLifecycleBackend
  lifecycle: (request: Request, owner: string) => Promise<Response>
  ownerOf: (request: FastifyRequest) => string
  draining: () => boolean
}): (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  return async (req, reply) => {
    const path = req.routeOptions.url ?? ''
    const request = webRequest(req)
    const unread = (): void => {
      if (hasBody(req) && !req.raw.readableEnded) reply.header('connection', 'close')
    }
    let response: Response
    if (isLifecycleRequest(req.method === 'HEAD' ? 'GET' : req.method, path)) {
      response = await deps.lifecycle(request, deps.ownerOf(req))
    } else {
      const id = sandboxIdOf(req.headers)
      const entry = id === null ? null : deps.sandboxes.active(id)
      const refused = checkSandboxAccess(request, entry?.record ?? null)
      if (refused !== null) {
        response = refused
      } else if (entry === null) {
        throw new SandboxNotRunning()
      } else if (deps.draining() && isProcessStart(req.method, path)) {
        unread()
        throw new HttpError('shutting_down', 'server is shutting down')
      } else {
        response = await dataRoutes(request, entry.sandbox)
      }
    }
    unread()
    void reply.code(response.status)
    response.headers.forEach((value, name) => {
      void reply.header(name, value)
    })
    if (response.body === null) return reply.send()
    if (response.headers.has('content-length')) {
      return reply.send(Buffer.from(await response.arrayBuffer()))
    }
    return reply.send(nodeStream(response.body))
  }
}
