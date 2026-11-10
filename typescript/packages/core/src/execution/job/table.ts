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

import type { ProcessPermissions } from '../process/config.ts'
import type { ProcessHandle } from '../process/handle.ts'
import { ProcessTable } from '../process/table.ts'
import { PathSpec } from '../../types.ts'
import { JobConsole } from '../../shell/console/index.ts'
import {
  GENERATION_BITS,
  HANGUP_EXIT_CODE,
  IGNORED_SIGNALS,
  KILLED_EXIT_CODE,
  LIST_CHECK_SECONDS,
  LIST_MAX_RETRIES,
  PUBLISH_SECONDS,
  STOP_WAIT_SECONDS,
  SAVED_STATUSES,
} from './constants.ts'
import type { ExecutionStore } from '../base.ts'
import { WorkspaceHeldError } from '../errors.ts'
import { RAMExecutionStore } from '../ram.ts'
import { JobId, LineId } from '../types.ts'
import { JobHandle, type JobRunner, markKilled } from './handle.ts'
import type { Job, JobState } from './types.ts'
import { SystemClock, type Clock } from '../../utils/clock.ts'
import { generationOf, type RecordFields } from '../../workspace/record/types.ts'

// One job's entry in its session's list: its record, but for its number,
// which keys the entry, and its session, which keys the list, and the
// daemon running it.
interface ListEntry {
  command: string
  cwd: string
  started_at: number
  line?: string | null
  group?: number | null
  console: string
  owner: string
  state: JobState
  ended_at: number | null
  exit: number | null
  signal: number | null
}

/** A job's entry in its session's list. Mirrors Python's `_list_entry`. */
function listEntry(record: Job, owner: string): ListEntry {
  return {
    command: record.command,
    cwd: record.cwd,
    started_at: record.startedAt,
    line: record.line?.toString() ?? null,
    group: record.group,
    console: record.id.console,
    owner,
    state: record.state,
    ended_at: record.endedAt,
    exit: record.exit,
    signal: record.signal,
  }
}

/**
 * Take how another daemon's job ended from its list entry, should the entry
 * record an ending. Mirrors Python's `_take_entry`.
 */
