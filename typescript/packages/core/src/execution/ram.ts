import { ExecutionStore } from './base.ts'
import type { ExecutionRecord } from './types.ts'

/** One event loop owns the records; only completed records expire. */
export class RAMExecutionStore extends ExecutionStore {
  private records = new Map<string, ExecutionRecord>()
  private completed = new Map<string, ExecutionRecord>()
  private listeners = new Set<() => void>()
  private closed = false

  constructor(
    private maxCompleted = 1024,
    private retentionSeconds = 3600,
  ) {
    super()
    if (maxCompleted < 1 || retentionSeconds <= 0)
      throw new Error('execution retention limits must be positive')
  }

  private prune(): void {
    if (this.closed) throw new Error('execution store is closed')
    const cutoff = Date.now() / 1000 - this.retentionSeconds
    const completed = [...this.completed].sort(
      (a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0),
    )
    for (const [id, record] of completed) {
      if (
        this.completed.size <= this.maxCompleted &&
        record.finishedAt !== null &&
        record.finishedAt > cutoff
      )
        break
      this.completed.delete(id)
      this.records.delete(id)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  create(record: ExecutionRecord): Promise<boolean> {
    this.prune()
    if (this.records.has(record.id)) return Promise.resolve(false)
    const snapshot = structuredClone(record)
    this.records.set(record.id, snapshot)
    if (record.finishedAt !== null) this.completed.set(record.id, snapshot)
    this.prune()
    this.notify()
    return Promise.resolve(true)
  }

  get(id: string): Promise<ExecutionRecord | null> {
    this.prune()
    return Promise.resolve(structuredClone(this.records.get(id) ?? null))
  }

  list(workspaceId?: string): Promise<ExecutionRecord[]> {
    this.prune()
    return Promise.resolve(
      [...this.records.values()]
        .filter((r) => workspaceId === undefined || r.workspaceId === workspaceId)
        .map((r) => ({ ...r, result: null })),
    )
  }

  compareAndSet(record: ExecutionRecord, revision: number): Promise<boolean> {
    this.prune()
    const previous = this.records.get(record.id)
    if (previous?.revision !== revision || previous.finishedAt !== null)
      return Promise.resolve(false)
    if (record.revision !== revision + 1) throw new Error('replacement must increment the revision')
    if (previous.cancelRequested && !record.cancelRequested)
      throw new Error('cancellation intent cannot be cleared')
    if (
      record.workspaceId !== previous.workspaceId ||
      record.sessionId !== previous.sessionId ||
      record.command !== previous.command
    )
      throw new Error('execution identity cannot change')
    const snapshot = structuredClone(record)
    this.records.set(record.id, snapshot)
    if (record.finishedAt !== null) this.completed.set(record.id, snapshot)
    this.prune()
    this.notify()
    return Promise.resolve(true)
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
        const remaining = deadline - performance.now()
        if (record?.revision !== revision || remaining <= 0 || signal?.aborted === true)
          return record
        if (Number.isFinite(remaining)) timer = setTimeout(wake, Math.min(remaining, 2_147_483_647))
        await changed
      } finally {
        clearTimeout(timer)
        this.listeners.delete(wake)
        signal?.removeEventListener('abort', wake)
      }
    }
  }

  close(): Promise<void> {
    this.closed = true
    this.notify()
    return Promise.resolve()
  }
}
