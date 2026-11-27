/**
 * The Node server's side of the E2B adapter: its in-memory sandbox table,
 * the lookups its Fastify hooks make, and its command stream transport.
 * Only the server imports this module; the ./e2b export does not.
 */
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { HttpError } from '../errors.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import type { RouteRequest } from '../routes.ts'
import { isDataRequest, isLifecycleRequest } from '../routers/e2b.ts'
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
 * always has an owner; the server's workspaces keep null for it.
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
    return (await this.createWorkspace(owner === DEFAULT_OWNER ? null : owner)).id
  }

  put(record: SandboxRecord): Promise<void> {
    const held = this.leases.get(record.sandboxId)
    if (held !== undefined) {
      held.record = record
      this.schedule(held)
      return Promise.resolve()
    }
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
    try {
      return this.registry.get(workspaceId)
    } catch {
      return null
    }
  }

  private active(id: string): SandboxEntry | null {
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

export function nodeCommandStream(
  body: ReadableStream<Uint8Array>,
  stalled: AbortSignal,
): Readable {
  const stream = Readable.fromWeb(body as NodeReadableStream<Uint8Array>)
  stalled.addEventListener('abort', () => stream.destroy(), { once: true })
  return stream
}
