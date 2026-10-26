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

import type { ProcessPermissions } from '../../process/config.ts'
import type { ProcessHandle } from '../../process/handle.ts'
import { ProcessTable } from '../../process/table.ts'
import { PathSpec, type JsonValue } from '../../types.ts'
import {
  Channel,
  JobConsole,
  KILLED_OUTCOME,
  exitOutcome,
  killedOutcome,
} from '../console/index.ts'
import {
  GENERATION_BITS,
  HANGUP_EXIT_CODE,
  KILLED_EXIT_CODE,
  LIST_CHECK_SECONDS,
  LIST_MAX_RETRIES,
  PUBLISH_SECONDS,
  STOP_WAIT_SECONDS,
  WATCH_RETRY_SECONDS,
} from './constants.ts'
import { RAMJobStore } from './ram.ts'
import type { JobStore } from './store.ts'
import { Job, type JobResult, type JobRunner, JobStatus } from './types.ts'
import { encodeText } from '../bytes.ts'
import { sleep } from '../../utils/abort.ts'
import { SystemClock, type Clock } from '../../utils/clock.ts'
import { generationOf, type RecordFields } from '../../workspace/record/types.ts'

// One job's entry in its session's list.
interface ListEntry {
  command: string
  cwd: string
  created_at: number
  owner: string
  console: string
  // How the job ended, once its owner recorded it.
  ending?: string
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

/** The ending text an ended job's status and exit code record. */
function outcomeOf(job: Job): string {
  return job.status === JobStatus.KILLED ? killedOutcome(job.exitCode) : exitOutcome(job.exitCode)
}

/** Write the kill marker and the ending chunk. Mirrors Python's `_mark_killed`. */
async function markKilled(console: JobConsole, exitCode: number): Promise<void> {
  await console.emit(Channel.STDERR, encodeText('Killed'))
  await console.finish(killedOutcome(exitCode))
}

/**
 * End a job's console with how it ended, then take the ending the console
 * holds. Another workspace's `kill`, or the bound on a killed job's stop,
 * may have ended the console first; the store keeps the first ending, and
 * every workspace answers that one. Status is set before the console is
 * finished, so a reader released by the ending chunk always sees settled
 * fields. Mirrors Python's `_record`.
 */
async function record(job: Job, status: JobStatus, exitCode: number): Promise<void> {
  job.status = status
  job.exitCode = exitCode
  if (status === JobStatus.KILLED) await markKilled(job.console, exitCode)
  else await job.console.finish(exitOutcome(exitCode))
  if (job.console.store.closed) return
  const outcome = await job.console.outcome()
  if (outcome !== null) [job.status, job.exitCode] = ended(outcome)
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
 * A job's console ends here, in the job's own task, once its runner has:
 * `kill` only stops the runner, so a program that handled the signal
 * leaves its own status (`stoppedStatus`) in the ending every workspace
 * reads. A job something stopped ends as killed however its runner
 * finished.
 */
async function settle(run: JobRunner, job: Job): Promise<number> {
  let result: JobResult
  try {
    if (job.abort?.signal.aborted) throw new DOMException('aborted', 'AbortError')
    result = await run(job)
  } catch (err) {
    if (isAbortError(err) || job.status !== JobStatus.RUNNING) {
      await record(job, JobStatus.KILLED, stoppedStatus(job))
      return isAbortError(err) ? job.exitCode : 1
    }
    // Recorded as the job's output and exit status rather than
    // rethrown: nobody awaits this task, so rethrowing would only
    // strand the error in an unhandled rejection.
    const msg = err instanceof Error ? err.message : String(err)
    await job.console.emit(Channel.STDERR, encodeText(msg))
    await record(job, JobStatus.COMPLETED, 1)
    return 1
  }
  const [ioResult] = result
  if (job.status !== JobStatus.RUNNING) await record(job, JobStatus.KILLED, stoppedStatus(job))
  else await record(job, JobStatus.COMPLETED, ioResult.exitCode)
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
 * Stop a job this table runs once another workspace ends it. A failed read
 * is retried until the runner settles, which aborts the watch: one that
 * gave up would leave a kill from elsewhere unheeded while the job ran on.
 *
 * @param job the job, run by this table
 * @param signal aborted once its runner settles, ending the watch
 */
async function watch(job: Job, signal: AbortSignal): Promise<void> {
  const store = job.console.store
  while (!signal.aborted && !store.closed) {
    try {
      await store.waitEnded(signal)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the runner may settle across the await
      if (!signal.aborted) await adoptEnding(job)
      return
    } catch (err) {
      console.debug('job watch failed:', err)
    }
    await sleep(WATCH_RETRY_SECONDS * 1000, signal)
  }
}

/** The consoles a session's list holds, listed or disowned. */
function heldConsoles(fields: RecordFields | null): Set<string> {
  if (fields === null) return new Set()
  const listed = Object.values((fields.jobs ?? {}) as Record<string, ListEntry>)
  return new Set([
    ...listed.map((entry) => entry.console),
    ...Object.keys((fields.disowned ?? {}) as Record<string, ListEntry>),
  ])
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
 * session-local job number. A killed job's process remains stopping until
 * the runner actually finishes, and its console ends then, or once the
 * runner had `STOP_WAIT_SECONDS` to stop and did not.
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
  // Jobs `disown` removed while still running, and ones another job's
  // number displaced: the shell forgets them, the workspace still owns
  // their tasks so teardown can stop them; each leaves once it finishes.
  private disowned: Job[] = []
  private lease: ReturnType<typeof setTimeout> | null = null
  private checking: ReturnType<typeof setTimeout> | null = null
  // The bounds on killed jobs' stops (endKilled): each one's ending, and
  // the cut that ends its wait at once.
  private stopping = new Map<Job, { ending: Promise<void>; cut: () => void }>()
  private publishing: Promise<void> | null = null
  // The publisher's pending sleep, which a close ends at once.
  private publishTick: { timer: ReturnType<typeof setTimeout>; wake: () => void } | null = null
  private closed = false
  private reaping = new Set<Promise<void>>()
  // Lapsed owners this table already set about reaping, so a listing that
  // finds one again does not stop its runs again; and whether teardown
  // stopped the reaping, which its runtimes are closing for.
  private reaped = new Set<string>()
  private reapingStopped = false
  // The table whose store and owner the process plane is read and written
  // through: this one, or for a child shell's table the workspace's, since
  // a child shell keeps only its job list private.
  private plane: JobTable = this
  /**
   * Stops the native runs a lapsed owner left, given them and the first
   * signal, and answers the ones this workspace cannot reach; the workspace
   * sets it, since it holds the runtimes that reach them.
   */
  reaper:
    | ((runs: Record<string, JsonValue>[], signum: number) => Promise<Record<string, JsonValue>[]>)
    | null = null

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
   * them. `parent` is the table a `$( )` still lists in `jobs`. It lists
   * and stops other workspaces' processes through this table, on the
   * workspace's store.
   */
  child(parent: JobTable | null = null): JobTable {
    const table = new JobTable(null, this.processes, parent, this.clock)
    table.plane = this.plane
    return table
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
            await this.recordEnding(job)
            this.disowned = this.disowned.filter((j) => j !== job)
            this.dropLease()
            this.dropChecking()
          }
        },
        cancel: () => {
          init.abort.abort()
        },
        limit: init.limit ?? null,
      })
    } catch (error) {
      await this.remove(sessionId, new Set([name]), true)
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
        consoleName: name,
      })
    } catch (error) {
      process.terminate()
      await this.remove(sessionId, new Set([name]), true)
      throw error
    }
    job.process = process
    this.sessionJobs(sessionId).set(job.id, job)
    // An abort from elsewhere stops the runner; one the runner's own stop
    // sent is that stop, which a KILL here would cut short.
    const onAbort = () => {
      if (!process.info.cancellationRequested) process.terminate()
    }
    init.abort.signal.addEventListener('abort', onAbort, { once: true })
    if (init.abort.signal.aborted) process.terminate()
    void process.join().then(() => {
      init.abort.signal.removeEventListener('abort', onAbort)
    })
    this.keepLease()
    this.keepChecking()
    return job
  }

  /**
   * Insert a finished job restored from a snapshot into its session. Its
   * output moves onto a console in the store, so every workspace on it
   * reads the job the way it reads one that ran there. It keeps its number
   * unless another workspace's job holds it, and then takes the next free
   * one rather than hide that job.
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
    job.consoleName = name
    job.id = await this.insert(job.sessionId, job.id, {
      command: job.command,
      cwd: job.cwd,
      created_at: job.createdAt,
      owner: job.owner,
      console: name,
      ending: outcomeOf(job),
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
   * ending. A job is the one listed under its number only while their
   * consoles match: once the list empties, numbering restarts and a new
   * job can take a reaped one's number.
   *
   * A console attached to a job first seen here is the job's only while
   * the list has not changed since it was read: a store drops the console
   * of a job reaped meanwhile, and attaching then would open an empty one
   * that never ends. So the list is read again after such an attach, and
   * the sync retried should it have moved. This table's own jobs are
   * matched after the last read, with no wait between, so one it started
   * meanwhile is never taken for another workspace's; a running one the
   * list no longer names stays listed, unless the list holds it as
   * disowned or another job took its number, and then it runs on unlisted,
   * as a disowned job does.
   */
  async sync(sessionId = ''): Promise<void> {
    let fields: RecordFields | null = null
    let remotes = new Map<string, Job>()
    for (let attempt = 0; attempt < LIST_MAX_RETRIES; attempt++) {
      fields = await this.store.load(sessionId)
      const listed = (fields?.jobs ?? {}) as Record<string, ListEntry>
      const known = new Set(this.listJobs(sessionId).map((j) => j.consoleName))
      remotes = new Map(
        Object.entries(listed)
          .filter(([, entry]) => !known.has(entry.console))
          .map(([key, entry]) => [entry.console, this.remote(Number(key), sessionId, entry)]),
      )
      if (
        remotes.size === 0 ||
        generationOf(await this.store.load(sessionId)) === generationOf(fields)
      )
        break
    }
    const entries = (fields?.jobs ?? {}) as Record<string, ListEntry>
    const held = (fields?.disowned ?? {}) as Record<string, ListEntry>
    const mine = new Map(this.listJobs(sessionId).map((j) => [j.consoleName, j]))
    const jobs = new Map<number, Job>()
    for (const [key, entry] of Object.entries(entries)) {
      const job = mine.get(entry.console) ?? remotes.get(entry.console)
      mine.delete(entry.console)
      if (job === undefined) continue
      if (job.process === null && job.status === JobStatus.RUNNING && entry.ending !== undefined)
        [job.status, job.exitCode] = ended(entry.ending)
      jobs.set(Number(key), job)
    }
    for (const job of mine.values()) {
      if (job.process === null || job.status !== JobStatus.RUNNING) continue
      if (job.consoleName in held || jobs.has(job.id)) this.disowned.push(job)
      else jobs.set(job.id, job)
    }
    this.jobs.set(sessionId, new Map([...jobs].sort(([a], [b]) => a - b)))
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
   * The job answers as killed at once, but its console ends only once the
   * runner has stopped, so a program that handled the signal leaves its
   * own status in the ending every workspace reads. Nothing here waits for
   * the aborted runner. The signal is only observed where someone checks
   * it, which today is the executor between nodes and the commands that
   * take it, so a job sitting inside one long command would not notice
   * until it finished on its own; joining would hang the shell on exactly
   * the runaway job the caller is trying to stop. A runner that has not
   * stopped `STOP_WAIT_SECONDS` later has its console ended for it, with
   * the status the kill recorded, and one that has not begun has it ended
   * at once: no program ran that could leave its own.
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
      await this.stopRunner(job, job.process, signal)
      return true
    }
    if (!(await this.store.alive(job.owner))) await this.reapOwner(job.owner)
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
    const running = job.status === JobStatus.RUNNING
    if (job.process !== null && running) this.disowned.push(job)
    await this.remove(sessionId, new Set([job.consoleName]), false, running)
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
   * it everywhere, so the jobs other workspaces run in it are stopped too,
   * the disowned ones included: their consoles are ended, which their
   * owners watch for. The list goes only while it is the one the stops were
   * taken from: a job another workspace starts meanwhile changes it, and
   * the close stops that job too before it tries again.
   */
  async closeSession(sessionId: string): Promise<Job[]> {
    const stopped = new Map<string, Job>()
    for (let attempt = 0; attempt < LIST_MAX_RETRIES; attempt++) {
      const fields = await this.store.load(sessionId)
      await this.sync(sessionId)
      for (const job of this.runningJobs(sessionId)) {
        await this.kill(job.id, sessionId)
        stopped.set(job.consoleName, job)
      }
      for (const [name, entry] of Object.entries(
        (fields?.disowned ?? {}) as Record<string, ListEntry>,
      ))
        if (entry.owner !== this.owner)
          await markKilled(new JobConsole(this.store.console(name)), KILLED_EXIT_CODE)
      if (await this.store.delete(sessionId, generationOf(fields))) {
        this.jobs.delete(sessionId)
        this.processes.revokeSession(sessionId)
        return [...stopped.values()]
      }
    }
    throw new Error(`job list of session ${sessionId} kept conflicting with another writer`)
  }

  /** Stop every running job this table runs in every session, returning
   * the ones that were running. Disowned jobs are stopped too: the shell
   * forgot them, the workspace did not, and a teardown that left them
   * running would leak tasks. Another workspace's jobs are its own to
   * stop. The reaping of lapsed owners' runs stops here as well, before the
   * runtimes it reaches them through close: none starts, and one under way
   * is waited for, bounded as a reap is. */
  async killAll(): Promise<Job[]> {
    this.reapingStopped = true
    await Promise.allSettled([...this.reaping])
    const running = this.allRunningJobs().filter((j) => j.process !== null)
    for (const job of [...running, ...this.disowned])
      if (job.status === JobStatus.RUNNING && job.process !== null) await stop(job)
    this.disowned = []
    return running
  }

  /**
   * Stop renewing this table's lease, at workspace teardown. Called after
   * killAll(), so every job this table ran has ended and other workspaces
   * need no lease to settle them; a killed job whose runner is still
   * stopping has its console ended now rather than at its bound. The
   * store itself belongs to the workspace's state store.
   */
  async close(): Promise<void> {
    if (this.lease !== null) clearTimeout(this.lease)
    if (this.checking !== null) clearTimeout(this.checking)
    this.lease = null
    this.checking = null
    this.closed = true
    if (this.publishTick !== null) {
      clearTimeout(this.publishTick.timer)
      this.publishTick.wake()
    }
    await this.publishing
    try {
      await this.store.publish(this.owner, {})
    } catch (err) {
      console.debug('process record not dropped:', err)
    }
    const stopping = [...this.stopping.values()]
    for (const { cut } of stopping) cut()
    await Promise.all(stopping.map(({ ending }) => ending))
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
   * A killed job's console ends once its runner has stopped, or
   * `STOP_WAIT_SECONDS` after the kill: what it started stops in that
   * time (a handler finishes, a sandbox is reaped) and the status it
   * leaves is the one answered, as bash's `wait` answers once the child
   * has gone. An ending another workspace wrote is taken at once, before
   * this table's watcher stops the runner. The runner is joined too, for
   * at most `STOP_WAIT_SECONDS`, so what its task holds is let go before
   * this returns.
   *
   * Another workspace's job answers the status its ending records. While
   * none is stored its owner's lease is checked every third of it, and a
   * lapsed one ends the job as hung up.
   *
   * @param signal abandons the wait, so a caller that gave up stops its
   *   reads: a promise cannot be cancelled, where Python cancels its task.
   *   The job keeps running.
   */
  async wait(jobId: number, sessionId = '', signal?: AbortSignal): Promise<Job> {
    const job = this.get(jobId, sessionId)
    if (job === null) {
      throw new Error(`unknown job: ${jobId.toString()}`)
    }
    if (job.process === null) {
      if (job.status === JobStatus.RUNNING) await this.joinRemote(job, signal)
      return job
    }
    await job.console.waitFinished(signal)
    if (signal?.aborted === true) return job
    await adoptEnding(job)
    let timer: ReturnType<typeof setTimeout> | undefined
    let stop = (): void => undefined
    const late = new Promise<null>((resolve) => {
      stop = () => {
        resolve(null)
      }
      timer = setTimeout(stop, STOP_WAIT_SECONDS * 1000)
      signal?.addEventListener('abort', stop, { once: true })
    })
    try {
      await Promise.race([job.process.join(), late])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
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
  async waitAll(sessionId = '', signal?: AbortSignal): Promise<Job[]> {
    const running = this.runningJobs(sessionId)
    for (const job of this.listJobs(sessionId)) {
      await this.wait(job.id, sessionId, signal)
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
    const job = this.get(jobId, sessionId)
    if (job === null) return
    this.jobs.get(sessionId)?.delete(jobId)
    await this.remove(sessionId, new Set([job.consoleName]))
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
    if (completed.length > 0)
      await this.remove(sessionId, new Set(completed.map((j) => j.consoleName)))
    return completed
  }

  /** Another workspace's job, as its list entry describes it. */
  /**
   * Publish the processes this table's workspace runs, now that one
   * started: the publishing goes on while any runs (`publish`).
   */
  processesChanged(): void {
    if (this.publishing !== null || this.closed) return
    this.publishing = this.publish()
  }

  /**
   * The processes other workspaces on the store run, owner to PID to
   * process, as each last published them. A lapsed owner's are left out:
   * whatever it ran was lost with it, and the native runs it left are
   * stopped meanwhile.
   */
  async remoteProcesses(): Promise<Record<string, Record<string, RecordFields>>> {
    if (this.plane !== this) return this.plane.remoteProcesses()
    const found: Record<string, Record<string, RecordFields>> = {}
    for (const [owner, records] of Object.entries(await this.store.processes())) {
      if (owner === this.owner || Object.keys(records).length === 0) continue
      if (await this.store.alive(owner)) found[owner] = records
      else this.reapLater(owner)
    }
    return found
  }

  /**
   * Signal a process another workspace runs, named by a prefix of its
   * owner's id and the owner's PID: its owner stops it once it takes the
   * stop, within `PUBLISH_SECONDS`. Signal 0 only probes. A lapsed owner's
   * process is gone, and the native runs it left are stopped instead.
   * Answers whether one live process was signalled; throws EPERM for one
   * the session sees but may not stop.
   *
   * @param owner a prefix of the owner's id, as `ps` shows it.
   * @param pid the process, by the owner's PID.
   * @param signal the signal, 0 to probe.
   * @param sessionId the calling session.
   * @param permissions whose processes it may see and stop.
   */
  async signalRemote(
    owner: string,
    pid: number,
    signal: number,
    sessionId: string,
    permissions: ProcessPermissions,
  ): Promise<boolean> {
    if (this.plane !== this)
      return this.plane.signalRemote(owner, pid, signal, sessionId, permissions)
    const records = await this.store.processes()
    let owners = Object.keys(records).filter(
      (found) =>
        found !== this.owner &&
        found.startsWith(owner) &&
        Object.hasOwn(records[found] ?? {}, String(pid)),
    )
    if (owners.length > 1) {
      const live = await Promise.all(owners.map((found) => this.store.alive(found)))
      owners = owners.filter((_, at) => live[at])
    }
    const [found] = owners
    if (owners.length !== 1 || found === undefined) return false
    const record = records[found]?.[String(pid)] ?? {}
    const own = record.session === sessionId
    if (permissions.list === 'session' && !own) return false
    if (!(await this.store.alive(found))) {
      await this.reapOwner(found)
      return false
    }
    if (permissions.kill === 'session' && !own)
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
    if (signal !== 0) await this.store.requestStop(found, pid, signal)
    return true
  }

  private remote(jobId: number, sessionId: string, entry: ListEntry): Job {
    return new Job({
      id: jobId,
      command: entry.command,
      cwd: entry.cwd,
      createdAt: entry.created_at,
      console: new JobConsole(this.store.console(entry.console)),
      sessionId,
      owner: entry.owner,
      consoleName: entry.console,
    })
  }

  /**
   * End a killed job's console once its runner has stopped, or
   * `STOP_WAIT_SECONDS` after the kill, whichever comes first. A runner
   * that settles ends the console itself, with the status it left; this
   * ends it with the status the kill recorded when the runner never got
   * that far (aborted before it began) or is still stopping, or at once
   * when cut (close()). Mirrors Python's `_end_killed`.
   */
  /**
   * Stop a job this table runs and record it as killed by `signal`. One
   * that has not begun has its console ended at once: no program ran that
   * could leave its own status. One that has has its console ended once its
   * runner stops, or `STOP_WAIT_SECONDS` later.
   */
  private async stopRunner(job: Job, process: ProcessHandle, signal: number): Promise<void> {
    if (!process.begun) {
      await stop(job, signal)
      await this.recordEnding(job)
      this.dropLease()
      this.dropChecking()
      return
    }
    process.terminate(signal)
    job.status = JobStatus.KILLED
    job.exitCode = 128 + signal
    this.endKilled(job, process)
  }

  private endKilled(job: Job, process: ProcessHandle): void {
    let cut = (): void => undefined
    const late = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_WAIT_SECONDS * 1000)
      cut = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    const ending = (async () => {
      await Promise.race([process.join(), late])
      cut()
      await this.endStopping(job)
    })()
      .catch((err: unknown) => {
        console.debug('ending a killed job failed:', err)
      })
      .finally(() => this.stopping.delete(job))
    this.stopping.set(job, { ending, cut })
  }

  /**
   * End a killed job's console with the status its kill recorded, unless
   * its runner already ended it.
   */
  private async endStopping(job: Job): Promise<void> {
    if (job.console.finished) return
    await markKilled(job.console, job.exitCode)
    await this.recordEnding(job)
    this.dropLease()
    this.dropChecking()
  }

  /**
   * Keep how a job this table ran ended in its list entry, or drop its
   * disowned record, which nothing else would. The entry outlives the
   * console's output, which a shared store expires, so a workspace that
   * attaches after the output went still reads how the job ended instead
   * of taking it as hung up. A failed write is logged: the console still
   * holds the ending.
   */
  private async recordEnding(job: Job): Promise<void> {
    const ending = outcomeOf(job)
    try {
      for (let attempt = 0; attempt < LIST_MAX_RETRIES; attempt++) {
        const fields = await this.store.load(job.sessionId)
        if (fields === null) return
        const jobs = { ...((fields.jobs ?? {}) as Record<string, ListEntry>) }
        const held = { ...((fields.disowned ?? {}) as Record<string, ListEntry>) }
        if (job.consoleName in held) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- held is keyed by console name
          delete held[job.consoleName]
        } else {
          const entry = jobs[job.id.toString()]
          if (entry?.console !== job.consoleName || entry.ending === ending) return
          jobs[job.id.toString()] = { ...entry, ending }
        }
        if (await this.write(job.sessionId, fields, jobs, Number(fields.next ?? 1), held)) return
      }
      console.debug('job ending kept conflicting:', job.id)
    } catch (err) {
      console.debug('job ending not kept:', err)
    }
  }

  /**
   * Settle another workspace's job from its console's ending, or end it as
   * hung up when its owner's lease lapsed with none.
   */
  private async refresh(job: Job): Promise<void> {
    let outcome = await job.console.outcome()
    if (outcome === null) {
      if (await this.store.alive(job.owner)) return
      this.reapLater(job.owner)
      await markKilled(job.console, HANGUP_EXIT_CODE)
      outcome = await job.console.outcome()
      if (outcome === null) return
    }
    ;[job.status, job.exitCode] = ended(outcome)
  }

  /**
   * Block until another workspace's job ends, or `signal` aborts. One read
   * follows the console across every lease check, so a long wait never
   * stacks readers, and an abandoned one stops reading.
   */
  private async joinRemote(job: Job, signal?: AbortSignal): Promise<void> {
    const lease = this.store.leaseSeconds
    const finished = job.console.waitFinished(signal)
    finished.catch((err: unknown) => {
      console.debug('job wait failed:', err)
    })
    while (job.status === JobStatus.RUNNING && signal?.aborted !== true) {
      if (lease === null) {
        await finished
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
          await Promise.race([finished, check])
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

  /**
   * Add a job to a session's list under its own number, or under the next
   * free one should another job hold it, and return the number it took.
   */
  private async insert(sessionId: string, jobId: number, entry: ListEntry): Promise<number> {
    for (let attempt = 0; attempt < LIST_MAX_RETRIES; attempt++) {
      const fields = await this.store.load(sessionId)
      const jobs = { ...((fields?.jobs ?? {}) as Record<string, ListEntry>) }
      const following = Number(fields?.next ?? 1)
      let taken = jobId
      if (taken.toString() in jobs) {
        taken = following
        while (taken.toString() in jobs) taken += 1
      }
      jobs[taken.toString()] = entry
      if (await this.write(sessionId, fields, jobs, Math.max(following, taken + 1))) return taken
    }
    throw new Error(`job list of session ${sessionId} kept conflicting with another writer`)
  }

  /**
   * Drop jobs from a session's list, named by their consoles, never by
   * number: another workspace may have reaped one and a new job taken its
   * number. With `giveBack` the jobs never started, so the last number
   * handed out is free again, as no job took it. With `disowned` the jobs
   * still run, disowned: their entries move to the list's disowned ones,
   * by console, where the session's close still reaches them.
   */
  private async remove(
    sessionId: string,
    names: Set<string>,
    giveBack = false,
    disowned = false,
  ): Promise<void> {
    for (let attempt = 0; attempt < LIST_MAX_RETRIES; attempt++) {
      const fields = await this.store.load(sessionId)
      if (fields === null) return
      const stored = (fields.jobs ?? {}) as Record<string, ListEntry>
      const dropped = new Set(
        Object.entries(stored)
          .filter(([, entry]) => names.has(entry.console))
          .map(([key]) => Number(key)),
      )
      if (dropped.size === 0) return
      const jobs = Object.fromEntries(
        Object.entries(stored).filter(([key]) => !dropped.has(Number(key))),
      )
      let following = Number(fields.next ?? 1)
      if (giveBack && dropped.has(following - 1)) following -= 1
      const held = { ...((fields.disowned ?? {}) as Record<string, ListEntry>) }
      if (disowned)
        for (const [key, entry] of Object.entries(stored))
          if (dropped.has(Number(key)) && entry.ending === undefined) held[entry.console] = entry
      if (await this.write(sessionId, fields, jobs, following, held)) return
    }
    throw new Error(`job list of session ${sessionId} kept conflicting with another writer`)
  }

  /**
   * Write a session's list over the one read, iff still current.
   * `disowned` is the disowned jobs still running, by console; null keeps
   * the ones read. A list written where none is starts at a random
   * generation rather than at 1, so a list deleted and written again never
   * repeats the generation a reader of the old one holds: a close that read
   * the old one deletes the new one only once it has stopped its jobs.
   */
  private write(
    sessionId: string,
    fields: RecordFields | null,
    jobs: Record<string, ListEntry>,
    following: number,
    disowned: Record<string, ListEntry> | null = null,
  ): Promise<boolean> {
    const expected = generationOf(fields)
    const held = disowned ?? ((fields?.disowned ?? {}) as Record<string, ListEntry>)
    const generation =
      fields !== null ? expected + 1 : 1 + Math.floor(Math.random() * 2 ** GENERATION_BITS)
    const record: RecordFields = { next: following, jobs, generation }
    if (Object.keys(held).length > 0) record.disowned = held
    return this.store.casSet(sessionId, record, expected)
  }

  /**
   * Renew this table's lease while it runs jobs on a store that leases
   * owners, with the consoles of the jobs it still runs, so a quiet one
   * keeps its output while this table lives.
   */
  /** Check the lists of the jobs this table runs every
   * `LIST_CHECK_SECONDS` while it runs any. */
  private keepChecking(): void {
    if (this.checking !== null) return
    const timer = setTimeout(() => {
      void this.checkLists()
        .catch((err: unknown) => {
          console.debug('job list check failed:', err)
        })
        .finally(() => {
          if (this.checking !== timer) return
          this.checking = null
          this.keepChecking()
        })
    }, LIST_CHECK_SECONDS * 1000)
    this.checking = timer
  }

  /** Stop checking once every job this table runs has ended its console. */
  private dropChecking(): void {
    if (this.checking === null) return
    if (
      [...this.allJobs(), ...this.disowned].some((j) => j.process !== null && !j.console.finished)
    )
      return
    clearTimeout(this.checking)
    this.checking = null
  }

  /**
   * Stop each job this table runs that its session's list dropped.
   *
   * A close, a reap and a disown of a running job each end its console or
   * keep its entry, so a list that dropped one whose console is still open
   * went with its workspace, deleted elsewhere: an ending written there
   * first would be deleted before this table's watch read it. The job is
   * stopped as a closed session's is. Each session's list is read once a
   * round, however many of its jobs run here; a round that failed for a
   * session, on its list or on a console, is tried again the next round.
   */
  private async checkLists(): Promise<void> {
    const sessions = new Map<string, Job[]>()
    for (const job of [...this.allJobs(), ...this.disowned]) {
      if (job.process === null || job.status !== JobStatus.RUNNING) continue
      const jobs = sessions.get(job.sessionId) ?? []
      jobs.push(job)
      sessions.set(job.sessionId, jobs)
    }
    for (const [sessionId, jobs] of sessions) {
      try {
        const held = heldConsoles(await this.store.load(sessionId))
        for (const job of jobs) {
          if (held.has(job.consoleName)) continue
          await adoptEnding(job)
          if (job.status === JobStatus.RUNNING && job.process !== null)
            await this.stopRunner(job, job.process, 9)
        }
      } catch (err) {
        console.debug('job list check failed:', err)
      }
    }
  }

  /**
   * The live processes this workspace runs, as its record keeps them, each
   * with the native runs it has going.
   */
  private records(): Record<string, RecordFields> {
    const records: Record<string, RecordFields> = {}
    for (const handle of this.processes.live()) {
      const info = handle.info
      records[String(info.pid)] = {
        pid: info.pid,
        parent: info.parentPid,
        group: info.groupId,
        session: info.sessionId,
        command: info.command,
        cwd: info.cwd.virtual,
        started_at: info.startedAt,
        state: info.state,
        execution: info.executionId,
        runs: Object.values(handle.runs),
      }
    }
    return records
  }

  /**
   * Publish the processes this workspace runs every `PUBLISH_SECONDS`
   * while it runs any, renewing its lease with them, and stop those other
   * workspaces asked it to stop. Once it runs none, its record goes and the
   * publishing stops. The lease is renewed every third of it, counted in
   * rounds, ahead of the record it vouches for, and the record is written
   * again with it, so it outlives its store's expiry and comes back should a
   * workspace have taken this one for lapsed. A failed round is logged and
   * tried again the next one, and a stop that fails leaves the others it
   * came with to be applied; the sleep between rounds keeps no host alive
   * on its own.
   */
  private async publish(): Promise<void> {
    let published: string | null = null
    const lease = this.store.leaseSeconds
    const renewal = lease !== null ? Math.max(1, Math.floor(lease / 3 / PUBLISH_SECONDS)) : 0
    let rounds = 0
    let due = 0
    for (;;) {
      const records = this.records()
      const text = JSON.stringify(records)
      try {
        if (renewal > 0 && rounds >= due) {
          await this.store.renew(this.owner)
          await this.store.publish(this.owner, records)
          published = text
          due = rounds + renewal
        } else if (text !== published) {
          await this.store.publish(this.owner, records)
          published = text
        }
        for (const [pid, signal] of await this.store.takeStops(this.owner)) {
          try {
            await this.stopAsked(pid, signal)
          } catch (err) {
            console.debug(`stop of ${String(pid)} not applied:`, err)
          }
        }
      } catch (err) {
        console.debug('process publish failed:', err)
      }
      if (this.closed || (published === '{}' && this.processes.live().length === 0)) {
        this.publishing = null
        return
      }
      rounds += 1
      await new Promise<void>((wake) => {
        const timer = setTimeout(wake, PUBLISH_SECONDS * 1000)
        ;(timer as { unref?: () => void }).unref?.()
        this.publishTick = { timer, wake }
      })
      this.publishTick = null
    }
  }

  /**
   * Stop one of this workspace's processes another workspace asked to
   * stop: a job's runner the way `kill` stops a job, any other runner
   * directly.
   */
  private async stopAsked(pid: number, signal: number): Promise<void> {
    for (const job of this.allJobs()) {
      if (job.process !== null && job.pid === pid && job.status === JobStatus.RUNNING) {
        await this.kill(job.id, job.sessionId, signal)
        return
      }
    }
    for (const handle of this.processes.live()) {
      if (handle.info.pid === pid) {
        handle.terminate(signal)
        return
      }
    }
  }

  /** Stop the native runs a lapsed owner left, without waiting. */
  private reapLater(owner: string): void {
    if (this.reapingStopped || this.reaped.has(owner)) return
    this.reaped.add(owner)
    const reaping = this.reapOwner(owner).finally(() => {
      this.reaping.delete(reaping)
    })
    this.reaping.add(reaping)
  }

  /**
   * Stop the native runs a lapsed owner left, those this workspace reaches,
   * and keep its record holding only the rest, for a workspace that reaches
   * them. The owner's lease is checked again before each run is stopped, so
   * one that renewed meanwhile keeps its runs, and its record as it is.
   */
  private async reapOwner(owner: string): Promise<void> {
    try {
      const records = (await this.store.processes())[owner] ?? {}
      const runsOf = (record: RecordFields) => record.runs as Record<string, JsonValue>[]
      const left: Record<string, JsonValue>[] = []
      for (const run of Object.values(records).flatMap(runsOf)) {
        if (await this.store.alive(owner)) return
        if (this.reaper === null || (await this.reaper([run], 15)).length > 0) left.push(run)
      }
      const kept: Record<string, RecordFields> = {}
      for (const [pid, record] of Object.entries(records)) {
        const remaining = runsOf(record).filter((run) => left.includes(run))
        if (remaining.length > 0) kept[pid] = { ...record, runs: remaining }
      }
      if (!(await this.store.alive(owner))) await this.store.publish(owner, kept)
    } catch (err) {
      console.debug(`lapsed owner ${owner} not reaped:`, err)
    }
  }

  private keepLease(): void {
    const lease = this.store.leaseSeconds
    if (lease === null || this.lease !== null) return
    const renew = () => {
      this.lease = setTimeout(
        () => {
          // A failed renewal is logged and retried: should the lease lapse
          // meanwhile, other workspaces end this table's jobs as hung up and
          // the watchers here stop them, so the two never disagree.
          const consoles = [...this.allJobs(), ...this.disowned]
            .filter((j) => j.process !== null && !j.console.finished)
            .map((j) => j.consoleName)
          this.store.renew(this.owner, consoles).catch((err: unknown) => {
            console.debug('job lease renewal failed:', err)
          })
          if (this.lease !== null) renew()
        },
        (lease * 1000) / 3,
      )
    }
    renew()
  }

  /**
   * Stop renewing once every job this table runs has ended its console: a
   * killed one still stopping keeps the lease, or other workspaces would
   * end it as hung up.
   */
  private dropLease(): void {
    if (this.lease === null) return
    if (
      [...this.allJobs(), ...this.disowned].some((j) => j.process !== null && !j.console.finished)
    )
      return
    clearTimeout(this.lease)
    this.lease = null
  }
}
