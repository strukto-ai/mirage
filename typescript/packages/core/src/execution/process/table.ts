import { DEFAULT_PROCESS_PERMISSIONS, type ProcessPermissions } from './config.ts'
import { FIRST_PID, KEPT_SIGNALS } from './constants.ts'
import { underCeiling, type PathSpec, type ProcessScope } from '../../types.ts'
import { newPauseGate, ProcessHandle, type ExecutionBind, type PauseGate } from './handle.ts'
import type { Process, ProcessRunner } from './types.ts'
import type { SessionProcesses } from './session.ts'
import { HISTORY_MAX_RECORDS, HISTORY_SECONDS, LOCAL_MACHINE } from '../constants.ts'
import { type LineId, type MachineId, ProcessId } from '../types.ts'
import { SIGCONT, SIGKILL, SIGSTOP } from '../../shell/constants.ts'
import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import { systemNow } from '../../utils/clock.ts'

/**
 * Deliver a signal to one runner of a group: one that ignores it hands it to
 * the program it runs right now, any other stops with it. Mirrors Python's
 * deliver.
 */
function deliver(handle: ProcessHandle, signal: number): void {
  if (handle.ignores.has(signal)) handle.interrupt(signal)
  else handle.terminate(signal, false)
}

/**
 * Workspace-owned live runners; exited handles retain their own results.
 *
 * IDs are workspace-local and never reused. For now one daemon runs a
 * workspace at a time, the one holding its lease, and numbers its pids on
 * from the highest the workspace's store recorded (`continueAfter`).
 */
export class ProcessTable {
  private nextPid = FIRST_PID
  private readonly runners = new Map<number, { generation: number; handle: ProcessHandle }>()
  private readonly history = new Map<number, { generation: number; record: Process }>()
  private readonly ancestors = new Map<number, readonly number[]>()
  private readonly generations = new Map<string, number>()
  private stopped = false
  // What `kill -STOP` holds, by pid, and the signal each was sent meanwhile.
  private readonly pauses = new Map<number, PauseGate>()
  private readonly heldSignals = new Map<number, number>()
  /**
   * The host's ceiling on any session's limit, a lifted one included,
   * whatever profile, snapshot or store set it. Mirrors Python's `ceiling`.
   */
  ceiling: number | null = null
  /**
   * Brings the table in step with what each machine runs now: the
   * processes a scan finds there join it, and leave once a scan no longer
   * sees them. The workspace sets it, since it holds the machines. Mirrors
   * Python's `scanner`.
   */
  scanner: (() => Promise<void>) | null = null
  /**
   * Sends a signal to a process that is a program on a machine as `kill`
   * sent it, answering whether it ran, or null for a process Mirage stops
   * itself. The workspace sets it. Mirrors Python's `sender`.
   */
  sender: ((handle: ProcessHandle, signal: number) => Promise<boolean> | null) | null = null

  /**
   * @param workspaceId the workspace whose pids these are.
   * @param machine where a process runs unless its caller names another,
   *   the workspace's own machine.
   * @param bind runs each runner as the process it is, so what it records
   *   names it; the workspace hands over the caller's `runAsProcess`.
   *   Without one a runner runs as it is.
   * @param changed called once a runner is started, so whoever publishes the
   *   live runners knows to.
   * @param now the epoch seconds a process starts at, which `ps` shows;
   *   omitted means the running workspace's system time.
   * @param ended told each process's record as it ends.
   * @param note told each process's record as it starts and each time it
   *   changes, as the workspace's store keeps it.
   */
  constructor(
    readonly workspaceId = '',
    readonly machine: MachineId = LOCAL_MACHINE,
    private readonly bind: ExecutionBind = (run) => run(),
    private readonly changed?: () => void,
    private readonly now: () => number = systemNow,
    private readonly ended?: (record: Process) => void,
    private readonly note?: (record: Process) => void,
  ) {}

  /** Whether a runner that was started has yet to begin. */
  queued(): boolean {
    for (const { handle } of this.runners.values()) if (!handle.begun) return true
    return false
  }

