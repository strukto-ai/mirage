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

import type { ProcessHandle } from '../../process/handle.ts'
import { ProcessTable } from '../../process/table.ts'
import { PathSpec } from '../../types.ts'
import {
  Channel,
  JobConsole,
  KILLED_OUTCOME,
  exitOutcome,
  killedOutcome,
} from '../console/index.ts'
import {
  HANGUP_EXIT_CODE,
  KILLED_EXIT_CODE,
  LIST_MAX_RETRIES,
  STOP_WAIT_SECONDS,
} from './constants.ts'
import { RAMJobStore } from './ram.ts'
import type { JobStore } from './store.ts'
import { Job, type JobResult, type JobRunner, JobStatus } from './types.ts'
import { encodeText } from '../bytes.ts'
import { SystemClock, type Clock } from '../../utils/clock.ts'
import { generationOf, type RecordFields } from '../../workspace/record/types.ts'

// One job's entry in its session's list.
interface ListEntry {
  command: string
  cwd: string
  created_at: number
  owner: string
  console: string
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true
  if (err instanceof DOMException && err.name === 'AbortError') return true
  return false
}

/** The status and exit code a console's ending records. */
function ended(outcome: string): [JobStatus, number] {
  const [form = '', code = '0'] = outcome.split(':')
  return [form === KILLED_OUTCOME ? JobStatus.KILLED : JobStatus.COMPLETED, Number(code)]
}

/**
 * The status a stopped job answers: the one its program exited with after
 * handling the signal, when the job is that one program, else 128 plus
 * the signal, KILL's 137 without one. Mirrors Python's `_stopped_status`.
 */
function stoppedStatus(job: Job): number {
  const code = job.process?.programCode ?? null
  if (job.simple && code !== null) return code
  const signal = job.process?.signal ?? null
  return signal === null ? KILLED_EXIT_CODE : 128 + signal
}

/** Write the kill marker and the ending chunk. Mirrors Python's `_mark_killed`. */
async function markKilled(console: JobConsole, exitCode: number): Promise<void> {
  await console.emit(Channel.STDERR, encodeText('Killed'))
  await console.finish(killedOutcome(exitCode))
}

/**
 * Stop a running job and settle it as killed by `signal`: its status is
 * 128 plus it. Mirrors Python's `_stop`.
 */
async function stop(job: Job, signal = 9): Promise<void> {
  job.process?.terminate(signal)
  job.status = JobStatus.KILLED
  job.exitCode = 128 + signal
  await markKilled(job.console, job.exitCode)
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
    if (job.status !== JobStatus.RUNNING) {
      if (!isAbortError(err)) return 1
      // Final only now the runner has ended: a program that handled the
      // signal leaves its own status.
      job.exitCode = stoppedStatus(job)
      return job.exitCode
    }
    if (isAbortError(err)) {
      const code = stoppedStatus(job)
      job.status = JobStatus.KILLED
      job.exitCode = code
      await markKilled(job.console, code)
      return code
    }
    // Recorded as the job's output and exit status rather than
    // rethrown: nobody awaits this task, so rethrowing would only
    // strand the error in an unhandled rejection.
    job.status = JobStatus.COMPLETED
    job.exitCode = 1
    const msg = err instanceof Error ? err.message : String(err)
    await job.console.emit(Channel.STDERR, encodeText(msg))
    await job.console.finish(exitOutcome(1))
    return 1
  }
  const [ioResult] = result
  if (job.status !== JobStatus.RUNNING) return ioResult.exitCode
  job.exitCode = ioResult.exitCode
  job.status = JobStatus.COMPLETED
  await job.console.finish(exitOutcome(job.exitCode))
  return ioResult.exitCode
}

/**
 * Stop a job this table runs if another workspace ended its console. A
 * `kill` elsewhere ends the job's console, the one record of how the job
 * ended, and this stops the runner the way a local kill does, with the
 * signal the ending implies. Mirrors Python's `_adopt_ending`.
 */
async function adoptEnding(job: Job): Promise<void> {
  if (job.status !== JobStatus.RUNNING) return
  const outcome = await job.console.outcome()
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the runner may settle it across the await
  if (outcome === null || job.status !== JobStatus.RUNNING) return
  ;[job.status, job.exitCode] = ended(outcome)
  job.process?.terminate(job.exitCode > 128 ? job.exitCode - 128 : 9)
}

/**
 * Stop a job this table runs once another workspace ends it.
 *
 * @param job the job, run by this table
 * @param signal aborted once its runner settles, ending the watch
 */
