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

import type { ByteSource, IOResult } from '../io/types.ts'
import type { ExecutionNode } from '../workspace/types.ts'

export const JobStatus = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  KILLED: 'killed',
} as const)

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus]

export type JobTaskResult = [ByteSource | null, IOResult, ExecutionNode]

export class Job {
  readonly id: number
  readonly command: string
  // null for jobs restored from a snapshot (already finished, no live task).
  readonly task: Promise<JobTaskResult> | null
  readonly abort: AbortController | null
  readonly cwd: string
  readonly agent: string
  readonly sessionId: string
  readonly createdAt: number

  status: JobStatus = JobStatus.RUNNING
  stdout: Uint8Array = new Uint8Array()
  stderr: Uint8Array = new Uint8Array()
  exitCode = 0
  executionNode: ExecutionNode | null = null
  ioResult: IOResult | null = null

  constructor(init: {
    id: number
    command: string
    task?: Promise<JobTaskResult> | null
    abort?: AbortController | null
    cwd: string
    agent?: string
    sessionId?: string
    createdAt?: number
    status?: JobStatus
    stdout?: Uint8Array
    stderr?: Uint8Array
    exitCode?: number
  }) {
    this.id = init.id
    this.command = init.command
    this.task = init.task ?? null
    this.abort = init.abort ?? null
    this.cwd = init.cwd
    this.agent = init.agent ?? 'unknown'
    this.sessionId = init.sessionId ?? ''
    this.createdAt = init.createdAt ?? Date.now() / 1000
    if (init.status !== undefined) this.status = init.status
    if (init.stdout !== undefined) this.stdout = init.stdout
    if (init.stderr !== undefined) this.stderr = init.stderr
    if (init.exitCode !== undefined) this.exitCode = init.exitCode
  }
}

export class JobTable {
  private readonly jobs = new Map<number, Job>()
  private nextId = 1

  submit(init: {
    command: string
    task: Promise<JobTaskResult>
    abort: AbortController
    cwd: string
    agent?: string
    sessionId?: string
  }): Job {
    const job = new Job({ id: this.nextId, ...init })
    this.jobs.set(job.id, job)
    this.nextId += 1
    return job
  }

  loadJob(job: Job): void {
    this.jobs.set(job.id, job)
    if (job.id >= this.nextId) this.nextId = job.id + 1
  }

  get(jobId: number): Job | null {
    return this.jobs.get(jobId) ?? null
  }

  listJobs(): Job[] {
    return [...this.jobs.values()]
  }

  runningJobs(): Job[] {
    return [...this.jobs.values()].filter((j) => j.status === JobStatus.RUNNING)
  }

  kill(jobId: number): boolean {
    const job = this.jobs.get(jobId)
    if (job === undefined) return false
    job.abort?.abort()
    job.status = JobStatus.KILLED
    job.exitCode = 137
    job.stderr = new TextEncoder().encode('Killed')
    return true
  }

  async wait(jobId: number): Promise<Job> {
    const job = this.jobs.get(jobId)
    if (job === undefined) {
      throw new Error(`unknown job: ${jobId.toString()}`)
    }
    if (job.status !== JobStatus.RUNNING) return job
    if (job.task === null) return job
    try {
      const [stdout, ioResult, execNode] = await job.task
      job.stdout = stdout instanceof Uint8Array ? stdout : new Uint8Array()
      job.ioResult = ioResult
      job.executionNode = execNode
      ioResult.syncExitCode()
      job.exitCode = ioResult.exitCode
      job.stderr = await ioResult.materializeStderr()
      job.status = JobStatus.COMPLETED
    } catch (err) {
      if (isAbortError(err)) {
        job.status = JobStatus.KILLED
        job.exitCode = 137
        job.stderr = new TextEncoder().encode('Killed')
      } else {
        job.status = JobStatus.COMPLETED
        job.exitCode = 1
        const msg = err instanceof Error ? err.message : String(err)
        job.stderr = new TextEncoder().encode(msg)
      }
    }
    return job
  }

  async waitAll(): Promise<Job[]> {
    const running = this.runningJobs()
    for (const job of running) {
      await this.wait(job.id)
    }
    return running
  }

  popCompleted(): Job[] {
    const completed = [...this.jobs.values()].filter((j) => j.status !== JobStatus.RUNNING)
    for (const j of completed) this.jobs.delete(j.id)
    return completed
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true
  if (err instanceof DOMException && err.name === 'AbortError') return true
  return false
}
