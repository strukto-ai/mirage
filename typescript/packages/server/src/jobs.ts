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

import { newExecutionId } from '@struktoai/mirage-core/execution/context'
import {
  ExecutionStatus as JobStatus,
  type ExecutionRecord as JobEntry,
} from '@struktoai/mirage-core/execution/types'
import { ExecutionScope } from '@struktoai/mirage-core/workspace/execution'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { FINISHED_JOB_RETENTION_SECONDS, MAX_FINISHED_JOBS } from './constants.ts'

export { JobStatus, type JobEntry }

interface Run {
  record: JobEntry
  controller: AbortController
  completion: Promise<void>
  settled: Promise<void>
}

/**
 * The server's executions: each one's record and the work running it.
 *
 * A shell marks running only after acquiring its session. Cancel stops the
 * work at once; the record finishes after the work and its cleanup settle.
 * Finished records are kept for an hour, the newest 1024 of them.
 */
export class JobTable {
  private runs = new Map<string, Run>()
  private closed = false
  private closing: Promise<void> | undefined

  get(id: string): JobEntry | null {
    return this.runs.get(id)?.record ?? null
  }

  list(workspaceId?: string): JobEntry[] {
    this.prune()
    return [...this.runs.values()]
      .map((run) => run.record)
      .filter((record) => workspaceId === undefined || record.workspaceId === workspaceId)
  }

  private prune(): void {
    const finished = [...this.runs.values()]
      .filter((run) => run.record.finishedAt !== null)
      .sort((a, b) => (a.record.finishedAt ?? 0) - (b.record.finishedAt ?? 0))
    const cutoff = Date.now() / 1000 - FINISHED_JOB_RETENTION_SECONDS
    const excess = finished.length - MAX_FINISHED_JOBS
    for (const [index, run] of finished.entries()) {
      if (index >= excess && (run.record.finishedAt ?? 0) > cutoff) break
      this.runs.delete(run.record.id)
    }
  }

  private started(run: Run): Promise<void> {
    if (run.record.cancelRequested) {
      return Promise.reject(new DOMException('execution canceled', 'AbortError'))
    }
    run.record = { ...run.record, status: JobStatus.RUNNING, startedAt: Date.now() / 1000 }
    return Promise.resolve()
  }

  submit(
    workspaceId: string,
    command: string,
    factory: (signal: AbortSignal, scope: ExecutionScope) => Promise<JsonValue>,
    sessionId: string,
  ): JobEntry {
    if (this.closed) throw new Error('job table is closed')
    this.prune()
    let settle!: () => void
    const run: Run = {
      record: {
        id: newExecutionId(),
        workspaceId,
        sessionId,
        command,
        submittedAt: Date.now() / 1000,
        status: JobStatus.PENDING,
        cancelRequested: false,
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
      },
      controller: new AbortController(),
      completion: Promise.resolve(),
      settled: new Promise<void>((resolve) => {
        settle = resolve
      }),
    }
    this.runs.set(run.record.id, run)
    run.completion = this.run(run, factory).finally(settle)
    return run.record
  }

  private async run(
    run: Run,
    factory: (signal: AbortSignal, scope: ExecutionScope) => Promise<JsonValue>,
  ): Promise<void> {
    let status: JobStatus = JobStatus.DONE
    let result: JsonValue = null
    let error: string | null = null
    try {
      run.controller.signal.throwIfAborted()
      result = await factory(
        run.controller.signal,
        new ExecutionScope(() => this.started(run), run.record.id),
      )
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
    if (run.record.cancelRequested) status = JobStatus.CANCELED
    run.record = {
      ...run.record,
      status,
      result: status === JobStatus.DONE ? result : null,
      error,
      finishedAt: Date.now() / 1000,
    }
  }

  /** The execution once it finishes, or as it stands at the timeout. */
  async wait(id: string, timeoutSeconds?: number): Promise<JobEntry> {
    const run = this.runs.get(id)
    if (run === undefined) throw new Error(`job not found: ${id}`)
    if (timeoutSeconds === undefined) {
      await run.settled
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        run.settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutSeconds) * 1000)
        }),
      ])
      clearTimeout(timer)
    }
    return run.record
  }

  /**
   * Wait for an execution on behalf of the caller that started it. A caller
   * that aborts cancels the execution, and the wait still lasts until its
   * cleanup settles, so the work never outlives the request that started it.
   */
  async join(id: string, signal?: AbortSignal): Promise<JobEntry> {
    const cancel = (): void => {
      this.cancel(id)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted === true) cancel()
    try {
      return await this.wait(id)
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  /** Stop an execution and record that it was asked to stop. Answers whether this call did. */
  cancel(id: string): boolean {
    const run = this.runs.get(id)
    if (run === undefined) throw new Error(`job not found: ${id}`)
    if (run.record.finishedAt !== null || run.record.cancelRequested) return false
    run.record = { ...run.record, cancelRequested: true, status: JobStatus.STOPPING }
    run.controller.abort()
    return true
  }

  /** Wait for an execution's work and cleanup to settle. */
  async drain(id: string): Promise<void> {
    await this.runs.get(id)?.completion
  }

  close(): Promise<void> {
    this.closed = true
    return (this.closing ??= this.finishClose())
  }

  private async finishClose(): Promise<void> {
    const runs = [...this.runs.values()]
    for (const run of runs) this.cancel(run.record.id)
    await Promise.all(runs.map((run) => run.completion))
  }
}

export interface JobBriefDict {
  job_id: string
  workspace_id: string
  session_id: string
  command: string
  status: JobStatus
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
    cancel_requested: entry.cancelRequested,
    submitted_at: entry.submittedAt,
    started_at: entry.startedAt,
    finished_at: entry.finishedAt,
  }
}
