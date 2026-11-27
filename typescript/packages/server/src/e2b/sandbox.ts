import type { BytePipe } from '@struktoai/mirage-core/io/pipe'
import { ABORT_JOIN_MS, abortable, settledWithin } from '@struktoai/mirage-core/utils/abort'
import type { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { HttpError } from '../errors.ts'
import * as constants from './constants.ts'
import { SandboxNotRunning } from './errors.ts'
import type { StartCommand } from './connect.ts'

/**
 * One sandbox as any host stores it. `sandboxId` is what the E2B SDK sends
 * back in `E2B-Sandbox-Id`; `workspaceId` is the Mirage workspace it runs in.
 */
export interface SandboxRecord {
  readonly sandboxId: string
  readonly workspaceId: string
  readonly owner: string
  readonly accessToken: string
  readonly envVars: Readonly<Record<string, string>>
  /** When it expires, in epoch milliseconds. */
  readonly expiresAtMs: number
}

/**
 * What a host provides to the lifecycle routes: where its sandbox records
 * live, and how a sandbox's workspace starts and stops. The routes own every
 * rule on top: ids and tokens, expiry, and the owner check. `get` may answer
 * an expired record; the routes treat it as gone. The host stops a sandbox
 * itself when it expires.
 */
export interface LifecycleBackend {
  get(sandboxId: string): Promise<SandboxRecord | null>
  /** Store a new sandbox's record. */
  put(record: SandboxRecord): Promise<void>
  /**
   * Set a stored record's expiry in one step against its stored value,
   * keeping the later of the two when `onlyExtend`, and only while the
   * record is still live. Answer the updated record, or null when it is
   * gone or already expired; never insert one.
   */
  setExpiry(
    sandboxId: string,
    expiresAtMs: number,
    onlyExtend: boolean,
  ): Promise<SandboxRecord | null>
  delete(sandboxId: string): Promise<void>
  /** Make the workspace a new sandbox for `owner` runs in, from `templateId`, and answer its id. */
  start(owner: string, templateId: string): Promise<string>
  /** Tear down the workspace a sandbox ran in. */
  stop(workspaceId: string): Promise<void>
}

/**
 * Epoch milliseconds read from `performance`, which every host has and which
 * tests can fake along with timers.
 */
export function nowMs(): number {
  return performance.timeOrigin + performance.now()
}

/** Whether `record` has not expired. */
export function isLive(record: SandboxRecord): boolean {
  return record.expiresAtMs > nowMs()
}

/** A command still running in a sandbox, which the process routes reach by its PID. */
export interface LiveProcess {
  readonly command: StartCommand
  readonly execution: ShellExecution
  stdin: BytePipe | undefined
  killed: boolean
}

/**
 * A running sandbox: the workspace the data routes run against, and the
 * commands and file work running in it. A host keeps one per loaded
 * workspace and calls `stop` on every path that stops that workspace.
 */
export class Sandbox {
  /** @internal Commands the process control routes reach by PID. */
  readonly processes = new Map<number, LiveProcess>()
  private readonly stopping = new AbortController()
  private readonly files = new Set<Promise<unknown>>()

  constructor(
    readonly workspace: Workspace,
    readonly envVars: Readonly<Record<string, string>>,
  ) {}

  /** Aborts, with `SandboxNotRunning`, once `stop` is called. */
  get stopped(): AbortSignal {
    return this.stopping.signal
  }

  /** Cancel its commands and file work, then wait a moment for file work to end. */
  async stop(): Promise<void> {
    if (!this.stopped.aborted) this.stopping.abort(new SandboxNotRunning())
    if (!(await settledWithin(Promise.allSettled(this.files), ABORT_JOIN_MS / 1000))) {
      console.debug('sandbox still has file operations after cancellation')
    }
  }

  /** @internal Run one file operation until it ends, the sandbox stops, or `closed` aborts. */
  async runFile<T>(closed: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.stopped.throwIfAborted()
    const signal = AbortSignal.any([this.stopped, closed])
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
}

export type AccessHeaders = Readonly<Record<string, string | readonly string[] | undefined>>

/** Whether two tokens match, in time that depends only on their length. */
function sameToken(expected: string, presented: string): boolean {
  const left = new TextEncoder().encode(expected)
  const right = new TextEncoder().encode(presented)
  if (left.length !== right.length) return false
  let difference = 0
  left.forEach((byte, i) => {
    difference |= byte ^ (right[i] ?? 0)
  })
  return difference === 0
}

/** The sandbox a data request's routing headers name, or null. */
export function sandboxIdOf(headers: AccessHeaders): string | null {
  const id = headers['e2b-sandbox-id']
  if (typeof id !== 'string' || id === '' || headers['e2b-sandbox-port'] !== constants.ENVD_PORT) {
    return null
  }
  return id
}

/** Refuse a data request that `record`, the sandbox its headers name, does not admit. */
export function verifyAccess(
  headers: AccessHeaders,
  record: SandboxRecord | null,
): asserts record is SandboxRecord {
  const id = sandboxIdOf(headers)
  if (id === null) throw new HttpError('invalid_request', 'invalid sandbox routing headers')
  const token = headers['x-access-token']
  if (typeof token !== 'string' || token === '') {
    throw new HttpError('unauthorized', 'invalid sandbox access token')
  }
  if (record?.sandboxId !== id || !isLive(record)) throw new SandboxNotRunning()
  if (!sameToken(record.accessToken, token)) {
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
}