  /**
   * Host-only: the supplied runner must admit commands before effects.
   * `limit` is the most runners the session may hold, this one included,
   * held under `ceiling`;
   * stopping runners count until they finish cleanup and leave the live registry.
   * Past it this throws EAGAIN, what fork(2) answers at `ulimit -u`.
   * `started` is what the caller sets up from the process before its runner
   * runs (the session's `$$`, the shell its programs run in); a caller that
   * passes it has nothing left to do first, so the runner then starts at
   * once, unless a runner started before it has yet to begin: runners begin
   * in the order they were started, so a job's redirect lands before the
   * line that started it reads the file. `parent` is the pid of the runner
   * this one is a child of, and `line` the line it runs for, its parent's
   * when absent. `ignores` are the signals the
   * runner ignores, which stop neither it nor what it started. `pid` is the
   * pid to run under, a session's `$$` that each of its lines takes in
   * turn; a fresh one when absent or when a live runner holds it.
   * `ownGroup` leads a process group of its own, as timeout's command does,
   * instead of joining its parent's. `machine` is where its program runs,
   * the table's when absent, and `runtime` what Mirage runs it with, none
   * for Mirage itself. `oneCommand` marks a runner that runs exactly one
   * command, whose program it is (`ProcessHandle.take`), and
   * `programIgnores` what that program ignores as well, where `ignores` is
   * more than a shell's.
   */
  start(init: {
    sessionId: string
    command: string
    cwd: PathSpec
    run: ProcessRunner
    cancel: () => void
    parent?: number | null
    limit?: number | null
    line?: LineId | null
    started?: (handle: ProcessHandle) => void
    ignores?: ReadonlySet<number>
    pid?: number | null
    ownGroup?: boolean
    machine?: MachineId | null
    runtime?: string | null
    oneCommand?: boolean
    background?: boolean
    programIgnores?: ReadonlySet<number>
  }): ProcessHandle {
    if (this.stopped) throw new Error('process table is stopped')
    const limit = underCeiling(init.limit ?? null, this.ceiling)
    if (
      limit !== null &&
      [...this.runners.values()].filter(
        ({ handle }) =>
          handle.record.sessionId === init.sessionId &&
          (handle.record.runtime !== null || handle.record.machinePid === null),
      ).length >= limit
    )
      throw Object.assign(new Error('Resource temporarily unavailable'), { code: 'EAGAIN' })
    const above = init.parent == null ? undefined : this.runners.get(init.parent)
    if (init.parent != null && above?.handle.record.state !== 'running')
      throw new Error('parent process is no longer accepting children')
    const pid = init.pid == null || this.runners.has(init.pid) ? this.nextPid : init.pid
    this.nextPid = Math.max(this.nextPid, pid + 1)
    const ancestry =
      init.parent == null ? [] : [...(this.ancestors.get(init.parent) ?? []), init.parent]
    const handle: ProcessHandle = new ProcessHandle(
      {
        id: new ProcessId(this.workspaceId, pid),
        sessionId: init.sessionId,
        line: init.line ?? (above === undefined ? null : above.handle.record.line),
        parent: init.parent ?? null,
        group: (init.ownGroup === true ? undefined : above?.handle.record.group) ?? pid,
        command: init.command,
        cwd: init.cwd,
        machine: init.machine ?? this.machine,
        startedAt: this.now(),
        runtime: init.runtime ?? null,
        machinePid: null,
        state: 'running',
        endedAt: null,
        exit: null,
        signal: null,
        error: null,
        ancestors: ancestry,
      },
      init.run,
      () => {
        init.cancel()
      },
      (id) => {
        const entry = this.runners.get(id)
        if (entry?.handle !== handle) return
        this.runners.delete(id)
        this.history.delete(id)
        this.history.set(id, { generation: entry.generation, record: handle.record })
        this.prune()
        this.resume(handle)
        try {
          this.ended?.(handle.record)
        } catch (err) {
          console.debug('process ended hook failed:', err)
        }
      },
      (signal) => {
        this.terminateChildren(pid, signal)
      },
      this.bind,
      init.ignores,
      this.now,
    )
    handle.oneCommand = init.oneCommand === true
    handle.pauses = this.pauses
    handle.background = init.background === true || above?.handle.background === true
    handle.programIgnores = init.programIgnores ?? new Set()
    const eager = init.started !== undefined && !this.queued()
    this.runners.set(pid, { generation: this.generations.get(init.sessionId) ?? 0, handle })
    this.ancestors.set(pid, ancestry)
    if (this.note !== undefined) {
      handle.noted = this.note
      this.note(handle.record)
    }
    init.started?.(handle)
    handle.start(eager)
    this.changed?.()
    return handle
  }

  /** The highest pid handed out so far, the one before `FIRST_PID` before the first. */
  get lastPid(): number {
    return this.nextPid - 1
  }

  /**
   * Hand out the pids that follow past `pid`: the highest pid the
   * workspace's store recorded, read once when this table's daemon takes
   * the workspace's lease, so a pid another daemon, or this one before a
   * restart, gave out never repeats.
   */
  continueAfter(pid: number): void {
    this.nextPid = Math.max(this.nextPid, pid + 1)
  }

