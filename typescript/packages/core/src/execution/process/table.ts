import { DEFAULT_PROCESS_PERMISSIONS, type ProcessPermissions } from './config.ts'
import { FIRST_PID } from './constants.ts'
import { underCeiling, type PathSpec, type ProcessScope } from '../../types.ts'
import { ProcessHandle, type ExecutionBind } from './handle.ts'
import type { Process, ProcessRunner } from './types.ts'
import type { ProcessView } from './view.ts'
import { HISTORY_MAX_RECORDS, HISTORY_SECONDS, LOCAL_MACHINE } from '../constants.ts'
import { type LineId, type MachineId, ProcessId } from '../types.ts'
import { systemNow } from '../../utils/clock.ts'

/**
 * Deliver a signal to one runner of a group: one that ignores it hands it to
 * the program it runs right now, any other stops with it. Mirrors Python's
 * deliver.
 */
export function deliver(handle: ProcessHandle, signal: number): void {
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
   * command, whose program it is (`ProcessHandle.take`).
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
    if (this.sender === null || handle.ignores.has(signal)) return null
    return this.sender(handle, signal)
  }

  /**
   * Deliver a signal to every live runner of a process group, as killpg(2)
   * does: a program on a machine gets it as sent (`send`), a runner that
   * ignores it (a shell) hands it to the program it runs right now
   * (`ProcessHandle.interrupt`), and any other stops with it and leaves the
   * rest of the group to their own delivery. The deepest runners hear it
   * first, so a native program knows the signal before the shell that waits
   * for it stops. The machines are scanned first, so what a program started
   * there is in the group. Returns whether the group had a live runner.
   * Mirrors Python's signal_group.
   */
  async signalGroup(groupId: number, signal: number): Promise<boolean> {
    await this.scan()
    const members = this.members(groupId)
    await signalMembers(this, members, signal)
    return members.length > 0
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

  view(
    sessionId: string,
    permissions: () => ProcessPermissions = () => DEFAULT_PROCESS_PERMISSIONS,
  ): ProcessView {
    const generation = this.generations.get(sessionId) ?? 0
    const valid = () => (this.generations.get(sessionId) ?? 0) === generation
    const allowed = (scope: ProcessScope, handle: ProcessHandle) =>
      scope === 'workspace' || handle.record.sessionId === sessionId
    const visible = (handle: ProcessHandle) => {
      const entry = this.runners.get(handle.record.id.pid)
      if (
        handle.record.sessionId === sessionId &&
        entry !== undefined &&
        entry.generation !== generation
      )
        return null
      if (!valid() || !allowed(permissions().list, handle)) return null
      return handle.record
    }
    const signalTarget = (pid: number): ProcessHandle | null => {
      const entry = this.runners.get(pid)
      if (entry === undefined || visible(entry.handle) === null) return null
      if (!allowed(permissions().kill, entry.handle))
        throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
      return entry.handle
    }
    const group = (groupId: number): ProcessHandle[] | null => {
      const members = this.members(groupId).filter((handle) => visible(handle) !== null)
      if (members.length === 0) return null
      if (!members.every((handle) => allowed(permissions().kill, handle)))
        throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
      return members
    }
    return Object.freeze({
      list: () =>
        Object.freeze(
          [...this.runners.values()].flatMap(({ handle }) => {
            const info = visible(handle)
            return info === null ? [] : [info]
          }),
        ),
      checkSpawn: () => {
        if (!valid())
          throw Object.assign(new Error('process spawn is not permitted'), { code: 'EACCES' })
      },
      probe: (pid: number) => signalTarget(pid) !== null,
      // A session's shell leaves its jobs running, as bash's do when it dies.
      terminate: (pid: number, signal: number) => {
        const handle = signalTarget(pid)
        return (
          handle !== null &&
          (handle.ignores.has(signal) || handle.terminate(signal, handle.record.parent !== null))
        )
      },
      permissions: () => (valid() ? permissions() : null),
      probeGroup: (groupId: number) => group(groupId) !== null,
      signalGroup: async (groupId: number, signal: number) => {
        await this.scan()
        const members = group(groupId)
        await signalMembers(this, members ?? [], signal)
        return members !== null
      },
      scan: () => this.scan(),
      send: (pid: number, signal: number) => {
        const handle = signalTarget(pid)
        return handle === null ? null : this.send(handle, signal)
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

/**
 * Deliver a signal to each runner of a group, in order: the programs on
 * machines as sent, Mirage's own at once (`deliver`). A runner that ignores
 * it, a shell, hands it to the program it runs right now, unless a process
 * of that program, a child a scan found, already got it as sent.
 *
 * @param table the table the runners run in.
 * @param members the runners, deepest first.
 * @param signal the signal.
 */
async function signalMembers(
  table: ProcessTable,
  members: readonly ProcessHandle[],
  signal: number,
): Promise<void> {
  const sending: Promise<boolean>[] = []
  const reached = new Set<number>()
  for (const member of members) {
    const sent = table.send(member, signal)
    if (sent !== null) {
      sending.push(sent)
      reached.add(member.record.id.pid)
    } else if (
      !member.ignores.has(signal) ||
      !members.some(
        (other) => other.record.parent === member.record.id.pid && reached.has(other.record.id.pid),
      )
    )
      deliver(member, signal)
  }
  await Promise.all(sending)
}
