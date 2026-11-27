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

/**
 * The sandbox owner when the auth mode names no account. An E2B sandbox
 * always has an owner; without accounts the server's workspaces keep null.
 */
const DEFAULT_OWNER = 'default'

/** The owner of the sandboxes a request with `account` creates and reaches. */
export function sandboxOwner(account: string | null): string {
  return account ?? DEFAULT_OWNER
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

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

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
  private readonly leases = new Map<string, SandboxEntry>()
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
    const lease = new SandboxEntry(record, entry, new Sandbox(entry.runner.ws, record.envVars))
    this.leases.set(record.sandboxId, lease)
    this.schedule(lease)
    entry.beforeStop = async () => {
      this.forget(lease)
      await lease.sandbox.stop()
    }
    return Promise.resolve()
  }

  get(id: string): Promise<SandboxRecord | null> {
    return Promise.resolve(this.active(id)?.record ?? null)
  }

  setExpiry(id: string, expiresAtMs: number, onlyExtend: boolean): Promise<SandboxRecord | null> {
    const lease = this.leases.get(id)
    if (lease === undefined) return Promise.resolve(null)
    lease.record = {
      ...lease.record,
      expiresAtMs: onlyExtend ? Math.max(lease.record.expiresAtMs, expiresAtMs) : expiresAtMs,
    }
    this.schedule(lease)
    return Promise.resolve(lease.record)
  }

  delete(id: string): Promise<void> {
    const lease = this.leases.get(id)
    if (lease !== undefined) this.forget(lease)
    return Promise.resolve()
  }

  async stop(workspaceId: string): Promise<void> {
    const lease = [...this.leases.values()].find((held) => held.workspaceEntry.id === workspaceId)
    if (lease !== undefined) {
      await this.remove(lease)
      return
    }
    const entry = this.entryOf(workspaceId)
    if (entry !== null) await this.removeEntry(entry)
  }

  requireAccess(headers: AccessHeaders): SandboxEntry {
    const id = sandboxIdOf(headers)
    const lease = id === null ? null : this.active(id)
    verifyAccess(headers, lease?.record ?? null)
    if (lease === null) throw new SandboxNotRunning()
    return lease
  }

  async close(): Promise<void> {
    for (const lease of this.leases.values()) this.expire(lease)
    await Promise.allSettled(this.removing)
  }

  owned(id: string, account: string | null): SandboxEntry | null {
    const lease = this.active(id)
    return lease !== null && this.registry.visible(id, account) === lease.workspaceEntry
      ? lease
      : null
  }

  private entryOf(workspaceId: string): WorkspaceEntry | null {
    return this.registry.has(workspaceId) ? this.registry.get(workspaceId) : null
  }

  active(id: string): SandboxEntry | null {
    const lease = this.leases.get(id)
    if (lease === undefined) return null
    if (!this.isRegistered(lease)) {
      this.forget(lease)
      return null
    }
    if (!isLive(lease.record)) {
      this.expire(lease)
      return null
    }
    return lease
  }

  private isRegistered(lease: SandboxEntry): boolean {
    const { workspaceEntry: entry } = lease
    return entry.acceptingJobs && this.registry.visible(entry.id, entry.owner) === entry
  }

  private forget(lease: SandboxEntry): void {
    clearTimeout(lease.timer)
    if (this.leases.get(lease.record.sandboxId) === lease)
      this.leases.delete(lease.record.sandboxId)
  }

  private async remove(lease: SandboxEntry): Promise<void> {
    this.forget(lease)
    if (!this.isRegistered(lease)) return
    await this.removeEntry(lease.workspaceEntry)
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

  private expire(lease: SandboxEntry): void {
    void this.remove(lease).catch((error: unknown) => {
      console.error(`removing sandbox ${lease.workspaceEntry.id}:`, error)
    })
  }

  private schedule(lease: SandboxEntry): void {
    clearTimeout(lease.timer)
    lease.timer = setTimeout(
      () => {
        if (this.leases.get(lease.record.sandboxId) !== lease) return
        if (!this.isRegistered(lease)) this.forget(lease)
        else if (!isLive(lease.record)) this.expire(lease)
        else this.schedule(lease)
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.ceil(lease.record.expiresAtMs - nowMs())),
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

function webRequest(req: FastifyRequest): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const bodied = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(`${req.protocol}://${req.host}${req.url}`, {
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
      if (!req.raw.readableEnded) reply.header('connection', 'close')
    }
    let response: Response
    if (isLifecycleRequest(req.method, path)) {
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
    return reply.send(response.body === null ? undefined : nodeStream(response.body))
  }
}
