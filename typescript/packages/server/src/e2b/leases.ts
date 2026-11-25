import { SYSTEM_IDS } from '@struktoai/mirage-core/utils/ids'
import { toHex } from '@struktoai/mirage-core/utils/hex'
import { HttpError } from '../errors.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import type { RouteRequest } from '../routes.ts'

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

export interface SandboxLease {
  readonly entry: WorkspaceEntry
  readonly accessToken: string
  readonly envVars: Readonly<Record<string, string>>
}

interface TimedLease {
  readonly sandbox: SandboxLease
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
}

export class Sandboxes {
  private readonly leases = new Map<string, TimedLease>()
  private readonly removing = new Set<Promise<WorkspaceEntry>>()

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly matchesAccessToken: (expected: string, presented: string) => boolean,
  ) {}

  add(
    entry: WorkspaceEntry,
    envVars: Readonly<Record<string, string>>,
    timeout: number,
  ): SandboxLease {
    const sandbox = { entry, accessToken: toHex(SYSTEM_IDS.secureBytes(32)), envVars }
    const lease = { sandbox, expiresAt: performance.now() + timeout * 1000 }
    this.leases.set(entry.id, lease)
    this.schedule(lease)
    return sandbox
  }

  reconnect(id: string, account: string | null, timeout: number): SandboxLease | null {
    const lease = this.owned(id, account)
    if (lease === null) return null
    lease.expiresAt = Math.max(lease.expiresAt, performance.now() + timeout * 1000)
    this.schedule(lease)
    return lease.sandbox
  }

  async kill(id: string, account: string | null): Promise<boolean> {
    const lease = this.owned(id, account)
    if (lease === null) return false
    await this.revoke(lease)
    return true
  }

  requireAccess(headers: RouteRequest['headers']): SandboxLease {
    const id = headers['e2b-sandbox-id']
    if (typeof id !== 'string' || id === '' || headers['e2b-sandbox-port'] !== '49983') {
      throw new HttpError('invalid_request', 'invalid sandbox routing headers')
    }
    const token = headers['x-access-token']
    const lease = this.active(id)
    if (
      lease === null ||
      typeof token !== 'string' ||
      !this.matchesAccessToken(lease.sandbox.accessToken, token)
    ) {
      throw new HttpError('unauthorized', 'invalid sandbox access token')
    }
    return lease.sandbox
  }

  async close(): Promise<void> {
    for (const lease of this.leases.values()) clearTimeout(lease.timer)
    this.leases.clear()
    await Promise.allSettled(this.removing)
  }

  private owned(id: string, account: string | null): TimedLease | null {
    const lease = this.active(id)
    return lease !== null && this.registry.visible(id, account) === lease.sandbox.entry
      ? lease
      : null
  }

  private active(id: string): TimedLease | null {
    const lease = this.leases.get(id)
    if (lease === undefined) return null
    if (!this.isRegistered(lease)) {
      this.forget(lease)
      return null
    }
    if (lease.expiresAt <= performance.now()) {
      this.expire(lease)
      return null
    }
    return lease
  }

  private isRegistered(lease: TimedLease): boolean {
    const entry = lease.sandbox.entry
    return entry.acceptingJobs && this.registry.visible(entry.id, entry.owner) === entry
  }

  private forget(lease: TimedLease): void {
    clearTimeout(lease.timer)
    this.leases.delete(lease.sandbox.entry.id)
  }

  private async revoke(lease: TimedLease): Promise<void> {
    this.forget(lease)
    if (!this.isRegistered(lease)) return
    const removal = this.registry.remove(lease.sandbox.entry.id)
    this.removing.add(removal)
    try {
      await removal
    } finally {
      this.removing.delete(removal)
    }
  }

  private expire(lease: TimedLease): void {
    void this.revoke(lease).catch((error: unknown) => {
      console.error(`expiring sandbox ${lease.sandbox.entry.id}:`, error)
    })
  }

  private schedule(lease: TimedLease): void {
    clearTimeout(lease.timer)
    lease.timer = setTimeout(
      () => {
        if (this.leases.get(lease.sandbox.entry.id) !== lease) return
        if (!this.isRegistered(lease)) this.forget(lease)
        else if (lease.expiresAt <= performance.now()) this.expire(lease)
        else this.schedule(lease)
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.ceil(lease.expiresAt - performance.now())),
    )
  }
}
