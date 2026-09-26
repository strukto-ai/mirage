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

import { ProcessSupervisor } from '../../process/supervisor.ts'
import { PathSpec } from '../../types.ts'
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
async function settle(run: JobRunner, job: Job): Promise<number> {
  let result: JobResult
  try {
    if (job.abort?.signal.aborted) throw new DOMException('aborted', 'AbortError')
    result = await run(job)
  } catch (err) {
    // A job killed while it was still running is already settled; the
    // runner unwinding afterwards must not reopen or relabel it.
    if (job.status !== JobStatus.RUNNING) return isAbortError(err) ? KILLED_EXIT_CODE : 1
    if (isAbortError(err)) {
      job.status = JobStatus.KILLED
      job.exitCode = KILLED_EXIT_CODE
      await job.console.emit(Channel.STDERR, new TextEncoder().encode('Killed'))
      await job.console.finish(KILLED_OUTCOME)
      return KILLED_EXIT_CODE
    }
    // Recorded as the job's output and exit status rather than
    // rethrown: nobody awaits this task, so rethrowing would only
    // strand the error in an unhandled rejection.
    job.status = JobStatus.COMPLETED
    job.exitCode = 1
    const msg = err instanceof Error ? err.message : String(err)
    await job.console.emit(Channel.STDERR, new TextEncoder().encode(msg))
    await job.console.finish(exitOutcome(1))
    return 1
  }
  const [ioResult, execNode] = result
  if (job.status !== JobStatus.RUNNING) return ioResult.exitCode
  job.ioResult = ioResult
  job.executionNode = execNode
  job.exitCode = ioResult.exitCode
  job.status = JobStatus.COMPLETED
  await job.console.finish(exitOutcome(job.exitCode))
  return ioResult.exitCode
}

/**
 * The shell's job table: bash's per-shell job list, one list per session.
 *
 * This is job control, not a process table. A job is numbered `%N`
 * within the session that launched it, numbering restarts at 1 once that
 * session's list empties (GNU bash), and `jobs`, `wait`, `fg`, `kill` and
 * `disown` only ever see the calling session's list, exactly as one bash
 * never lists another bash's jobs. Runner PIDs are tracked separately:
 * `$!` and `jobs -l` report the managed PID, while `%N` names a
 * session-local job number. A KILLED job ends its console; its process
 * remains stopping until the runner actually finishes.
 *
 * The table is still owned by the workspace rather than by a session,
 * because the workspace owns the tasks: teardown must stop every job in
 * every session (`killAll`), snapshot capture reads every finished one
 * (`allJobs`), and a disowned job keeps running after its shell forgot
 * it. Those are the only cross-session doors; every other method takes
 * the session whose list it reads, and the empty session id is the list
 * a caller with no session (a bare table in a test) shares.
 */
export class JobTable {
  private readonly jobs = new Map<string, Map<number, Job>>()
  private readonly nextIds = new Map<string, number>()
  private readonly consoleFactory: ConsoleFactory | null
  private factoryConsoles: JobConsole[] = []
  // Jobs `disown` removed while still running: the shell forgets them,
  // the workspace still owns their tasks so teardown can stop them.
  private disowned: Job[] = []

  /**
   * @param consoleFactory builds each new job's console from its job
   *   id; null means an in-memory console per job. A factory must hand
   *   every job a fresh backing: ids restart at 1 when a session's list
   *   empties (GNU numbering) and two sessions can both hold a job 1,
   *   so a store keyed on the id alone gets reused, and a reused stream
   *   replays the previous job's chunks, ending chunk included. The
   *   table tracks what the factory builds and closeConsoles() releases
   *   it at workspace teardown, because a config-provisioned store (a
   *   Redis client per job) is invisible to the embedder; a console
   *   still outlives its table entry, so reap() never closes one.
   */
  constructor(
    consoleFactory: ConsoleFactory | null = null,
    readonly processes = new ProcessSupervisor(),
  ) {
    this.consoleFactory = consoleFactory
  }

  private sessionJobs(sessionId: string): Map<number, Job> {
    let jobs = this.jobs.get(sessionId)
    if (jobs === undefined) {
      jobs = new Map()
      this.jobs.set(sessionId, jobs)
    }
    return jobs
  }

  /**
   * Register a job in its session's list and start it.
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
    parentPid?: number | null
  }): Job {
    const sessionId = init.sessionId ?? ''
    const jobs = this.sessionJobs(sessionId)
    // GNU bash restarts job numbering at 1 once the job list empties.
    // Without this, reaping after a targeted `wait` would leave a
    // later `wait %1` pointing at nothing.
    if (jobs.size === 0) this.nextIds.set(sessionId, 1)
    const jobId = this.nextIds.get(sessionId) ?? 1
    let jobConsole: JobConsole
    if (this.consoleFactory === null) {
      jobConsole = new JobConsole()
    } else {
      jobConsole = this.consoleFactory(jobId)
      this.factoryConsoles.push(jobConsole)
    }
    const job = new Job({
      id: jobId,
      command: init.command,
      abort: init.abort,
      cwd: init.cwd,
      agent: init.agent ?? 'unknown',
      sessionId,
      console: jobConsole,
    })
    jobs.set(job.id, job)
    this.nextIds.set(sessionId, jobId + 1)
    job.process = this.processes.start({
      sessionId,
      parentPid: init.parentPid ?? null,
      command: init.command,
      cwd: PathSpec.fromStrPath(init.cwd),
      run: async () => {
        if (job.status === JobStatus.RUNNING) return settle(init.run, job)
        return job.exitCode
      },
      cancel: () => {
        init.abort.abort()
      },
    })
    const process = job.process
    const onAbort = () => {
      process.terminate()
    }
    init.abort.signal.addEventListener('abort', onAbort, { once: true })
    if (init.abort.signal.aborted) process.terminate()
    job.task = process.join().then(() => {
      init.abort.signal.removeEventListener('abort', onAbort)
    })
    return job
  }

  /** Insert a finished job restored from a snapshot into its session. */
  loadJob(job: Job): void {
    this.sessionJobs(job.sessionId).set(job.id, job)
    if (job.id >= (this.nextIds.get(job.sessionId) ?? 1)) {
      this.nextIds.set(job.sessionId, job.id + 1)
    }
  }