  /**
   * Request cancellation of every live runner whose parent is `pid` or
   * an ancestor further up, so grandchildren are reached after an
   * intermediate runner has exited.
   *
   * @param signal what the stop stands for, as the parent's.
   */
  terminateChildren(pid: number, signal = 9): void {
    for (const child of this.under(pid)) child.terminate(signal)
  }

  /**
   * Bring the table in step with what each machine runs now (`scanner`), as
   * `ps` does before it lists. Mirrors Python's `scan`.
   */
  async scan(): Promise<void> {
    if (this.scanner !== null) await this.scanner()
  }

  /**
   * Send a signal to a program on a machine as `kill` sent it (`sender`):
   * what it does with it is its own, and it ends when it exits. Answers
   * whether it ran, once sent; null for a runner Mirage stops itself
   * (`deliver`). Mirrors Python's `send`.
   */
  send(handle: ProcessHandle, signal: number): Promise<boolean> | null {
    if (handle.ignores.has(signal)) return null
    if (handle.takeSignal(signal)) {
      if (signal === SIGCONT) this.resume(handle)
      return Promise.resolve(true)
    }
    return this.sender === null ? null : this.sender(handle, signal)
  }

  /**
   * Hold a process Mirage runs itself, and what it started, at their next
   * wait, as `kill -STOP` holds a program. Mirrors Python's `pause`.
   */
  pause(handle: ProcessHandle): void {
    const pid = handle.record.id.pid
    if (!this.pauses.has(pid)) this.pauses.set(pid, newPauseGate())
    for (const member of [handle, ...this.under(pid)]) {
      member.showState('T')
      member.tellHeld()
    }
  }

  /**
   * Let a held process go on, as `kill -CONT` does. Answers the signal it
   * was sent while held, which it takes now, null for none. Mirrors Python's
   * `resume`.
   */
  resume(handle: ProcessHandle): number | null {
    const pid = handle.record.id.pid
    const held = this.pauses.get(pid)
    const signal = this.heldSignals.get(pid) ?? null
    this.pauses.delete(pid)
    this.heldSignals.delete(pid)
    if (held !== undefined) {
      held.resolve()
      for (const member of [handle, ...this.under(pid)]) {
        member.showState(null)
        member.tellHeld()
      }
    }
    return signal
  }

  /**
   * Keep a signal for a held process, which takes it when it goes on: only
   * KILL ends a stopped program. Answers whether the process is held.
   * Mirrors Python's `hold_signal`.
   */
  holdSignal(handle: ProcessHandle, signal: number): boolean {
    const pid = handle.record.id.pid
    if (!this.pauses.has(pid)) return false
    this.heldSignals.set(pid, signal)
    return true
  }

  /**
   * Signal one process, the one way `kill` and `timeout` do: a program on a
   * machine gets it as sent, and what Mirage runs itself does what the signal
   * does (`signalOwn`). Answers whether the process was there to signal, null
   * where a STOP cannot hold it: a runtime that cannot tell which task is
   * calling. Mirrors Python's `signal`.
   *
   * @param handle the process.
   * @param signal the signal; 0 only probes.
   * @param group it gets the signal as one of a group would.
   */
  async signal(handle: ProcessHandle, signal: number, group = false): Promise<boolean | null> {
    const sending = signal === 0 ? null : this.send(handle, signal)
    if (sending !== null) return sending
    return this.signalOwn(handle, signal, group)
  }

  /**
   * What a signal does to a process Mirage runs itself. It pauses at STOP and
   * goes on at CONT, taking then the signal it was sent while paused, since
   * only KILL ends a stopped program; a kept signal leaves it as it is, and
   * any other stops it. One of a group leaves what it started to their own
   * delivery and, if it ignores the signal, hands it to the program it runs
   * right now (`deliver`); one signalled alone stops what it started too, and
   * if it ignores the signal nothing happens. Mirrors Python's `_signal_own`.
   */
  private signalOwn(handle: ProcessHandle, signal: number, group: boolean): boolean | null {
    if (KEPT_SIGNALS.has(signal)) {
      if (signal === SIGSTOP) {
        if (!asyncContextIsolatesTasks) return null
        this.pause(handle)
      } else if (signal === SIGCONT) {
        const held = this.resume(handle)
        if (held !== null) return this.signalOwn(handle, held, group)
      }
      return true
    }
    if (signal !== SIGKILL && this.holdSignal(handle, signal)) return true
    let found = true
    if (group) deliver(handle, signal)
    else
      found = handle.ignores.has(signal) || handle.terminate(signal, handle.record.parent !== null)
    this.resume(handle)
    return found
  }

