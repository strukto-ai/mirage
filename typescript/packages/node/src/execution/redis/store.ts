import type { RedisClientType } from 'redis'
import { ExecutionStore } from '@struktoai/mirage-core/execution/base'
import type { ExecutionRecord } from '@struktoai/mirage-core/execution/types'
import { RedisConnection } from '../../optional_peer.ts'
import { POLL_SECONDS, STORE_LUA } from './constants.ts'

function encode(record: ExecutionRecord): [string, string] {
  const fields = JSON.stringify({
    id: record.id,
    workspace_id: record.workspaceId,
    session_id: record.sessionId,
    command: record.command,
    submitted_at: record.submittedAt,
    status: record.status,
    revision: record.revision,
    cancel_requested: record.cancelRequested,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    error: record.error,
  })
  return [fields, JSON.stringify(record.result)]
}

function decode(raw: string, result: string | null = null): ExecutionRecord {
  const fields = JSON.parse(raw) as {
    id: ExecutionRecord['id']
    workspace_id: ExecutionRecord['workspaceId']
    session_id: ExecutionRecord['sessionId']
    command: ExecutionRecord['command']
    submitted_at: ExecutionRecord['submittedAt']
    status: ExecutionRecord['status']
    revision: ExecutionRecord['revision']
    cancel_requested: ExecutionRecord['cancelRequested']
    started_at: ExecutionRecord['startedAt']
    finished_at: ExecutionRecord['finishedAt']
    error: ExecutionRecord['error']
  }
  return {
    id: fields.id,
    workspaceId: fields.workspace_id,
    sessionId: fields.session_id,
    command: fields.command,
    submittedAt: fields.submitted_at,
    status: fields.status,
    revision: fields.revision,
    cancelRequested: fields.cancel_requested,
    startedAt: fields.started_at,
    finishedAt: fields.finished_at,
    result: result === null ? null : (JSON.parse(result) as ExecutionRecord['result']),
    error: fields.error,
  }
}

/**
 * Shared execution snapshots with atomic revisions and completed retention.
 *
 * The snake_case JSON schema is shared with Python. Results live in their own
 * hash, so a listing never reads them. Active records never expire;
 * reads and writes prune completed records by age and count. Revision polling
 * observes changes made before waiting. Closing releases this client's connection
 * and waiters, leaving records intact. The executor still owns running work and
 * restart recovery. A Redis Cluster keyPrefix needs a shared hash tag.
 */
export class RedisExecutionStore extends ExecutionStore {
  private readonly redis: RedisConnection
  private closed = false
  private readonly listeners = new Set<() => void>()
  private readonly keys: string[]

  constructor(
    readonly url = 'redis://localhost:6379/0',
    readonly keyPrefix = 'mirage:{executions}:',
    private readonly maxCompleted = 1024,
    private readonly retentionSeconds = 3600,
  ) {
    super()
    if (
      !Number.isInteger(maxCompleted) ||
      maxCompleted < 1 ||
      !Number.isFinite(retentionSeconds) ||
      retentionSeconds <= 0
    )
      throw new Error('execution retention limits must be positive')
    this.keys = [`${keyPrefix}records`, `${keyPrefix}completed`, `${keyPrefix}results`]
    this.redis = new RedisConnection(url, 'RedisExecutionStore')
  }

  private async client(): Promise<RedisClientType> {
    if (this.closed) throw new Error('execution store is closed')
    return this.redis.client()
  }

  private async call(
    operation: string,
    id = '',
    data: [string, string] = ['', ''],
    revision = 0,
  ): Promise<unknown> {
    const client = await this.client()
    return client.eval(STORE_LUA, {
      keys: this.keys,
      arguments: [
        operation,
        id,
        String(Date.now() / 1000),
        String(this.retentionSeconds),
        String(this.maxCompleted),
        data[0],
        String(revision),
        data[1],
      ],
    })
  }

  async create(record: ExecutionRecord): Promise<boolean> {
    return (await this.call('create', record.id, encode(record))) === 1
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    const [raw, result] = (await this.call('get', id)) as [string | null, string | null]
    return raw === null ? null : decode(raw, result)
  }

  async list(workspaceId?: string): Promise<ExecutionRecord[]> {
    const raw = (await this.call('list')) as string[]
    return raw
      .map((record) => decode(record))
      .filter((record) => workspaceId === undefined || record.workspaceId === workspaceId)
  }

  async compareAndSet(record: ExecutionRecord, revision: number): Promise<boolean> {
    const outcome = await this.call('cas', record.id, encode(record), revision)
    if (outcome === -1) throw new Error('replacement must increment the revision')
    if (outcome === -2) throw new Error('cancellation intent cannot be cleared')
    if (outcome === -3) throw new Error('execution identity cannot change')
    return outcome === 1
  }

  async waitForChange(
    id: string,
    revision: number,
    timeoutSeconds?: number,
    signal?: AbortSignal,
  ): Promise<ExecutionRecord | null> {
    const deadline =
      timeoutSeconds === undefined ? Infinity : performance.now() + timeoutSeconds * 1000
    for (;;) {
      let wake!: () => void
      const changed = new Promise<void>((resolve) => {
        wake = resolve
      })
      this.listeners.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const record = await this.get(id)
        const remaining = Math.min(POLL_SECONDS * 1000, deadline - performance.now())
        if (record?.revision !== revision || remaining <= 0 || signal?.aborted === true)
          return record
        timer = setTimeout(wake, remaining)
        await changed
      } finally {
        clearTimeout(timer)
        this.listeners.delete(wake)
        signal?.removeEventListener('abort', wake)
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const listener of this.listeners) listener()
    await this.redis.close()
  }
}