function takeEntry(job: JobHandle, entry: ListEntry): void {
  if (entry.state !== 'exited') return
  job.state = 'exited'
  job.endedAt = entry.ended_at
  job.exitCode = entry.exit ?? 0
  job.signal = entry.signal
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
 * The lists live in the workspace's execution store, so every daemon on a
 * shared store sees a session's jobs with the same numbers. For now one
 * daemon runs a workspace's lines and jobs at a time: the one holding the
 * workspace's lease, which its table takes (`claim`) before it starts
 * anything and keeps until the workspace closes. A daemon is named by an id
 * it keeps across restarts, so a restarted one takes its workspaces back at
 * once, and ends as hung up the jobs it ran before. Another daemon's table
 * lists the jobs, reads and waits on their consoles, and kills one by
 * ending its console, which the holder watches for; it starts none while
 * the lease holds, and is told which daemon holds it
 * (`WorkspaceHeldError`). `sync` brings a session's list up to date before
 * a builtin reads it. A job whose daemon lost the lease with no ending was
 * lost with it and is ended as hung up, as a bash's job is when its
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
  store: ExecutionStore
  // The id of the daemon this table runs on, which its lease names.
  readonly daemon: string
  private held = false
  // One claim at a time, so a second waits for the first's lease and a close
  // for any claim under way.
  private claiming: Promise<void> = Promise.resolve()
  // When the lease was last taken or renewed, on the monotonic clock: past
  // its length the lease may be another daemon's.
  private renewedAt = 0
  // Records of programs this daemon left before a restart that the runStopper
  // could not reach, published with this life's so a later claim or another
  // daemon tries them again.
  private left: Record<string, RecordFields> = {}
  private jobs = new Map<string, Map<number, JobHandle>>()
  private readonly statuses = new Map<string, Map<number, Map<string, number>>>()
  private readonly marks = new Map<string, [number | null, number | null]>()
  // Jobs `disown` removed while still running, and ones another job's
  // number displaced: the shell forgets them, the workspace still owns
  // their tasks so teardown can stop them; each leaves once it finishes.
  private disowned: JobHandle[] = []
  private lease: ReturnType<typeof setTimeout> | null = null
  private checking: ReturnType<typeof setTimeout> | null = null
  // The bounds on killed jobs' stops (endKilled): each one's ending, and
  // the cut that ends its wait at once.
  private stopping = new Map<JobHandle, { ending: Promise<void>; cut: () => void }>()
  private publishing: Promise<void> | null = null
  // The publisher's pending sleep, which a close ends at once.
  private publishTick: { timer: ReturnType<typeof setTimeout>; wake: () => void } | null = null
  private closed = false
  private stoppingRuns = new Set<Promise<void>>()
  // Lapsed daemons this table already set about stopping, so a listing that
  // finds one again does not stop its runs again; and whether teardown
  // ended the stopping, which its runtimes are closing for.
  private stoppedOwners = new Set<string>()
  private stopsEnded = false
  private swept = false
  // The startup sweep's pending wait for a lease to pass, which a teardown
  // ends at once.
  private sweepTick: { timer: ReturnType<typeof setTimeout>; wake: () => void } | null = null
  // The table whose store and daemon the process plane is read and written
  // through: this one, or for a child shell's table the workspace's, since
  // a child shell keeps only its job list private.
  private plane: JobTable = this
  // The table that holds each running job, by its runner's PID, kept on the
  // plane: a child shell's jobs are in its own table, where a stop another
  // workspace asks for has to find them.
  private jobTables = new Map<number, JobTable>()
  /**
   * Stops the program a lapsed daemon's process ran past the workspace,
   * given the process as it was published and the first signal, and answers
   * whether this workspace reached it; the workspace sets it, since it holds
   * the runtimes that reach it.
   */
  runStopper: ((record: RecordFields, signum: number) => Promise<boolean>) | null = null
  // Told each job this table's jobs run as it ends; the workspace sets it,
  // to trace the job.
  ended: ((record: Job) => void) | null = null
  // Run once this table's daemon takes the workspace's lease; the workspace
  // sets it, to end the line and process records the daemon before it left
  // running.
  taken: (() => Promise<void>) | null = null

  /**
   * @param store the job plane holding each session's list and each job's
   *   console; null keeps them in memory, private to this table.
   */
  constructor(
    store: ExecutionStore | null = null,
    readonly processes = new ProcessTable(),
    // The table of the shell a `$( )` is part of, whose jobs `jobs` still
    // lists there, as bash's does; its `wait` and `kill` reach none of them.
    readonly parent: JobTable | null = null,
    // The workspace clock a job's `createdAt` is read on.
    readonly clock: Clock = new SystemClock(),
    // The daemon this table runs on; omitted is a fresh one, a daemon no
    // other table shares.
    daemon: string | null = null,
  ) {
    this.store = store ?? new RAMExecutionStore()
    this.daemon = daemon ?? crypto.randomUUID().replaceAll('-', '')
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
    const table = new JobTable(null, this.processes, parent, this.clock, this.daemon)
    table.plane = this.plane
    return table
  }

  /**
   * Whether this table's daemon holds the workspace's lease, as of its
   * `claim` or the last renewal.
   */
  get claimed(): boolean {
    return this.plane.held
  }

  /**
   * Take the workspace's lease for this table's daemon before it starts a
   * line or a job; once taken it is kept until `close`, so every later call
   * answers at once.
   *
   * Taking it reads the highest pid the store recorded, so this daemon
   * numbers past every pid given out before, and the processes this daemon
   * left before a restart, whose native runs are stopped meanwhile; one this
   * table runs now is its own. The processes this table runs are published
   * from then on. A lease lost or left unrenewed past its length is asked
   * for again. A child shell's table claims through the workspace's; a
   * closed table takes none. Throws `WorkspaceHeldError` when another daemon
   * holds the lease.
   */
  async claim(): Promise<void> {
    if (this.plane !== this) {
      await this.plane.claim()
      return
    }
    const turn = this.claiming.then(() => this.takeLease())
    this.claiming = turn.catch(() => undefined)
    await turn
  }

  private async takeLease(): Promise<void> {
    if ((this.held && !this.lapsed()) || this.closed) return
    const holder = await this.store.lease(this.daemon)
    if (holder !== null) throw new WorkspaceHeldError(this.processes.workspaceId, holder)
    const live = new Map(
      this.processes.live().map((h) => [String(h.record.id.pid), h.record.startedAt]),
    )
    const earlier = Object.fromEntries(
      Object.entries((await this.store.processes())[this.daemon] ?? {}).filter(
        ([pid, record]) => !live.has(pid) || live.get(pid) !== record.started_at,
      ),
    )
    this.processes.continueAfter(await this.store.highestPid())
    this.held = true
    this.renewedAt = performance.now()
    this.keepLease()
    if (this.taken !== null) {
      try {
        await this.taken()
      } catch (err) {
        console.debug('lost records not ended:', err)
      }
    }
    if (Object.keys(earlier).length > 0 && !this.stopsEnded) {
      const stopping = this.stopEarlier(earlier).finally(() => {
        this.stoppingRuns.delete(stopping)
      })
      this.stoppingRuns.add(stopping)
    }
    this.processesChanged()
  }

  /** Whether the lease went unrenewed past its length, so another daemon may hold it now. */
  private lapsed(): boolean {
    const lease = this.store.leaseSeconds
    return lease !== null && performance.now() - this.renewedAt > lease * 1000
  }

  /**
   * Let the lease go once another daemon may hold it: the next line or job
   * asks for it again, and what this table runs ends as hung up, as the
   * daemon that took it records it, so the two never both change the
   * workspace.
   */
  private lost(): void {
    if (this.lease !== null) clearTimeout(this.lease)
    this.lease = null
    this.held = false
    for (const handle of this.processes.live()) handle.terminate(HANGUP_EXIT_CODE - 128)
  }

  private sessionJobs(sessionId: string): Map<number, JobHandle> {
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
   * Its process is started first, so a session at its process cap refuses
   * the job before it takes a number, and the job's entry names the line
   * and group its process runs in. The number is taken from the store next,
   * so two workspaces starting a job on one session never share one. The
   * runner waits until the job and console are ready; failed setup stops the
   * process before it enters the supplied runner. Only fully initialized
   * jobs join the table. Throws `WorkspaceHeldError` when
   * another daemon holds the workspace's lease (`claim`).
   */
  async submit(init: {
    command: string
    run: JobRunner
    abort: AbortController
    cwd: string
    sessionId?: string
    parent?: number | null
    limit?: number | null
    // The job is one simple command (`JobHandle.simple`).
    simple?: boolean
    // Runs as the job's process ends, whether or not its runner began.
    ended?: () => Promise<void>
  }): Promise<JobHandle> {
    await this.claim()
    const sessionId = init.sessionId ?? ''
    const name = `job_${crypto.randomUUID().replaceAll('-', '')}`
    const createdAt = this.clock.now()
    let job: JobHandle | null = null
    let ready!: () => void
    const begun = new Promise<void>((resolve) => {
      ready = resolve
    })
    // The process starts first, so a session at its process cap refuses
    // the job before it takes a number, and the job's entry names the line
    // and group it runs in; its runner waits until the job is ready.
    const process = this.processes.start({
      sessionId,
      parent: init.parent ?? null,
      command: init.command,
      cwd: PathSpec.fromStrPath(init.cwd),
      run: async () => {
        try {
          await begun
          if (job === null) return KILLED_EXIT_CODE
          if (job.state !== 'running') return job.exitCode
          const watching = new AbortController()
          void job.watch(watching.signal).catch((err: unknown) => {
            console.debug('job watch failed:', err)
          })
          try {
            return await job.settle(init.run)
          } finally {
            watching.abort()
            await this.recordEnding(job)
            this.disowned = this.disowned.filter((j) => j !== job)
            this.dropChecking()
          }
        } finally {
          await init.ended?.()
        }
      },
      cancel: () => {
        init.abort.abort()
      },
      limit: init.limit ?? null,
      ignores: IGNORED_SIGNALS,
      oneCommand: init.simple === true,
      background: true,
      programIgnores: IGNORED_SIGNALS,
    })
    const { line, group } = process.record
    let jobId: number
    try {
      jobId = await this.allocate(
        sessionId,
        listEntry(
          {
            id: new JobId(this.processes.workspaceId, name),
            number: 0,
            sessionId,
            command: init.command,
            cwd: init.cwd,
            startedAt: createdAt,
            line,
            group,
            pid: process.record.id.pid,
            state: 'running',
            endedAt: null,
            exit: null,
            signal: null,
          },
          this.daemon,
        ),
      )
    } catch (error) {
      process.terminate()
      ready()
      throw error
    }
    try {
      const jobConsole = new JobConsole(this.store.console(name))
      jobConsole.bindProcess(process.record.id.toString())
      job = new JobHandle({
        id: jobId,
        command: init.command,
        abort: init.abort,
        cwd: init.cwd,
        sessionId,
        console: jobConsole,
        simple: init.simple ?? false,
        createdAt,
        owner: this.daemon,
        consoleName: name,
        workspaceId: this.processes.workspaceId,
        line,
        group,
        now: () => this.clock.now(),
        ended: this.plane.ended,
      })
    } catch (error) {
      process.terminate()
      ready()
      await this.remove(sessionId, new Set([name]), true)
      throw error
    }
    job.process = process
    this.sessionJobs(sessionId).set(job.id, job)
    this.jobAdded(sessionId, job.id)
    ready()
    const plane = this.plane
    const pid = process.record.id.pid
    plane.jobTables.set(pid, this)
    void process.join().then(() => plane.jobTables.delete(pid))
    // An abort from elsewhere stops the runner; one the runner's own stop
    // sent is that stop, which a KILL here would cut short.
    const onAbort = () => {
      if (process.signal === null) process.terminate()
    }
    init.abort.signal.addEventListener('abort', onAbort, { once: true })
    if (init.abort.signal.aborted) process.terminate()
    void process.join().then(() => {
      init.abort.signal.removeEventListener('abort', onAbort)
    })
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
  async load(job: JobHandle): Promise<void> {
    const name = `job_${crypto.randomUUID().replaceAll('-', '')}`
    const store = this.store.console(name)
    const [chunks] = await job.console.readFrom(0)
    for (const chunk of chunks) await store.append(chunk.channel, chunk.data)
    const restored = new JobConsole(store, true)
    if (job.processId !== null) restored.bindProcess(job.processId)
    job.console = restored
    job.owner = this.daemon
    job.consoleName = name
    job.workspaceId = this.processes.workspaceId
    job.id = await this.insert(job.sessionId, job.id, listEntry(job.record, job.owner))
    this.sessionJobs(job.sessionId).set(job.id, job)
    this.jobAdded(job.sessionId, job.id)
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
    let remotes = new Map<string, JobHandle>()
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
    const jobs = new Map<number, JobHandle>()
    for (const [key, entry] of Object.entries(entries)) {
      const job = mine.get(entry.console) ?? remotes.get(entry.console)
      mine.delete(entry.console)
      if (job === undefined) continue
      if (job.process === null && job.state === 'running') takeEntry(job, entry)
      jobs.set(Number(key), job)
    }
    for (const job of mine.values()) {
      if (job.process === null || job.state !== 'running') continue
      if (job.consoleName in held || jobs.has(job.id)) this.disowned.push(job)
      else jobs.set(job.id, job)
    }
    this.jobs.set(sessionId, new Map([...jobs].sort(([a], [b]) => a - b)))
    for (const job of jobs.values()) {
      if (job.process !== null) await job.adoptEnding()
      else if (job.state === 'running') await this.refresh(job)
    }
  }

  get(jobId: number, sessionId = ''): JobHandle | null {
    return this.jobs.get(sessionId)?.get(jobId) ?? null
  }

  listJobs(sessionId = ''): JobHandle[] {
    return [...(this.jobs.get(sessionId)?.values() ?? [])]
  }

  /** The jobs `jobs` shows: a `$( )`'s caller's, then its own. */
  listing(sessionId = ''): JobHandle[] {
    return [...(this.parent?.listing(sessionId) ?? []), ...this.listJobs(sessionId)]
  }

  runningJobs(sessionId = ''): JobHandle[] {
    return this.listJobs(sessionId).filter((j) => j.state === 'running')
  }

  /**
   * Every session's jobs, for the workspace-wide entry points only. Snapshot
   * capture and the server summary read this; a shell builtin never
   * does, since bash lists only its own jobs.
   */
  allJobs(): JobHandle[] {
    return [...this.jobs.values()].flatMap((jobs) => [...jobs.values()])
  }

  allRunningJobs(): JobHandle[] {
    return this.allJobs().filter((j) => j.state === 'running')
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
   * Another daemon's job is killed by ending its console; that daemon
   * sees the ending and stops the runner. Should the job have ended
   * first, the ending it wrote stands and the job was not killed. INT and
   * QUIT reach a running job and do nothing, as bash starts each job
   * ignoring them.
   *
   * @param signal the signal the job is stopped with; its status is 128
   *   plus it, KILL's 137 by default.
   */
  async kill(jobId: number, sessionId = '', signal = 9): Promise<boolean> {
    const job = this.get(jobId, sessionId)
    if (job?.state !== 'running') return false
    if (IGNORED_SIGNALS.has(signal)) return true
    if (job.process !== null) {
      await this.stopRunner(job, job.process, signal)
      return true
    }
    if (!(await this.running(job.owner))) await this.stopOwner(job.owner)
    await markKilled(job.console, 128 + signal, signal)
    await this.refresh(job)
    return job.signal !== null
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
    this.jobsLeaving(sessionId, new Set([jobId]))
    jobs.delete(jobId)
    const running = job.state === 'running'
    if (job.process !== null && running) this.disowned.push(job)
    this.keepStatuses(sessionId, [job], 0)
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
  async closeSession(sessionId: string): Promise<JobHandle[]> {
    const stopped = new Map<string, JobHandle>()
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
        if (entry.owner !== this.daemon)
          await markKilled(
            new JobConsole(this.store.console(name)),
            KILLED_EXIT_CODE,
            KILLED_EXIT_CODE - 128,
          )
      if (await this.store.delete(sessionId, generationOf(fields))) {
        this.jobs.delete(sessionId)
        this.marks.delete(sessionId)
        this.statuses.delete(sessionId)
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
   * stop. The stopping of lapsed owners' runs ends here as well, before the
   * runtimes it reaches them through close: none starts, and one under way
   * is waited for, bounded as a stop is. */
  async killAll(): Promise<JobHandle[]> {
    this.stopsEnded = true
    if (this.sweepTick !== null) {
      clearTimeout(this.sweepTick.timer)
      this.sweepTick.wake()
    }
    await Promise.allSettled([...this.stoppingRuns])
    const running = this.allRunningJobs().filter((j) => j.process !== null)
    for (const job of [...running, ...this.disowned])
      if (job.state === 'running' && job.process !== null) await job.stop()
    this.disowned = []
    return running
  }

  /**
   * Give the workspace's lease up, at workspace teardown, so another
   * daemon may run it. Called after killAll(), so every job this table ran
   * has ended and other daemons need no lease to settle them; a killed job
   * whose runner is still stopping has its console ended now rather than
   * at its bound. What is left of this daemon's record is the programs it
   * could not reach, for the next to try. The store itself belongs to the
   * workspace's state store.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.claiming
    if (this.lease !== null) clearTimeout(this.lease)
    if (this.checking !== null) clearTimeout(this.checking)
    this.lease = null
    this.checking = null
    for (const tick of [this.publishTick, this.sweepTick]) {
      if (tick === null) continue
      clearTimeout(tick.timer)
      tick.wake()
    }
    await this.publishing
    if (this.held) {
      this.held = false
      try {
        await this.store.publish(this.daemon, { ...this.left }, this.processes.lastPid)
        await this.store.release(this.daemon)
      } catch (err) {
        console.debug('workspace lease not released:', err)
      }
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
   * time (a handler finishes, a machine's run is stopped) and the status it
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
  async wait(jobId: number, sessionId = '', signal?: AbortSignal): Promise<JobHandle> {
    const job = this.get(jobId, sessionId)
    if (job === null) {
      throw new Error(`unknown job: ${jobId.toString()}`)
    }
    if (job.process === null) {
      if (job.state === 'running') await this.joinRemote(job, signal)
      return job
    }
    await job.console.waitFinished(signal)
    if (signal?.aborted === true) return job
    await job.adoptEnding()
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
  async waitAll(sessionId = '', signal?: AbortSignal): Promise<JobHandle[]> {
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
    this.jobsLeaving(sessionId, new Set([jobId]))
    this.jobs.get(sessionId)?.delete(jobId)
    this.keepStatuses(sessionId, [job])
    await this.remove(sessionId, new Set([job.consoleName]))
  }

  /** Keep how ended jobs ended, under the pids that name them, for a later `wait`. */
  private keepStatuses(
    sessionId: string,
    jobs: readonly JobHandle[],
    runningStatus: number | null = null,
  ): void {
    let kept = this.statuses.get(sessionId)
    if (kept === undefined) {
      kept = new Map()
      this.statuses.set(sessionId, kept)
    }
    for (const job of jobs) {
      const code = job.state === 'running' ? runningStatus : job.exitCode
      if (code === null) continue
      for (const [pid, machine] of job.namedPids) {
        const held = kept.get(pid) ?? new Map<string, number>()
        kept.set(pid, held.set(machine, code))
      }
    }
    for (const pid of [...kept.keys()].slice(0, Math.max(0, kept.size - SAVED_STATUSES)))
      kept.delete(pid)
  }

  /**
   * Drop how the jobs that left the list ended, as a bare `wait` does, which
   * leaves bash nothing to answer for their pids. Mirrors Python's
   * `forget_statuses`.
   */
  forgetStatuses(sessionId = ''): void {
    this.statuses.delete(sessionId)
  }

  /**
   * How the jobs a pid named ended, once they have left the list: each
   * machine's status for it, as `ps` shows the machine; empty for none.
   */
  savedStatuses(sessionId: string, pid: number): ReadonlyMap<string, number> {
    return this.statuses.get(sessionId)?.get(pid) ?? new Map<string, number>()
  }

  /**
   * Return a session's completed/killed jobs and remove them from its
   * list.
   *
   * A reader holding a job's console keeps reading it: the console
   * outlives its table entry and dies with its last reader.
   */
  /**
   * The jobs `jobs` marks `+` and `-`: the newest two, until one of those
   * leaves the list, when the marks go to the newest running ones, and a job
   * started after that takes `+`. Mirrors Python's `job_marks`.
   *
   * @param sessionId the session whose list it is.
   */
  jobMarks(sessionId = ''): [number | null, number | null] {
    const kept = this.marks.get(sessionId)
    if (kept !== undefined) return kept
    if (this.parent !== null && (this.jobs.get(sessionId)?.size ?? 0) === 0)
      return this.parent.jobMarks(sessionId)
    const newest = [...(this.jobs.get(sessionId)?.keys() ?? [])].sort((a, b) => b - a)
    return [newest[0] ?? null, newest[1] ?? null]
  }

  private jobAdded(sessionId: string, jobId: number): void {
    const kept = this.marks.get(sessionId)
    if (kept !== undefined) this.marks.set(sessionId, [jobId, kept[0]])
  }

  private jobsLeaving(sessionId: string, ids: ReadonlySet<number>): void {
    const [current, previous] = this.jobMarks(sessionId)
    if (!(current !== null && ids.has(current)) && !(previous !== null && ids.has(previous))) return
    const running = [...(this.jobs.get(sessionId)?.values() ?? [])]
      .filter((job) => job.state === 'running' && !ids.has(job.id))
      .map((job) => job.id)
      .sort((a, b) => b - a)
    this.marks.set(sessionId, [running[0] ?? null, running[1] ?? null])
  }

  async popCompleted(
    sessionId = '',
    keep: number | null = null,
    only: ReadonlySet<number> | null = null,
  ): Promise<JobHandle[]> {
    const jobs = this.jobs.get(sessionId)
    if (jobs === undefined) return []
    const completed = [...jobs.values()].filter(
      (j) => j.state !== 'running' && j.id !== keep && (only === null || only.has(j.id)),
    )
    this.jobsLeaving(sessionId, new Set(completed.map((j) => j.id)))
    for (const j of completed) jobs.delete(j.id)
    this.keepStatuses(sessionId, completed)
    if (completed.length > 0)
      await this.remove(sessionId, new Set(completed.map((j) => j.consoleName)))
    return completed
  }

  /**
   * Publish the processes this table's workspace runs, now that one
   * started: the publishing goes on while any runs (`publish`). Only the
   * daemon holding the lease publishes, from its `claim` on.
   */
  processesChanged(): void {
    if (!this.held || this.publishing !== null || this.closed) return
    this.publishing = this.publish()
  }

  /**
   * The processes other daemons on the store run in this workspace, daemon
   * to PID to process, as each last published them. A daemon that lost the
   * lease is left out: whatever it ran was lost with it, and the native runs
   * it left are stopped meanwhile.
   */
  async remoteProcesses(): Promise<Record<string, Record<string, RecordFields>>> {
    if (this.plane !== this) return this.plane.remoteProcesses()
    const found: Record<string, Record<string, RecordFields>> = {}
    for (const [daemon, records] of Object.entries(await this.store.processes())) {
      if (daemon === this.daemon || Object.keys(records).length === 0) continue
      if (await this.running(daemon)) found[daemon] = records
      else this.stopLater(daemon)
    }
    return found
  }

  /**
   * Signal a process another daemon runs in this workspace, by its pid:
   * that daemon stops it once it takes the stop, within `PUBLISH_SECONDS`.
   * Signal 0 only probes. The process of a daemon that lost the lease is
   * gone, and the native runs it left are stopped instead. The grants are
   * read once the store has answered, just before anything is stopped, so a
   * profile replaced meanwhile stops nothing under the old one. Answers
   * whether one live process was signalled; throws EPERM for one the
   * session sees but may not stop.
   *
   * @param pid the process.
   * @param signal the signal, 0 to probe.
   * @param sessionId the calling session.
   * @param permissions whose processes it may see and stop, null once the
   *   caller's view is revoked.
   */
  async signalRemote(
    pid: number,
    signal: number,
    sessionId: string,
    permissions: () => ProcessPermissions | null,
  ): Promise<boolean> {
    if (this.plane !== this) return this.plane.signalRemote(pid, signal, sessionId, permissions)
    const records = await this.store.processes()
    let daemons = Object.keys(records).filter(
      (found) => found !== this.daemon && Object.hasOwn(records[found] ?? {}, String(pid)),
    )
    if (daemons.length > 1) {
      const live = await Promise.all(daemons.map((found) => this.running(found)))
      daemons = daemons.filter((_, at) => live[at])
    }
    const [found] = daemons
    if (daemons.length !== 1 || found === undefined) return false
    const record = records[found]?.[String(pid)] ?? {}
    const own = record.session === sessionId
    const lapsed = !(await this.running(found))
    const granted = permissions()
    if (granted === null || (granted.list === 'session' && !own)) return false
    if (lapsed) {
      await this.stopOwner(found)
      return false
    }
    if (granted.kill === 'session' && !own)
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
    if (signal !== 0) await this.store.requestStop(found, pid, signal)
    return true
  }

  /** Another daemon's job, as its list entry describes it. */
  private remote(jobId: number, sessionId: string, entry: ListEntry): JobHandle {
    const job = new JobHandle({
      id: jobId,
      command: entry.command,
      cwd: entry.cwd,
      createdAt: entry.started_at,
      console: new JobConsole(this.store.console(entry.console)),
      sessionId,
      owner: entry.owner,
      consoleName: entry.console,
      workspaceId: this.processes.workspaceId,
      line: entry.line != null && entry.line !== '' ? new LineId(entry.line) : null,
      group: entry.group ?? null,
      now: () => this.clock.now(),
    })
    takeEntry(job, entry)
    return job
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
  private async stopRunner(job: JobHandle, process: ProcessHandle, signal: number): Promise<void> {
    if (!process.begun) {
      await job.stop(signal)
      await this.recordEnding(job)
      this.dropChecking()
      return
    }
    job.kill(signal)
    this.endKilled(job, process)
  }

  private endKilled(job: JobHandle, process: ProcessHandle): void {
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
  private async endStopping(job: JobHandle): Promise<void> {
    if (job.console.finished) return
    await job.end(job.exitCode, job.signal ?? KILLED_EXIT_CODE - 128)
    await this.recordEnding(job)
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
  private async recordEnding(job: JobHandle): Promise<void> {
    const kept = listEntry(job.record, job.owner)
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
          if (
            entry?.console !== job.consoleName ||
            (entry.state === kept.state &&
              entry.exit === kept.exit &&
              entry.signal === kept.signal &&
              entry.ended_at === kept.ended_at)
          )
            return
          jobs[job.id.toString()] = kept
        }
        if (await this.write(job.sessionId, fields, jobs, Number(fields.next ?? 1), held)) return
      }
      console.debug('job ending kept conflicting:', job.id)
    } catch (err) {
      console.debug('job ending not kept:', err)
    }
  }

  /**
   * Settle another daemon's job from its console's ending, or end it as
   * hung up when that daemon lost the lease with none.
   */
  private async refresh(job: JobHandle): Promise<void> {
    let outcome = await job.console.outcome()
    if (outcome === null) {
      if (await this.running(job.owner)) return
      this.stopLater(job.owner)
      await markKilled(job.console, HANGUP_EXIT_CODE, HANGUP_EXIT_CODE - 128)
      outcome = await job.console.outcome()
      if (outcome === null) return
    }
    job.take(outcome)
  }

  /**
   * Block until another workspace's job ends, or `signal` aborts. One read
   * follows the console across every lease check, so a long wait never
   * stacks readers, and an abandoned one stops reading.
   */
  private async joinRemote(job: JobHandle, signal?: AbortSignal): Promise<void> {
    const lease = this.store.leaseSeconds
    const finished = job.console.waitFinished(signal)
    finished.catch((err: unknown) => {
      console.debug('job wait failed:', err)
    })
    while (job.state === 'running' && signal?.aborted !== true) {
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
   * that, stopping after a targeted `wait` would leave a later `wait %1`
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
          if (dropped.has(Number(key)) && entry.state === 'running') held[entry.console] = entry
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
    const sessions = new Map<string, JobHandle[]>()
    for (const job of [...this.allJobs(), ...this.disowned]) {
      if (job.process === null || job.state !== 'running') continue
      const jobs = sessions.get(job.sessionId) ?? []
      jobs.push(job)
      sessions.set(job.sessionId, jobs)
    }
    for (const [sessionId, jobs] of sessions) {
      try {
        const held = heldConsoles(await this.store.load(sessionId))
        for (const job of jobs) {
          if (held.has(job.consoleName)) continue
          await job.adoptEnding()
          if (job.state === 'running' && job.process !== null)
            await this.stopRunner(job, job.process, 9)
        }
      } catch (err) {
        console.debug('job list check failed:', err)
      }
    }
  }

  /**
   * The live processes this workspace runs, as its record keeps them: a
   * program's with where it runs and its pid there.
   */
  private records(): Record<string, RecordFields> {
    const records: Record<string, RecordFields> = {}
    for (const handle of this.processes.live()) {
      const record = handle.record
      records[String(record.id.pid)] = {
        pid: record.id.pid,
        parent: record.parent,
        group: record.group,
        session: record.sessionId,
        command: record.command,
        cwd: record.cwd.virtual,
        machine: record.machine.toString(),
        started_at: record.startedAt,
        state: record.state,
        line: record.line?.toString() ?? null,
        runtime: record.runtime,
        machine_pid:
          record.machinePid === null
            ? null
            : {
                pid: record.machinePid.pid,
                started: record.machinePid.started,
                exited: record.machinePid.exited ?? null,
              },
      }
    }
    for (const [pid, left] of Object.entries(this.left)) records[pid] ??= left
    return records
  }

  /**
   * Publish the processes this workspace runs every `PUBLISH_SECONDS`
   * while it runs any, with the highest pid it handed out, and stop those
   * other daemons asked it to stop. Once it runs none, its record goes and
   * the publishing stops. The lease that vouches for the record is kept by
   * `keepLease` from the table's `claim` on, on its own timer whatever a
   * round costs. The record is written again every third of the lease, so
   * it outlives its store's expiry. Each record carries `seen_at`, when its
   * processes were read, the last time this daemon vouched for them and
   * their native runs, on the host's clock, which a host stop compares with
   * `ps`. A failed round is logged and tried again the next one, and a stop
   * that fails leaves the others it came with to be applied; the sleep
   * between rounds keeps no host alive on its own.
   */
  private async publish(): Promise<void> {
    let published: string | null = null
    const lease = this.store.leaseSeconds
    const rewrite = lease !== null ? Math.max(1, Math.floor(lease / 3 / PUBLISH_SECONDS)) : 0
    let rounds = 0
    for (;;) {
      const seen = Date.now() / 1000
      const records = this.records()
      const text = JSON.stringify(records)
      try {
        if (text !== published || (rewrite > 0 && rounds % rewrite === 0)) {
          await this.store.publish(
            this.daemon,
            Object.fromEntries(
              Object.entries(records).map(([pid, record]) => [pid, { seen_at: seen, ...record }]),
            ),
            this.processes.lastPid,
          )
          published = text
        }
        for (const [pid, signal] of await this.store.takeStops(this.daemon)) {
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
   * Stop one of this workspace's processes another daemon asked to stop: a job's runner the way `kill` stops a job, through the table
   * that holds it, a child shell's included; any other runner directly.
   */
  private async stopAsked(pid: number, signal: number): Promise<void> {
    const table = this.jobTables.get(pid) ?? this
    for (const job of table.allJobs()) {
      if (job.process !== null && job.pid === pid && job.state === 'running') {
        await table.kill(job.id, job.sessionId, signal)
        return
      }
    }
    for (const handle of this.processes.live()) {
      if (handle.record.id.pid === pid) {
        handle.terminate(signal)
        return
      }
    }
  }

  /**
   * Stop what the daemons that lost the lease left running, without
   * waiting: the workspace calls it as it starts, so what a crashed daemon
   * ran stops before anything lists it. Once per table, and only on a store
   * whose leases lapse: on any other, no daemon loses one but by closing.
   */
  stopLapsed(): void {
    if (this.swept || this.stopsEnded || this.store.leaseSeconds === null) return
    this.swept = true
    const sweeping = this.sweep().finally(() => {
      this.stoppingRuns.delete(sweeping)
    })
    this.stoppingRuns.add(sweeping)
  }

  /**
   * Stop the programs of the daemons that lost the lease, and once more a lease later while
   * another daemon still held it: one that died just before this one
   * started still holds it until then.
   */
  private async sweep(): Promise<void> {
    try {
      const live = await this.remoteProcesses()
      const lease = this.store.leaseSeconds
      if (this.stopsEnded || this.closed || Object.keys(live).length === 0 || lease === null) return
      const deadline = performance.now() + lease * 1000
      let remaining = lease * 1000
      while (remaining > 0) {
        await new Promise<void>((wake) => {
          const timer = setTimeout(wake, Math.max(1, remaining))
          ;(timer as { unref?: () => void }).unref?.()
          this.sweepTick = { timer, wake }
        })
        this.sweepTick = null
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a teardown may stop it across the await
        if (this.stopsEnded || this.closed) return
        remaining = deadline - performance.now()
      }
      await this.remoteProcesses()
    } catch (err) {
      console.debug('lapsed daemons not swept:', err)
    }
  }

  /** Stop the native runs a daemon that lost the lease left, without waiting. */
  private stopLater(owner: string): void {
    if (this.stopsEnded || this.stoppedOwners.has(owner)) return
    this.stoppedOwners.add(owner)
    const stopping = this.stopOwner(owner).finally(() => {
      this.stoppingRuns.delete(stopping)
    })
    this.stoppingRuns.add(stopping)
  }

  /**
   * Stop the programs a daemon that lost the lease left, those this
   * workspace reaches, and keep its record holding only the rest, for a
   * daemon that reaches them. This table's own daemon's record is its own
   * life's, so it is never stopped here.
   */
  private async stopOwner(owner: string): Promise<void> {
    if (owner === this.daemon) return
    try {
      const records = (await this.store.processes())[owner] ?? {}
      const kept = await this.stopProcesses(owner, records)
      if (!(await this.running(owner))) await this.store.publish(owner, kept)
    } catch (err) {
      console.debug(`lapsed daemon ${owner} not stopped:`, err)
    }
  }

  /**
   * Stop the programs this daemon left before a restart, which `claim`
   * found under its id. The ones the runStopper could not reach stay in this
   * life's record, as they were last vouched for.
   */
  private async stopEarlier(records: Record<string, RecordFields>): Promise<void> {
    try {
      this.left = await this.stopProcesses(this.daemon, records)
    } catch (err) {
      console.debug('runs left before a restart not stopped:', err)
      this.left = records
    }
    if (Object.keys(this.left).length > 0) this.processesChanged()
  }

  /**
   * Hand each process a daemon's records list that ran a program past the
   * workspace (its `runtime`) to the runStopper, and answer the ones this
   * workspace could not reach. The lease is checked again before each is
   * stopped, so a daemon that took it back meanwhile keeps its processes,
   * and its records as they are.
   */
  private async stopProcesses(
    owner: string,
    records: Record<string, RecordFields>,
  ): Promise<Record<string, RecordFields>> {
    const left: Record<string, RecordFields> = {}
    for (const [pid, record] of Object.entries(records)) {
      if (record.runtime == null) continue
      if (await this.running(owner)) return records
      if (this.runStopper === null || !(await this.runStopper(record, 15))) left[pid] = record
    }
    return left
  }

  /**
   * Whether a daemon still runs what it started here: it holds the
   * workspace's lease and is not this table's own, whose jobs and processes
   * from before a restart went with that life (the ones this table runs
   * have their runners here).
   */
  private async running(daemon: string): Promise<boolean> {
    return daemon !== this.daemon && (await this.store.holder()) === daemon
  }

  /**
   * Renew the workspace's lease from `claim` until `close`, on a store
   * whose leases lapse, with the consoles of the jobs this table still
   * runs, so a quiet one keeps its output while this table lives. A failed
   * renewal is logged and retried. Should another daemon take the lease, or
   * the renewals fail past its length, the lease is let go (`lost`): what
   * this table runs ends as hung up, and the next line or job asks for it
   * again (`claim`).
   */
  private keepLease(): void {
    const lease = this.store.leaseSeconds
    if (lease === null || this.lease !== null || this.closed) return
    const renew = () => {
      this.lease = setTimeout(
        () => {
          const consoles = [...this.allJobs(), ...this.disowned]
            .filter((j) => j.process !== null && !j.console.finished)
            .map((j) => j.consoleName)
          this.store.lease(this.daemon, consoles).then(
            (holder) => {
              if (holder === null) {
                this.renewedAt = performance.now()
                return
              }
              console.debug('workspace lease taken by', holder)
              this.lost()
            },
            (err: unknown) => {
              console.debug('workspace lease renewal failed:', err)
              if (this.lapsed()) this.lost()
            },
          )
          if (this.lease !== null) renew()
        },
        (lease * 1000) / 3,
      )
    }
    renew()
  }
}