  /**
   * Signal every live runner of a process group, as killpg(2) does. The
   * machines are scanned first, so what a program started there is in the
   * group. Returns whether the group had a live runner. Mirrors Python's
   * signal_group.
   */
  async signalGroup(groupId: number, signal: number): Promise<boolean> {
    await this.scan()
    const members = this.members(groupId)
    await this.signalMembers(members, signal)
    return members.length > 0
  }

  /**
   * Signal each runner of a group: the programs on machines as sent, a parent
   * before its children so a shell does not see its child die first, and
   * Mirage's own at once (`signalOwn`), deepest first, so a native program
   * knows the signal before the shell that waits for it stops. A runner that
   * ignores it, a shell, hands it to the program it runs right now, unless a
   * process of that program, a child a scan found, got it as sent. Mirrors
   * Python's `signal_members`.
   *
   * @param members the runners, deepest first.
   * @param signal the signal; 0 only probes.
   */
  async signalMembers(members: readonly ProcessHandle[], signal: number): Promise<void> {
    if (signal === 0) return
    const sending = new Map(
      [...members].reverse().map((member) => [member.record.id.pid, this.send(member, signal)]),
    )
    const reached = new Set([...sending].filter(([, sent]) => sent !== null).map(([pid]) => pid))
    for (const member of members) {
      if (
        !reached.has(member.record.id.pid) &&
        (!member.ignores.has(signal) ||
          !members.some(
            (other) =>
              other.record.parent === member.record.id.pid && reached.has(other.record.id.pid),
          ))
      )
        this.signalOwn(member, signal, true)
    }
    await Promise.all([...sending.values()].filter((sent) => sent !== null))
  }

  private sees(
    handle: ProcessHandle,
    sessionId: string,
    scope: ProcessScope,
    generation: number,
  ): boolean {
    const entry = this.runners.get(handle.record.id.pid)
    return (
      (this.generations.get(sessionId) ?? 0) === generation &&
      (handle.record.sessionId !== sessionId ||
        entry === undefined ||
        entry.generation === generation) &&
      (scope === 'workspace' || handle.record.sessionId === sessionId)
    )
  }

  /**
   * The live processes a session's profile lets it see. Seeing one grants no
   * output access. Mirrors Python's `visible`.
   *
   * @param sessionId the session asking.
   * @param permissions what its profile grants.
   */
  visible(
    sessionId: string,
    permissions: ProcessPermissions = DEFAULT_PROCESS_PERMISSIONS,
  ): readonly Process[] {
    const generation = this.generations.get(sessionId) ?? 0
    return Object.freeze(
      [...this.runners.values()]
        .filter(({ handle }) => this.sees(handle, sessionId, permissions.list, generation))
        .map(({ handle }) => handle.record),
    )
  }

  /**
   * The process a session names to signal, null for one absent or one the
   * session does not see; it throws EPERM for one it sees but may not stop.
   * Mirrors Python's `target`.
   *
   * @param pid the process, by Mirage's own number for it.
   * @param sessionId the session asking.
   * @param permissions what its profile grants.
   * @param generation the session's incarnation the asker belongs to; the one
   *   now when absent.
   */
  target(
    pid: number,
    sessionId: string,
    permissions: ProcessPermissions = DEFAULT_PROCESS_PERMISSIONS,
    generation: number = this.generations.get(sessionId) ?? 0,
  ): ProcessHandle | null {
    const entry = this.runners.get(pid)
    if (entry === undefined || !this.sees(entry.handle, sessionId, permissions.list, generation))
      return null
    if (permissions.kill !== 'workspace' && entry.handle.record.sessionId !== sessionId)
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
    return entry.handle
  }

  /**
   * The members of a process group a session sees, deepest first, null for no
   * member it sees; it throws EPERM for a member it may not stop. Mirrors
   * Python's `group`.
   *
   * @param groupId the group.
   * @param sessionId the session asking.
   * @param permissions what its profile grants.
   */
  group(
    groupId: number,
    sessionId: string,
    permissions: ProcessPermissions = DEFAULT_PROCESS_PERMISSIONS,
  ): ProcessHandle[] | null {
    const generation = this.generations.get(sessionId) ?? 0
    const members = this.members(groupId).filter((handle) =>
      this.sees(handle, sessionId, permissions.list, generation),
    )
    if (members.length === 0) return null
    if (
      permissions.kill !== 'workspace' &&
      members.some((handle) => handle.record.sessionId !== sessionId)
    )
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
    return members
  }

