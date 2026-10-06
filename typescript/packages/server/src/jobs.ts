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

import { randomBytes } from 'node:crypto'
import type { ExecutionStore } from '@struktoai/mirage-core/execution/base'
import { RAMExecutionStore } from '@struktoai/mirage-core/execution/ram'
import {
  ExecutionStatus as JobStatus,
  type ExecutionRecord as JobEntry,
} from '@struktoai/mirage-core/execution/types'
import { ExecutionScope } from '@struktoai/mirage-core/workspace/execution'
import type { JsonValue } from '@struktoai/mirage-core/types'

export { JobStatus, type JobEntry }

function newJobId(): string {
  return `job_${randomBytes(8).toString('hex')}`
}

interface Run {
  controller: AbortController
  completion: Promise<void>
  publicationError: unknown
  settled: AbortController
}

/**
 * Local execution owner over an asynchronous record store.
 *
 * Submit persists admission before any work starts. A shell marks running
 * only after acquiring its session. Cancellation is an intent; completion
 * is published after the work and its cleanup settle.
 */
export class JobTable {
  readonly store: ExecutionStore
  private ownsStore: boolean
  private live = new Map<string, Run>()
  private closed = false
  private closing: Promise<void> | undefined

  constructor(store?: ExecutionStore) {
    this.store = store ?? new RAMExecutionStore()
    this.ownsStore = store === undefined
  }

  private isClosed(): boolean {
    return this.closed
  }

  async get(id: string): Promise<JobEntry> {
    const record = await this.store.get(id)
    if (record === null) throw new Error(`job not found: ${id}`)
    return record
  }

  async list(workspaceId?: string): Promise<JobEntry[]> {
    return this.store.list(workspaceId)
  }

  private async change(
    id: string,
    update: (record: JobEntry) => JobEntry | null,
  ): Promise<[JobEntry, boolean]> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const current = await this.get(id)
      const replacement = update(current)
      if (replacement === null || current.finishedAt !== null) return [current, false]
      const next = { ...replacement, revision: current.revision + 1 }
      if (await this.store.compareAndSet(next, current.revision)) return [next, true]
    }
    throw new Error('execution record changed too often')
  }

  private async started(id: string): Promise<void> {
    const [record] = await this.change(id, (r) =>
      r.cancelRequested
        ? null
        : {
            ...r,
            status: JobStatus.RUNNING,
            startedAt: Date.now() / 1000,
          },
    )
    if (record.cancelRequested || record.finishedAt !== null)
      throw new DOMException('execution canceled', 'AbortError')
  }

  async submit(
    workspaceId: string,
    command: string,
    factory: (signal: AbortSignal, scope: ExecutionScope) => Promise<JsonValue>,
    sessionId: string,
  ): Promise<JobEntry> {
    if (this.isClosed()) throw new Error('job table is closed')
    const record: JobEntry = {
      id: newJobId(),
      workspaceId,
      sessionId,
      command,
      submittedAt: Date.now() / 1000,
      status: JobStatus.PENDING,
      revision: 0,
      cancelRequested: false,
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    }
    if (!(await this.store.create(record))) throw new Error('duplicate execution id')
    if (this.isClosed()) {
      await this.change(record.id, (r) => ({
        ...r,
        status: JobStatus.CANCELED,
        cancelRequested: true,
        finishedAt: Date.now() / 1000,
      }))
      throw new Error('job table is closed')
    }
    const control: Run = {
      controller: new AbortController(),
      completion: Promise.resolve(),
      publicationError: null,
      settled: new AbortController(),
    }
    this.live.set(record.id, control)
    control.completion = this.run(record.id, control, factory)
    return record
  }

  private async run(
    id: string,
    control: Run,
    factory: (signal: AbortSignal, scope: ExecutionScope) => Promise<JsonValue>,
  ): Promise<void> {
    let status: JobStatus = JobStatus.DONE
    let result: JsonValue = null
    let error: string | null = null
    try {
      control.controller.signal.throwIfAborted()
      result = await factory(control.controller.signal, new ExecutionScope(() => this.started(id)))
    } catch (err) {
      // The job's own cancel aborts its controller; the workspace's (a
      // session or workspace cancel) rejects the line with the abort error.
      if (err instanceof DOMException && err.name === 'AbortError') {
        status = JobStatus.CANCELED
      } else {
        status = JobStatus.FAILED
        error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      }
    }
    try {
      await this.change(id, (r) => ({
        ...r,
        status:
          r.cancelRequested || control.controller.signal.aborted ? JobStatus.CANCELED : status,
        result:
          status === JobStatus.DONE && !r.cancelRequested && !control.controller.signal.aborted
            ? result
            : null,
        cancelRequested: r.cancelRequested || control.controller.signal.aborted,
        error,
        finishedAt: Date.now() / 1000,
      }))
      this.live.delete(id)
    } catch (err) {
      control.publicationError = err
      console.error(`could not publish completion of ${id}`, err)
    } finally {
      control.settled.abort()
    }
  }

  async wait(id: string, timeoutSeconds?: number): Promise<JobEntry> {
    const deadline =
      timeoutSeconds === undefined
        ? Infinity
        : performance.now() + Math.max(0, timeoutSeconds) * 1000
    const control = this.live.get(id)
    let record = await this.get(id)
    while (record.finishedAt === null) {
      if (control?.publicationError != null)
        throw new Error('execution completion could not be published', {
          cause: control.publicationError,
        })
      const remaining = (deadline - performance.now()) / 1000
      if (remaining <= 0) break
      const changed = await this.store.waitForChange(
        id,
        record.revision,
        timeoutSeconds === undefined ? undefined : remaining,
        control?.settled.signal,
      )
      if (changed === null) throw new Error(`job not found: ${id}`)
      record = changed
    }
    return record
  }

  async cancel(id: string): Promise<boolean> {
    const [, accepted] = await this.change(id, (r) =>
      r.cancelRequested
        ? null
        : {
            ...r,
            cancelRequested: true,
            status: JobStatus.STOPPING,
          },
    )
    if (accepted) this.live.get(id)?.controller.abort()
    return accepted
  }

  close(): Promise<void> {
    this.closed = true
    return (this.closing ??= this.finishClose())
  }

  private async finishClose(): Promise<void> {
    const controls = [...this.live]
    const errors: unknown[] = []
    for (const [, control] of controls) control.controller.abort()
    for (const [id] of controls) {
      try {
        await this.cancel(id)
      } catch (error) {
        errors.push(error)
      }
    }
    await Promise.all(controls.map(([, control]) => control.completion))
    if (this.ownsStore) await this.store.close()
    if (errors.length > 0)
      throw new AggregateError(errors, 'could not record shutdown cancellation')
  }
}

export interface JobBriefDict {
  job_id: string
  workspace_id: string
  session_id: string
  command: string
  status: JobStatus
  revision: number
  cancel_requested: boolean
  submitted_at: number
  started_at: number | null
  finished_at: number | null
}

export function toBriefDict(entry: JobEntry): JobBriefDict {
  return {
    job_id: entry.id,
    workspace_id: entry.workspaceId,
    session_id: entry.sessionId,
    command: entry.command,
    status: entry.status,
    revision: entry.revision,
    cancel_requested: entry.cancelRequested,
    submitted_at: entry.submittedAt,
    started_at: entry.startedAt,
    finished_at: entry.finishedAt,
  }
}