  get(jobId: number, sessionId = ''): Job | null {
    return this.jobs.get(sessionId)?.get(jobId) ?? null
  }

  listJobs(sessionId = ''): Job[] {
    return [...(this.jobs.get(sessionId)?.values() ?? [])]
  }

  runningJobs(sessionId = ''): Job[] {
    return this.listJobs(sessionId).filter((j) => j.status === JobStatus.RUNNING)
  }

  /**
   * Every session's jobs, for the workspace-wide doors only. Snapshot
   * capture and the server summary read this; a shell builtin never
   * does, since bash lists only its own jobs.
   */
  allJobs(): Job[] {
    return [...this.jobs.values()].flatMap((jobs) => [...jobs.values()])
  }

  allRunningJobs(): Job[] {
    return this.allJobs().filter((j) => j.status === JobStatus.RUNNING)
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
  async kill(jobId: number, sessionId = ''): Promise<boolean> {
    const job = this.get(jobId, sessionId)
    if (job?.status !== JobStatus.RUNNING) return false
    if (job.process !== null) job.process.terminate()
    else job.abort?.abort()
    job.status = JobStatus.KILLED
    job.exitCode = KILLED_EXIT_CODE
    await job.console.emit(Channel.STDERR, new TextEncoder().encode('Killed'))
    await job.console.finish(KILLED_OUTCOME)
    return true
  }

  /**
   * Drop a job from its session's list without stopping it (`disown`):
   * the job keeps running, `jobs` no longer lists it and `wait` no
   * longer knows it. It stays on a side list so `killAll` at teardown
   * reaches its task.
   */
  disown(jobId: number, sessionId = ''): boolean {
    const jobs = this.jobs.get(sessionId)
    const job = jobs?.get(jobId)
    if (jobs === undefined || job === undefined) return false
    jobs.delete(jobId)
    if (job.status === JobStatus.RUNNING) this.disowned.push(job)
    return true
  }

  /**
   * Drop a session's job list when the session closes, stopping what is
   * still running, and return what was stopped.
   *
   * What happens to a bash's jobs when that bash exits: they are hung
   * up, and a later shell that reuses the same id starts from an empty
   * list numbered from 1 rather than inheriting jobs it never launched,
   * under a profile it may not share. Session closure revokes process
   * doors and stops disowned runners too.
   */
  async closeSession(sessionId: string): Promise<Job[]> {
    const running = this.runningJobs(sessionId)
    for (const job of running) await this.kill(job.id, sessionId)
    this.processes.revokeSession(sessionId)
    this.jobs.delete(sessionId)
    this.nextIds.delete(sessionId)
    return running
  }

  /** Stop every running job in every session, returning the ones that
   * were running. Disowned jobs are stopped too: the shell forgot them,
   * the workspace did not, and a teardown that left them running would
   * leak tasks. */
  async killAll(): Promise<Job[]> {
    const running = this.allRunningJobs()
    for (const job of running) {
      await this.kill(job.id, job.sessionId)
    }
    for (const job of this.disowned) {
      if (job.status === JobStatus.RUNNING) {
        if (job.process !== null) job.process.terminate()
        else job.abort?.abort()
        job.status = JobStatus.KILLED
        job.exitCode = KILLED_EXIT_CODE
        await job.console.emit(Channel.STDERR, new TextEncoder().encode('Killed'))
        await job.console.finish(KILLED_OUTCOME)
      }
    }
    this.disowned = []
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
  async wait(jobId: number, sessionId = ''): Promise<Job> {
    const job = this.get(jobId, sessionId)
    if (job === null) {
      throw new Error(`unknown job: ${jobId.toString()}`)
    }
    if (job.task === null) return job
    await job.console.waitFinished()
    return job
  }

  /**
   * Join every job in a session's list, returning the ones still
   * running.
   *
   * Every job, not only the running ones: a killed job's `Killed`
   * marker can still be in flight (see wait()), and bare `wait`
   * snapshots each console right after this returns. Joining a
   * finished job costs one read.
   */
  async waitAll(sessionId = ''): Promise<Job[]> {
    const running = this.runningJobs(sessionId)
    for (const job of this.listJobs(sessionId)) {
      await this.wait(job.id, sessionId)
    }
    return running
  }

  /**
   * Remove one job from its session's list.
   *
   * What a targeted `wait`/`fg` does after adopting the job's output,
   * matching GNU bash, where a job waited on by id is deleted from the
   * job list. Leaving it would let a later bare `wait` snapshot the
   * same console and print the output twice.
   */
  reap(jobId: number, sessionId = ''): void {
    this.jobs.get(sessionId)?.delete(jobId)
  }

  /**
   * Return a session's completed/killed jobs and remove them from its
   * list.
   *
   * A reader holding a job's console keeps reading it: the console
   * outlives its table entry and dies with its last reader.
   */
  popCompleted(sessionId = ''): Job[] {
    const jobs = this.jobs.get(sessionId)
    if (jobs === undefined) return []
    const completed = [...jobs.values()].filter((j) => j.status !== JobStatus.RUNNING)
    for (const j of completed) jobs.delete(j.id)
    return completed
  }
}
