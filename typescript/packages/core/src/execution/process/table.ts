import { DEFAULT_PROCESS_PERMISSIONS, type ProcessPermissions } from './config.ts'
import { underCeiling, type PathSpec, type ProcessScope } from '../../types.ts'
import { ProcessHandle, type ExecutionBind } from './handle.ts'
import type { ProcessRunner } from './types.ts'
import type { ProcessView } from './view.ts'
import { newExecutionId } from '../context.ts'
import type { IdSource } from '../../utils/ids.ts'
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

/** Workspace-owned live runners; exited handles retain their own results. */
export class ProcessTable {
  private nextPid = 1
  private readonly runners = new Map<number, { generation: number; handle: ProcessHandle }>()
  private readonly ancestors = new Map<number, readonly number[]>()
  private readonly generations = new Map<string, number>()
  private stopped = false
  /**
   * The host's ceiling on any session's limit, a lifted one included,
   * whatever profile, snapshot or store set it. Mirrors Python's `ceiling`.
   */
  ceiling: number | null = null

  /**
   * @param bind runs each runner as part of its execution, so what it
   *   records names it; the workspace hands over the caller's
   *   `runWithExecution`. Without one a runner runs as it is.
   */
  /**
   * @param bind runs a process's body under its execution id.
   * @param ids where a process's execution id is drawn when its caller names
   *   none; omitted means the system source.
   * @param changed called once a runner is started, so whoever publishes the
   *   live runners knows to.
   * @param now the epoch seconds a process starts at, which `ps` shows;
   *   omitted means the running workspace's system time.
   */
  constructor(
    private readonly bind: ExecutionBind = (_id, run) => run(),
    private readonly ids?: IdSource,
    private readonly changed?: () => void,
    private readonly now: () => number = systemNow,
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
   * line that started it reads the file. `ignores` are the signals the
   * runner ignores, which stop neither it nor what it started. `pid` is the
   * pid to run under, a session's `$$` that each of its lines takes in
   * turn; a fresh one when absent or when a live runner holds it.
   * `ownGroup` leads a process group of its own, as timeout's command does,
   * instead of joining its parent's.
   */
  start(init: {
    sessionId: string
    command: string
    cwd: PathSpec
    run: ProcessRunner
    cancel: () => void
    parentPid?: number | null
    limit?: number | null
    executionId?: string
    started?: (handle: ProcessHandle) => void
    ignores?: ReadonlySet<number>
    pid?: number | null
    ownGroup?: boolean
  }): ProcessHandle {
    if (this.stopped) throw new Error('process table is stopped')
    const limit = underCeiling(init.limit ?? null, this.ceiling)
    if (
      limit !== null &&
      [...this.runners.values()].filter(({ handle }) => handle.info.sessionId === init.sessionId)
        .length >= limit
    )
      throw Object.assign(new Error('Resource temporarily unavailable'), { code: 'EAGAIN' })
    const parent = init.parentPid == null ? undefined : this.runners.get(init.parentPid)
    if (
      init.parentPid != null &&
      (parent === undefined || parent.handle.info.cancellationRequested)
    )
      throw new Error('parent process is no longer accepting children')
    const pid = init.pid == null || this.runners.has(init.pid) ? this.nextPid : init.pid
    this.nextPid = Math.max(this.nextPid, pid + 1)
    const handle: ProcessHandle = new ProcessHandle(
      {
        pid,
        executionId: init.executionId ?? newExecutionId(this.ids),
        parentPid: init.parentPid ?? null,
        groupId: (init.ownGroup === true ? undefined : parent?.handle.info.groupId) ?? pid,
        sessionId: init.sessionId,
        command: init.command,
        cwd: init.cwd,
        startedAt: this.now(),
        state: 'running',
        cancellationRequested: false,
        exitCode: null,
        failure: null,
      },
      init.run,
      () => {
        init.cancel()
      },
      (id) => {
        if (this.runners.get(id)?.handle !== handle) return
        this.runners.delete(id)
        this.ancestors.delete(id)
      },
      (signal) => {
        this.terminateChildren(pid, signal)
      },
      this.bind,
      init.ignores,
    )
    const eager = init.started !== undefined && !this.queued()
    this.runners.set(pid, { generation: this.generations.get(init.sessionId) ?? 0, handle })
    this.ancestors.set(
      pid,
      init.parentPid == null ? [] : [...(this.ancestors.get(init.parentPid) ?? []), init.parentPid],
    )
    init.started?.(handle)
    handle.start(eager)
    this.changed?.()
    return handle
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
   * Deliver a signal to every live runner of a process group, as killpg(2)
   * does: a runner that ignores it (a shell) hands it to the program it runs
   * right now (`ProcessHandle.interrupt`), and any other stops with it and
   * leaves the rest of the group to their own delivery. The deepest runners
   * hear it first, so a native program knows the signal before the shell
   * that waits for it stops. Returns whether the group had a live runner.
   * Mirrors Python's signal_group.
   */
  signalGroup(groupId: number, signal: number): boolean {
    const members = this.members(groupId)
    for (const member of members) deliver(member, signal)
    return members.length > 0
  }

  private members(groupId: number): ProcessHandle[] {
    const depth = (handle: ProcessHandle) => this.ancestors.get(handle.info.pid)?.length ?? 0
    return this.live()
      .filter((handle) => handle.info.groupId === groupId)
      .sort((a, b) => depth(b) - depth(a))
  }

  private under(pid: number): ProcessHandle[] {
    return this.live().filter((child) => this.ancestors.get(child.info.pid)?.includes(pid) === true)
  }

  view(
    sessionId: string,
    permissions: () => ProcessPermissions = () => DEFAULT_PROCESS_PERMISSIONS,
  ): ProcessView {
    const generation = this.generations.get(sessionId) ?? 0
    const valid = () => (this.generations.get(sessionId) ?? 0) === generation
    const allowed = (scope: ProcessScope, handle: ProcessHandle) =>
      scope === 'workspace' || handle.info.sessionId === sessionId
    const visible = (handle: ProcessHandle) => {
      const entry = this.runners.get(handle.info.pid)
      if (
        handle.info.sessionId === sessionId &&
        entry !== undefined &&
        entry.generation !== generation
      )
        return null
      if (!valid() || !allowed(permissions().list, handle)) return null
      return handle.info
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
          (handle.ignores.has(signal) || handle.terminate(signal, handle.info.parentPid !== null))
        )
      },
      permissions: () => (valid() ? permissions() : null),
      probeGroup: (groupId: number) => group(groupId) !== null,
      signalGroup: (groupId: number, signal: number) => {
        const members = group(groupId)
        for (const member of members ?? []) deliver(member, signal)
        return members !== null
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
      if (process.info.sessionId !== sessionId) continue
      process.revoked = true
      process.terminate()
    }
  }

  /** Host-only inventory, including disowned and stopping runners. */
  live(): readonly ProcessHandle[] {
    return [...this.runners.values()].map((entry) => entry.handle)
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