  private members(groupId: number): ProcessHandle[] {
    const depth = (handle: ProcessHandle) => this.ancestors.get(handle.record.id.pid)?.length ?? 0
    return this.live()
      .filter((handle) => handle.record.group === groupId)
      .sort((a, b) => depth(b) - depth(a))
  }

  private under(pid: number): ProcessHandle[] {
    return this.live().filter(
      (child) => this.ancestors.get(child.record.id.pid)?.includes(pid) === true,
    )
  }

  /**
   * What a command's handler gets of a session's processes, good for the
   * session as it is now: one closed or re-profiled since sees nothing and
   * starts nothing.
   *
   * @param sessionId the session.
   * @param permissions what its profile grants, read at each use.
   */
  forSession(
    sessionId: string,
    permissions: () => ProcessPermissions = () => DEFAULT_PROCESS_PERMISSIONS,
  ): SessionProcesses {
    const generation = this.generations.get(sessionId) ?? 0
    return Object.freeze({
      checkSpawn: () => {
        if ((this.generations.get(sessionId) ?? 0) !== generation)
          throw Object.assign(new Error('process spawn is not permitted'), { code: 'EACCES' })
      },
      probe: (pid: number) => this.target(pid, sessionId, permissions(), generation) !== null,
      signal: async (pid: number, signal: number) => {
        const handle = this.target(pid, sessionId, permissions(), generation)
        return handle === null ? false : ((await this.signal(handle, signal)) ?? false)
      },
    })
  }

  /**
   * Revoke the session's views and cancel its runners. A closed session's
   * ID can be reused and a replaced profile grants a new view, so neither
   * may keep an entry point, or a runner admitted under the old grants.
   */
  revokeSession(sessionId: string): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
    for (const process of this.live()) {
      if (process.record.sessionId !== sessionId) continue
      process.revoked = true
      process.terminate()
    }
  }

  /**
   * Whether the record the table keeps under `record`'s pid, live or
   * ended, started in its session as it is now: one closed or re-profiled
   * since is not, so a session that reuses the id sees none of its
   * predecessor's. Mirrors Python's `current`.
   */
  current(record: Process): boolean {
    const live = this.runners.get(record.id.pid)
    const entry =
      live === undefined
        ? this.history.get(record.id.pid)
        : { generation: live.generation, record: live.handle.record }
    return (
      entry?.record.sessionId === record.sessionId &&
      entry.generation === (this.generations.get(record.sessionId) ?? 0)
    )
  }

  /** Host-only inventory, including disowned and stopping runners. */
  live(): readonly ProcessHandle[] {
    return [...this.runners.values()].map((entry) => entry.handle)
  }

  /**
   * The records the table keeps, by pid: every live process's, and the
   * newest ended ones, `HISTORY_MAX_RECORDS` of them for `HISTORY_SECONDS`
   * at most. A pid a session's lines run under in turn keeps its latest.
   */
  records(): Process[] {
    this.prune()
    const kept = new Map([...this.history].map(([pid, { record }]) => [pid, record]))
    for (const [pid, { handle }] of this.runners) kept.set(pid, handle.record)
    return [...kept.entries()].sort(([a], [b]) => a - b).map(([, record]) => record)
  }

  /**
   * The pid and those of every process under it the table keeps, live or
   * ended. Each is found by its whole ancestry, kept for as long as its
   * record is, so a process stays under an ancestor whose own record has
   * gone.
   */
  tree(pid: number): Set<number> {
    this.prune()
    const tree = new Set([pid])
    for (const other of [...this.history.keys(), ...this.runners.keys()]) {
      if (this.ancestors.get(other)?.includes(pid) === true) tree.add(other)
    }
    return tree
  }

  /**
   * Drop the oldest ended records past the history's bounds, and the
   * ancestry of each a live process does not reuse; they are kept in the
   * order they ended.
   */
  private prune(): void {
    const cutoff = this.now() - HISTORY_SECONDS
    for (const [pid, { record }] of this.history) {
      if (this.history.size <= HISTORY_MAX_RECORDS && (record.endedAt ?? 0) > cutoff) break
      this.history.delete(pid)
      if (!this.runners.has(pid)) this.ancestors.delete(pid)
    }
  }

  /** Join managed runners before releasing their workspace resources. */
  async drain(): Promise<void> {
    await Promise.all(this.live().map((process) => process.join()))
  }

  /** Close admission and request cancellation; stopping is not completion. */
  stop(): void {
    this.stopped = true
    const errors: unknown[] = []
    for (const process of this.live()) {
      process.revoked = true
      try {
        process.terminate()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'process cancellation failed')
  }
}
