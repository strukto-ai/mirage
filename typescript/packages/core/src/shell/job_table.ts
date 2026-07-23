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

import type { IOResult } from '../io/types.ts'
import type { ExecutionNode } from '../workspace/types.ts'
import { Channel, JobConsole, KILLED_OUTCOME, exitOutcome } from './console/index.ts'

export const JobStatus = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  KILLED: 'killed',
} as const)

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus]

export const KILLED_EXIT_CODE = 137

export type JobResult = [IOResult, ExecutionNode]

/** Produces a job's output and its result. */
export type JobRunner = (job: Job) => Promise<JobResult>

/**
 * One background command, and everything it has printed.
 *
 * Output lives in `console` rather than in byte fields, so a reader can
 * watch a job while it runs instead of waiting for it to end.
 */
export class Job {
  readonly id: number
  readonly command: string
  // null for jobs restored from a snapshot (already finished, no live task).
  task: Promise<void> | null
  readonly abort: AbortController | null
  readonly cwd: string
  readonly agent: string
  readonly sessionId: string
  readonly createdAt: number
  readonly console: JobConsole

  status: JobStatus = JobStatus.RUNNING
  exitCode = 0
  executionNode: ExecutionNode | null = null
  ioResult: IOResult | null = null

  constructor(init: {
    id: number
    command: string
    task?: Promise<void> | null
    abort?: AbortController | null
    cwd: string
    agent?: string
    sessionId?: string
    createdAt?: number
    status?: JobStatus
    exitCode?: number
    console?: JobConsole
  }) {
    this.id = init.id
    this.command = init.command
    this.task = init.task ?? null
    this.abort = init.abort ?? null
    this.cwd = init.cwd
    this.agent = init.agent ?? 'unknown'
    this.sessionId = init.sessionId ?? ''
    this.createdAt = init.createdAt ?? Date.now() / 1000
    this.console = init.console ?? new JobConsole()
    if (init.status !== undefined) this.status = init.status
    if (init.exitCode !== undefined) this.exitCode = init.exitCode
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true
  if (err instanceof DOMException && err.name === 'AbortError') return true
  return false
}

/**
 * Run a job to completion and record how it ended.
 *
 * Every write to a job's status, exit code, and console ending happens
 * here, so the table has exactly one writer. The runner only produces
 * output.
 *
 * Status is set before the console is finished, so a reader released by
 * the ending chunk always sees settled fields.
 */
async function settle(run: JobRunner, job: Job): Promise<void> {
  let result: JobResult
  try {
    result = await run(job)
  } catch (err) {
    // A job killed while it was still running is already settled; the
    // runner unwinding afterwards must not reopen or relabel it.
    if (job.status !== JobStatus.RUNNING) return
    if (isAbortError(err)) {
      job.status = JobStatus.KILLED
      job.exitCode = KILLED_EXIT_CODE
      await job.console.emit(Channel.STDERR, new TextEncoder().encode('Killed'))
      await job.console.finish(KILLED_OUTCOME)
      return
    }
    // Recorded as the job's output and exit status rather than
    // rethrown: nobody awaits this task, so rethrowing would only
    // strand the error in an unhandled rejection.
    job.status = JobStatus.COMPLETED
    job.exitCode = 1
    const msg = err instanceof Error ? err.message : String(err)
    await job.console.emit(Channel.STDERR, new TextEncoder().encode(msg))
    await job.console.finish(exitOutcome(1))
    return
  }
  if (job.status !== JobStatus.RUNNING) return
  const [ioResult, execNode] = result
  job.ioResult = ioResult
  job.executionNode = execNode
  ioResult.syncExitCode()
  job.exitCode = ioResult.exitCode
  job.status = JobStatus.COMPLETED
  await job.console.finish(exitOutcome(job.exitCode))
}

export class JobTable {
  private readonly jobs = new Map<number, Job>()
  private nextId = 1

  /**
   * Register a job and start it.
   *
   * The table creates the task itself so the runner is handed a job that
   * already has a console. Building the task first would leave a window
   * in which output could arrive with nowhere to go.
   */
  submit(init: {
    command: string
    run: JobRunner
    abort: AbortController
    cwd: string
    agent?: string
    sessionId?: string
  }): Job {
    // GNU bash restarts job numbering at 1 once the job list empties.
    // Without this, reaping after a targeted `wait` would leave a
    // later `wait %1` pointing at nothing.
    if (this.jobs.size === 0) this.nextId = 1
    const job = new Job({
      id: this.nextId,
      command: init.command,
      abort: init.abort,
      cwd: init.cwd,
      agent: init.agent ?? 'unknown',
      sessionId: init.sessionId ?? '',
    })
    this.jobs.set(job.id, job)
    this.nextId += 1
    job.task = settle(init.run, job)
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

  /**
   * Stop a job and wait for it to actually be dead.
   *
   * The abort signal reaches the executor, which checks it at every
   * node, so aborting genuinely ends the walk rather than leaving it
   * running. That is what makes joining here safe, and it keeps the
   * single-writer rule intact: `settle` records the killed status, not
   * this method.
   */
  async kill(jobId: number): Promise<boolean> {
    const job = this.jobs.get(jobId)
    if (job?.status !== JobStatus.RUNNING) return false
    job.abort?.abort()
    await job.console.waitFinished()
    return true
  }

  /** Stop every running job, returning the ones that were running. */
  async killAll(): Promise<Job[]> {
    const running = this.runningJobs()
    for (const job of running) {
      await this.kill(job.id)
    }
    return running
  }

  /** Block until a job ends, then return it. */
  async wait(jobId: number): Promise<Job> {
    const job = this.jobs.get(jobId)
    if (job === undefined) {
      throw new Error(`unknown job: ${jobId.toString()}`)
    }
    if (job.status !== JobStatus.RUNNING) return job
    if (job.task === null) return job
    await job.console.waitFinished()
    return job
  }

  async waitAll(): Promise<Job[]> {
    const running = this.runningJobs()
    for (const job of running) {
      await this.wait(job.id)
    }
    return running
  }

  /**
   * Remove one job from the table.
   *
   * What a targeted `wait`/`fg` does after adopting the job's output,
   * matching GNU bash, where a job waited on by id is deleted from the
   * job list. Leaving it would let a later bare `wait` snapshot the
   * same console and print the output twice.
   */
  reap(jobId: number): void {
    this.jobs.delete(jobId)
  }

  /**
   * Return completed/killed jobs and remove them from the table.
   *
   * A reader holding a job's console keeps reading it: the console
   * outlives its table entry and dies with its last reader.
   */
  popCompleted(): Job[] {
    const completed = [...this.jobs.values()].filter((j) => j.status !== JobStatus.RUNNING)
    for (const j of completed) this.jobs.delete(j.id)
    return completed
  }
}
