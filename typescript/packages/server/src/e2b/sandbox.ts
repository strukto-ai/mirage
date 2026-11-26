import { ABORT_JOIN_MS, abortable, settledWithin } from '@struktoai/mirage-core/utils/abort'
import { SYSTEM_IDS } from '@struktoai/mirage-core/utils/ids'
import { toHex } from '@struktoai/mirage-core/utils/hex'
import type { BytePipe } from '@struktoai/mirage-core/io/pipe'
import type { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import { HttpError } from '../errors.ts'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import type { StartCommand } from './connect.ts'
import { ENVD_PORT } from './constants.ts'
import { SandboxNotRunning } from './errors.ts'

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

export interface LiveProcess {
  readonly command: StartCommand
  readonly execution: ShellExecution
  stdin: BytePipe | undefined
  killed: boolean
}

export class SandboxLease {
  timer?: ReturnType<typeof setTimeout>
  readonly processes = new Map<number, LiveProcess>()
  private readonly revocation = new AbortController()
  private readonly files = new Set<Promise<unknown>>()

  constructor(
    readonly entry: WorkspaceEntry,
    readonly accessToken: string,
    readonly envVars: Readonly<Record<string, string>>,
    public expiresAt: number,
  ) {}

  get revoked(): AbortSignal {
    return this.revocation.signal
  }

  checkFiles(): void {
    if (this.revoked.aborted || !this.entry.acceptingJobs || this.expiresAt <= performance.now()) {
      throw new SandboxNotRunning()
    }
  }

  async runFile<T>(closed: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.checkFiles()
    const signal = AbortSignal.any([this.revoked, closed])
    signal.throwIfAborted()
    const operation = run(signal)
    // The request can leave early, while teardown still owns the backend operation.
    this.files.add(operation)
    void operation
      .finally(() => {
        this.files.delete(operation)
      })
      .catch((error: unknown) => {
        if (signal.aborted && error !== signal.reason) {
          console.debug('sandbox file operation ended after cancellation:', error)
        }
      })
    try {
      const result = await abortable(operation, signal)
      signal.throwIfAborted()
      return result
    } catch (error) {
      signal.throwIfAborted()
      throw error
    }
  }

  async stopFiles(): Promise<void> {
    this.revocation.abort(new SandboxNotRunning())
    if (!(await settledWithin(Promise.allSettled(this.files), ABORT_JOIN_MS / 1000))) {
      console.debug(`sandbox ${this.entry.id} still has file operations after cancellation`)
    }
  }
}

export class Sandboxes {
  private readonly leases = new Map<string, SandboxLease>()
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
    const lease = new SandboxLease(
      entry,
      toHex(SYSTEM_IDS.secureBytes(32)),
      envVars,
      performance.now() + timeout * 1000,
    )
    this.leases.set(entry.id, lease)
    this.schedule(lease)
    entry.beforeStop = async () => {
      this.forget(lease)
      await lease.stopFiles()
    }
    return lease
  }

  reconnect(id: string, account: string | null, timeout: number): SandboxLease | null {
    const lease = this.owned(id, account)
    if (lease === null) return null
    lease.expiresAt = Math.max(lease.expiresAt, performance.now() + timeout * 1000)
    this.schedule(lease)
    return lease
  }

  setTimeout(id: string, account: string | null, timeout: number): boolean {
    const lease = this.owned(id, account)
    if (lease === null) return false
    lease.expiresAt = performance.now() + timeout * 1000
    this.schedule(lease)
    return true
  }

  async kill(id: string, account: string | null): Promise<boolean> {
    const lease = this.owned(id, account)
    if (lease === null) return false
    await this.revoke(lease)
    return true
  }

  requireAccess(
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  ): SandboxLease {
    const id = headers['e2b-sandbox-id']
    if (typeof id !== 'string' || id === '' || headers['e2b-sandbox-port'] !== ENVD_PORT) {
      throw new HttpError('invalid_request', 'invalid sandbox routing headers')
    }
    const token = headers['x-access-token']
    if (typeof token !== 'string' || token === '') {
      throw new HttpError('unauthorized', 'invalid sandbox access token')
    }
    const lease = this.active(id)
    if (lease === null) throw new SandboxNotRunning()
    if (!this.matchesAccessToken(lease.accessToken, token)) {
      throw new HttpError('unauthorized', 'invalid sandbox access token')
    }
    const authorization = headers.authorization
    if (
      typeof authorization === 'string' &&
      /^basic /i.test(authorization) &&
      authorization.slice(6) !== 'dXNlcjo='
    ) {
      throw new HttpError('invalid_request', 'only the default sandbox user is supported')
    }
    return lease
  }

  async close(): Promise<void> {
    for (const lease of this.leases.values()) this.expire(lease)
    await Promise.allSettled(this.removing)
  }

  owned(id: string, account: string | null): SandboxLease | null {
    const lease = this.active(id)
    return lease !== null && this.registry.visible(id, account) === lease.entry ? lease : null
  }

  private active(id: string): SandboxLease | null {
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

  private isRegistered(lease: SandboxLease): boolean {
    const { entry } = lease
    return entry.acceptingJobs && this.registry.visible(entry.id, entry.owner) === entry
  }

  private forget(lease: SandboxLease): void {
    clearTimeout(lease.timer)
    if (this.leases.get(lease.entry.id) === lease) this.leases.delete(lease.entry.id)
  }

  private async revoke(lease: SandboxLease): Promise<void> {
    this.forget(lease)
    if (!this.isRegistered(lease)) return
    const removal = this.registry.remove(lease.entry.id)
    this.removing.add(removal)
    try {
      await removal
    } finally {
      this.removing.delete(removal)
    }
  }

  private expire(lease: SandboxLease): void {
    void this.revoke(lease).catch((error: unknown) => {
      console.error(`removing sandbox ${lease.entry.id}:`, error)
    })
  }

  private schedule(lease: SandboxLease): void {
    clearTimeout(lease.timer)
    lease.timer = setTimeout(
      () => {
        if (this.leases.get(lease.entry.id) !== lease) return
        if (!this.isRegistered(lease)) this.forget(lease)
        else if (lease.expiresAt <= performance.now()) this.expire(lease)
        else this.schedule(lease)
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.ceil(lease.expiresAt - performance.now())),
    )
  }
}
