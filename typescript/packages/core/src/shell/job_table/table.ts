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

import { Channel, JobConsole, KILLED_OUTCOME, exitOutcome } from '../console/index.ts'
import { KILLED_EXIT_CODE } from './constants.ts'
import { type ConsoleFactory, Job, type JobResult, type JobRunner, JobStatus } from './types.ts'

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
  job.exitCode = ioResult.exitCode
  job.status = JobStatus.COMPLETED
  await job.console.finish(exitOutcome(job.exitCode))
}

export class JobTable {
  private readonly jobs = new Map<number, Job>()
  private nextId = 1
  private readonly consoleFactory: ConsoleFactory | null
  private factoryConsoles: JobConsole[] = []

  /**
   * @param consoleFactory builds each new job's console from its job
   *   id; null means an in-memory console per job. A factory must hand
   *   every job a fresh backing: ids restart at 1 when the table
   *   empties (GNU numbering), so a store keyed on the id alone gets
   *   reused, and a reused stream replays the previous job's chunks,
   *   ending chunk included. The table tracks what the factory builds
   *   and closeConsoles() releases it at workspace teardown, because a
   *   config-provisioned store (a Redis client per job) is invisible
   *   to the embedder; a console still outlives its table entry, so
   *   reap() never closes one.
   */
  constructor(consoleFactory: ConsoleFactory | null = null) {
    this.consoleFactory = consoleFactory
  }

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
    let jobConsole: JobConsole
    if (this.consoleFactory === null) {
      jobConsole = new JobConsole()
    } else {
      jobConsole = this.consoleFactory(this.nextId)
      this.factoryConsoles.push(jobConsole)
    }
    const job = new Job({
      id: this.nextId,
      command: init.command,
      abort: init.abort,
      cwd: init.cwd,
      agent: init.agent ?? 'unknown',
      sessionId: init.sessionId ?? '',
      console: jobConsole,
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
   * Stop a job and record it as killed.
   *
   * The job is settled here rather than by waiting for the aborted
   * runner to unwind. The signal is only observed where someone checks
   * it, which today is the executor between nodes and the commands that
   * take it, so a job sitting inside one long command would not notice
   * until it finished on its own. Joining would hang the shell on
   * exactly the runaway job the caller is trying to stop.
   *
   * The console's own guards make the early ending safe: emits after the
   * ending chunk are dropped, so a runner still unwinding cannot append
   * past its own death, and `settle` returns early once the job is no
   * longer RUNNING so it cannot relabel it.
   */
  async kill(jobId: number): Promise<boolean> {
    const job = this.jobs.get(jobId)
    if (job?.status !== JobStatus.RUNNING) return false
    job.abort?.abort()
    job.status = JobStatus.KILLED
    job.exitCode = KILLED_EXIT_CODE
    await job.console.emit(Channel.STDERR, new TextEncoder().encode('Killed'))
    await job.console.finish(KILLED_OUTCOME)
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

  /**
   * Close every console the factory built, releasing its store.
   *
   * Called by workspace teardown after killAll(). Only tracked,
   * factory-built consoles are closed: the default in-memory ones hold
   * nothing, while a factory-provisioned store keeps a client open per
   * job, and in Node an open client holds the process alive. Closing
   * also releases any reader still parked on one.
   */
  async closeConsoles(): Promise<void> {
    const consoles = this.factoryConsoles
    this.factoryConsoles = []
    for (const jobConsole of consoles) {
      await jobConsole.close()
    }
  }

  /**
   * Block until a job ends, then return it.
   *
   * Joined on the console's ending chunk, never on the status field:
   * kill() and settle() both flip the status before their final
   * appends, and every await yields a microtask, so a status-based
   * return could let the caller snapshot and reap the job before
   * `Killed` or the ending chunk is persisted. A restored job has no
   * task and its console already holds the ending chunk, so it
   * returns without waiting.
   */
  async wait(jobId: number): Promise<Job> {
    const job = this.jobs.get(jobId)
    if (job === undefined) {
      throw new Error(`unknown job: ${jobId.toString()}`)
    }
    if (job.task === null) return job
    await job.console.waitFinished()
    return job
  }

  /**
   * Join every job in the table, returning the ones still running.
   *
   * Every job, not only the running ones: a killed job's `Killed`
   * marker can still be in flight (see wait()), and bare `wait`
   * snapshots each console right after this returns. Joining a
   * finished job costs one read.
   */
  async waitAll(): Promise<Job[]> {
    const running = this.runningJobs()
    for (const job of this.listJobs()) {
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