async function watch(job: Job, signal: AbortSignal): Promise<void> {
  await job.console.store.waitEnded(signal)
  if (!signal.aborted) await adoptEnding(job)
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
 * The lists live in the workspace's job store, so every workspace on a
 * shared store sees a session's jobs with the same numbers. A job runs on
 * the table that started it, its owner; another table lists it, reads and
 * waits on its console, and kills it by ending that console, which its
 * owner watches for. `sync` brings a session's list up to date before a
 * builtin reads it. A job whose owner's lease lapsed with no ending was
 * lost with its owner and is ended as hung up, as a bash's job is when its
 * terminal goes.
 *
 * The table is still owned by the workspace rather than by a session,
 * because the workspace owns the tasks: teardown must stop every job it
 * runs in every session (`killAll`), snapshot capture reads every finished
 * one (`allJobs`), and a disowned job keeps running after its shell forgot
 * it. Those are the only cross-session views; every other method takes
 * the session whose list it reads, and the empty session id is the list a
 * caller with no session (a bare table in a test) shares.
 */
export class JobTable {
  store: JobStore
  readonly owner = crypto.randomUUID().replaceAll('-', '')
  private jobs = new Map<string, Map<number, Job>>()
  // Jobs `disown` removed while still running: the shell forgets them,
  // the workspace still owns their tasks so teardown can stop them.
  private disowned: Job[] = []
  private lease: ReturnType<typeof setTimeout> | null = null

  /**
   * @param store the job plane holding each session's list and each job's
   *   console; null keeps them in memory, private to this table.
   */
  constructor(
    store: JobStore | null = null,
    readonly processes = new ProcessTable(),
    // The table of the shell a `$( )` is part of, whose jobs `jobs` still
    // lists there, as bash's does; its `wait` and `kill` reach none of them.
    readonly parent: JobTable | null = null,
    // The workspace clock a job's `createdAt` is read on.
    readonly clock: Clock = new SystemClock(),
  ) {
    this.store = store ?? new RAMJobStore()
  }

  /**
   * A table for a child shell (`bash -c`, a script, `( )`, `$( )`): a job
   * list of its own on the same processes, kept in memory, since a child
   * shell's jobs end with it on this workspace and no other one lists
   * them. `parent` is the table a `$( )` still lists in `jobs`.
   */
  child(parent: JobTable | null = null): JobTable {
    return new JobTable(null, this.processes, parent, this.clock)
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
   * The job's number is taken from the store first, so two workspaces
   * starting a job on one session never share one; a process slot is
   * reserved next, and a refused one gives the number back. The runner is
   * deferred until the job and console are ready; failed setup cancels the
   * reservation without entering the supplied runner. Only fully
   * initialized jobs join the table.
   */
  async submit(init: {
    command: string
    run: JobRunner
    abort: AbortController
    cwd: string
    sessionId?: string
    parentPid?: number | null
    limit?: number | null
    // The job is one simple command (`Job.simple`).
    simple?: boolean
  }): Promise<Job> {
    const sessionId = init.sessionId ?? ''
    const name = crypto.randomUUID().replaceAll('-', '')
    const createdAt = this.clock.now()
    await this.store.renew(this.owner)
    const jobId = await this.allocate(sessionId, {
      command: init.command,
      cwd: init.cwd,
      created_at: createdAt,
      owner: this.owner,
      console: name,
    })
    let job: Job | null = null
    let process: ProcessHandle
    try {
      process = this.processes.start({
        sessionId,
        parentPid: init.parentPid ?? null,
        command: init.command,
        cwd: PathSpec.fromStrPath(init.cwd),
        run: async () => {
          if (job === null) return KILLED_EXIT_CODE
          if (job.status !== JobStatus.RUNNING) return job.exitCode
          const watching = new AbortController()
          void watch(job, watching.signal).catch((err: unknown) => {
            console.debug('job watch failed:', err)
          })
          try {
            return await settle(init.run, job)
          } finally {
            watching.abort()
            this.dropLease()
          }
        },
        cancel: () => {
          init.abort.abort()
        },
        limit: init.limit ?? null,
      })
    } catch (error) {
      await this.remove(sessionId, new Set([jobId]), true)
      throw error
    }
    try {
      const jobConsole = new JobConsole(this.store.console(name))
      jobConsole.bindExecution(process.info.executionId)
      job = new Job({
        id: jobId,
        command: init.command,
        abort: init.abort,
        cwd: init.cwd,
        sessionId,
        console: jobConsole,
        simple: init.simple ?? false,
        createdAt,
        owner: this.owner,
      })
    } catch (error) {
      process.terminate()
      await this.remove(sessionId, new Set([jobId]), true)
      throw error
    }
    job.process = process
    this.sessionJobs(sessionId).set(job.id, job)
    const onAbort = () => {
      process.terminate()
    }
    init.abort.signal.addEventListener('abort', onAbort, { once: true })
    if (init.abort.signal.aborted) process.terminate()
    void process.join().then(() => {
      init.abort.signal.removeEventListener('abort', onAbort)
    })
    this.keepLease()
    return job
  }

  /**
   * Insert a finished job restored from a snapshot into its session. Its
   * output moves onto a console in the store, so every workspace on it
   * reads the job the way it reads one that ran there.
   */
  async load(job: Job): Promise<void> {
    const name = crypto.randomUUID().replaceAll('-', '')
    const store = this.store.console(name)
    const [chunks] = await job.console.readFrom(0)
    for (const chunk of chunks) await store.append(chunk.channel, chunk.data)
    const restored = new JobConsole(store, true)
    if (job.executionId !== null) restored.bindExecution(job.executionId)
    job.console = restored
    job.owner = this.owner
    await this.insert(job.sessionId, job.id, {
      command: job.command,
      cwd: job.cwd,
      created_at: job.createdAt,
      owner: job.owner,
      console: name,
    })
    this.sessionJobs(job.sessionId).set(job.id, job)
  }

  /**
   * Bring a session's list up to date with the store.
   *
   * Adds the jobs other workspaces started, drops the ones they reaped or
   * disowned (a job this table runs keeps running, on the side list
   * `disown` uses), and settles a job whose console another workspace
   * ended, or another workspace's job whose owner's lease lapsed with no
   * ending.
   */
  async sync(sessionId = ''): Promise<void> {
    const fields = await this.store.load(sessionId)
    const entries = (fields?.jobs ?? {}) as Record<string, ListEntry>
    const local = this.jobs.get(sessionId) ?? new Map<number, Job>()
    const jobs = new Map<number, Job>()
    for (const key of Object.keys(entries).sort((a, b) => Number(a) - Number(b))) {
      const jobId = Number(key)
      const entry = entries[key]
      if (entry === undefined) continue
      const job = local.get(jobId) ?? this.remote(jobId, sessionId, entry)
      local.delete(jobId)
      jobs.set(jobId, job)
    }
    for (const job of local.values()) {
      if (job.process !== null && job.status === JobStatus.RUNNING) this.disowned.push(job)
    }
    this.jobs.set(sessionId, jobs)
    for (const job of jobs.values()) {
      if (job.process !== null) await adoptEnding(job)
      else if (job.status === JobStatus.RUNNING) await this.refresh(job)
    }
  }

  get(jobId: number, sessionId = ''): Job | null {
    return this.jobs.get(sessionId)?.get(jobId) ?? null
  }

  listJobs(sessionId = ''): Job[] {
    return [...(this.jobs.get(sessionId)?.values() ?? [])]
  }

  /** The jobs `jobs` shows: a `$( )`'s caller's, then its own. */
  listing(sessionId = ''): Job[] {
    return [...(this.parent?.listing(sessionId) ?? []), ...this.listJobs(sessionId)]
  }

  runningJobs(sessionId = ''): Job[] {
    return this.listJobs(sessionId).filter((j) => j.status === JobStatus.RUNNING)
  }

  /**
   * Every session's jobs, for the workspace-wide entry points only. Snapshot
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
   *
   * Another workspace's job is killed by ending its console; its owner
   * sees the ending and stops the runner. Should the job have ended
   * first, the ending it wrote stands and the job was not killed.
   *
   * @param signal the signal the job is stopped with; its status is 128
   *   plus it, KILL's 137 by default.
   */
  async kill(jobId: number, sessionId = '', signal = 9): Promise<boolean> {
    const job = this.get(jobId, sessionId)
    if (job?.status !== JobStatus.RUNNING) return false
    if (job.process !== null) {
      await stop(job, signal)
      return true
    }
    await markKilled(job.console, 128 + signal)
    await this.refresh(job)
    return (job.status as JobStatus) === JobStatus.KILLED
  }

  /**
   * Drop a job from its session's list without stopping it (`disown`):
   * the job keeps running, `jobs` no longer lists it and `wait` no
   * longer knows it. It stays on a side list so `killAll` at teardown
   * reaches its task.
   */
  async disown(jobId: number, sessionId = ''): Promise<boolean> {
    const jobs = this.jobs.get(sessionId)
    const job = jobs?.get(jobId)
    if (jobs === undefined || job === undefined) return false
    jobs.delete(jobId)
    if (job.process !== null && job.status === JobStatus.RUNNING) this.disowned.push(job)
    await this.remove(sessionId, new Set([jobId]))
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
   * entry points and stops disowned runners too. Closing a session closes
   * it everywhere, so the jobs other workspaces run in it are stopped too.
   */
  async closeSession(sessionId: string): Promise<Job[]> {
    await this.sync(sessionId)
    const running = this.runningJobs(sessionId)
    for (const job of running) await this.kill(job.id, sessionId)
    this.jobs.delete(sessionId)
    await this.store.delete(sessionId)
    this.processes.revokeSession(sessionId)
    return running
  }

  /** Stop every running job this table runs in every session, returning
   * the ones that were running. Disowned jobs are stopped too: the shell
   * forgot them, the workspace did not, and a teardown that left them
   * running would leak tasks. Another workspace's jobs are its own to
   * stop. */
  async killAll(): Promise<Job[]> {
    const running = this.allRunningJobs().filter((j) => j.process !== null)
    for (const job of [...running, ...this.disowned])
      if (job.status === JobStatus.RUNNING && job.process !== null) await stop(job)
    this.disowned = []
    return running
  }

  /**
   * Stop renewing this table's lease, at workspace teardown. Called after
   * killAll(), so every job this table ran has ended and other workspaces
   * need no lease to settle them. The store itself belongs to the
   * workspace's state store.
   */
  close(): Promise<void> {
    if (this.lease !== null) clearTimeout(this.lease)
    this.lease = null
    return Promise.resolve()
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
   *
   * A killed job's console ends at the kill, so its runner is joined
   * too, for at most `STOP_WAIT_SECONDS`: what it started stops in that
   * time (a handler finishes, a sandbox is reaped) and the status it
   * leaves is the one answered, as bash's `wait` answers once the child
   * has gone.
   *
   * Another workspace's job answers the status its ending records. While
   * none is stored its owner's lease is checked every third of it, and a
   * lapsed one ends the job as hung up.
   */
  async wait(jobId: number, sessionId = ''): Promise<Job> {
    const job = this.get(jobId, sessionId)
    if (job === null) {
      throw new Error(`unknown job: ${jobId.toString()}`)
    }
    if (job.process === null) {
      if (job.status === JobStatus.RUNNING) await this.joinRemote(job)
      return job
    }
    await job.console.waitFinished()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null)
      }, STOP_WAIT_SECONDS * 1000)
    })
    try {
      await Promise.race([job.process.join(), late])
    } finally {
      clearTimeout(timer)
    }
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
   * What a targeted `wait`/`fg` does once the job has ended, matching
   * GNU bash, where a job waited on by id is deleted from the job list,
   * so a later `jobs` or `wait %N` no longer finds it.
   */
  async reap(jobId: number, sessionId = ''): Promise<void> {
    this.jobs.get(sessionId)?.delete(jobId)
    await this.remove(sessionId, new Set([jobId]))
  }

  /**
   * Return a session's completed/killed jobs and remove them from its
   * list.
   *
   * A reader holding a job's console keeps reading it: the console
   * outlives its table entry and dies with its last reader.
   */
  async popCompleted(sessionId = ''): Promise<Job[]> {
    const jobs = this.jobs.get(sessionId)
    if (jobs === undefined) return []
    const completed = [...jobs.values()].filter((j) => j.status !== JobStatus.RUNNING)
    for (const j of completed) jobs.delete(j.id)
    if (completed.length > 0) await this.remove(sessionId, new Set(completed.map((j) => j.id)))
    return completed
  }

  /** Another workspace's job, as its list entry describes it. */
  private remote(jobId: number, sessionId: string, entry: ListEntry): Job {
    return new Job({
      id: jobId,
      command: entry.command,
      cwd: entry.cwd,
      createdAt: entry.created_at,
      console: new JobConsole(this.store.console(entry.console)),
      sessionId,
      owner: entry.owner,
    })
  }

  /**
   * Settle another workspace's job from its console's ending, or end it as
   * hung up when its owner's lease lapsed with none.
   */
  private async refresh(job: Job): Promise<void> {
    let outcome = await job.console.outcome()
    if (outcome === null) {
      if (await this.store.alive(job.owner)) return
      await markKilled(job.console, HANGUP_EXIT_CODE)
      outcome = await job.console.outcome()
      if (outcome === null) return
    }
    ;[job.status, job.exitCode] = ended(outcome)
  }

  /** Block until another workspace's job ends. */
  private async joinRemote(job: Job): Promise<void> {
    const lease = this.store.leaseSeconds
    while (job.status === JobStatus.RUNNING) {
      if (lease === null) {
        await job.console.waitFinished()
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined
        const check = new Promise<null>((resolve) => {
          timer = setTimeout(
            () => {
              resolve(null)
            },
            (lease * 1000) / 3,
          )
        })
        try {
          await Promise.race([job.console.waitFinished(), check])
        } finally {
          clearTimeout(timer)
        }
      }
      if (job.console.store.closed) return
      await this.refresh(job)
    }
  }

  /**
   * Add a job to a session's list under the next number. Numbering
   * restarts at 1 once the list is empty, as GNU bash restarts it; without
   * that, reaping after a targeted `wait` would leave a later `wait %1`
   * pointing at nothing.
   */
  private async allocate(sessionId: string, entry: ListEntry): Promise<number> {
    for (let attempt = 0; attempt < LIST_MAX_RETRIES; attempt++) {
      const fields = await this.store.load(sessionId)
      const jobs = { ...((fields?.jobs ?? {}) as Record<string, ListEntry>) }
      const jobId = Object.keys(jobs).length > 0 ? Number(fields?.next ?? 1) : 1
      jobs[jobId.toString()] = entry
      if (await this.write(sessionId, fields, jobs, jobId + 1)) return jobId
    }
    throw new Error(`job list of session ${sessionId} kept conflicting with another writer`)
  }

  /** Add a job to a session's list under its own number. */
  private async insert(sessionId: string, jobId: number, entry: ListEntry): Promise<void> {
    for (let attempt = 0; attempt < LIST_MAX_RETRIES; attempt++) {
      const fields = await this.store.load(sessionId)
      const jobs = { ...((fields?.jobs ?? {}) as Record<string, ListEntry>) }
      jobs[jobId.toString()] = entry
      const following = Number(fields?.next ?? 1)
      if (await this.write(sessionId, fields, jobs, Math.max(following, jobId + 1))) return
    }
    throw new Error(`job list of session ${sessionId} kept conflicting with another writer`)
  }

  /**
   * Drop jobs from a session's list. With `giveBack` the jobs never
   * started, so the last number handed out is free again, as no job took
   * it.
   */
  private async remove(sessionId: string, jobIds: Set<number>, giveBack = false): Promise<void> {
    for (let attempt = 0; attempt < LIST_MAX_RETRIES; attempt++) {
      const fields = await this.store.load(sessionId)
      if (fields === null) return
      const stored = (fields.jobs ?? {}) as Record<string, ListEntry>
      const jobs = Object.fromEntries(
        Object.entries(stored).filter(([key]) => !jobIds.has(Number(key))),
      )
      if (Object.keys(jobs).length === Object.keys(stored).length) return
      let following = Number(fields.next ?? 1)
      if (giveBack && jobIds.has(following - 1)) following -= 1
      if (await this.write(sessionId, fields, jobs, following)) return
    }
    throw new Error(`job list of session ${sessionId} kept conflicting with another writer`)
  }

  /** Write a session's list over the one read, iff still current. */
  private write(
    sessionId: string,
    fields: RecordFields | null,
    jobs: Record<string, ListEntry>,
    following: number,
  ): Promise<boolean> {
    const expected = generationOf(fields)
    return this.store.casSet(
      sessionId,
      { next: following, jobs, generation: expected + 1 },
      expected,
    )
  }

  /** Renew this table's lease while it runs jobs on a store that leases owners. */
  private keepLease(): void {
    const lease = this.store.leaseSeconds
    if (lease === null || this.lease !== null) return
    const renew = () => {
      this.lease = setTimeout(
        () => {
          // A failed renewal is logged and retried: should the lease lapse
          // meanwhile, other workspaces end this table's jobs as hung up and
          // the watchers here stop them, so the two never disagree.
          this.store.renew(this.owner).catch((err: unknown) => {
            console.debug('job lease renewal failed:', err)
          })
          if (this.lease !== null) renew()
        },
        (lease * 1000) / 3,
      )
    }
    renew()
  }

  /** Stop renewing once this table runs no job. */
  private dropLease(): void {
    if (this.lease === null) return
    if (
      [...this.allJobs(), ...this.disowned].some(
        (j) => j.process !== null && j.status === JobStatus.RUNNING,
      )
    )
      return
    clearTimeout(this.lease)
    this.lease = null
  }
}
