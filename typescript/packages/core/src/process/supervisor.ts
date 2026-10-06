import { DEFAULT_PROCESS_PERMISSIONS, type ProcessPermissions } from './config.ts'
import type { PathSpec, ProcessScope } from '../types.ts'
import { ProcessHandle } from './handle.ts'
import type { ProcessRunner, ProcessView } from './types.ts'

/** Workspace-owned live runners; exited handles retain their own results. */
export class ProcessSupervisor {
  private nextPid = 1
  private readonly runners = new Map<number, { generation: number; handle: ProcessHandle }>()
  private readonly generations = new Map<string, number>()
  private stopped = false

  /**
   * Host-only: the supplied runner must admit commands before effects.
   * `limit` is the most runners the session may hold, this one included;
   * stopping runners count until they finish cleanup and leave the live registry.
   * Past it this throws EAGAIN, what fork(2) answers at `ulimit -u`.
   */
  start(init: {
    sessionId: string
    command: string
    cwd: PathSpec
    run: ProcessRunner
    cancel: () => void
    parentPid?: number | null
    limit?: number | null
  }): ProcessHandle {
    if (this.stopped) throw new Error('process supervisor is stopped')
    if (
      init.limit != null &&
      [...this.runners.values()].filter(({ handle }) => handle.info.sessionId === init.sessionId)
        .length >= init.limit
    )
      throw Object.assign(new Error('Resource temporarily unavailable'), { code: 'EAGAIN' })
    const parent = init.parentPid == null ? undefined : this.runners.get(init.parentPid)
    if (
      init.parentPid != null &&
      (parent === undefined || parent.handle.info.cancellationRequested)
    )
      throw new Error('parent process is no longer accepting children')
    const pid = this.nextPid++
    const handle = new ProcessHandle(
      {
        pid,
        parentPid: init.parentPid ?? null,
        groupId:
          (init.parentPid == null
            ? undefined
            : this.runners.get(init.parentPid)?.handle.info.groupId) ?? pid,
        sessionId: init.sessionId,
        command: init.command,
        cwd: init.cwd,
        startedAt: Date.now() / 1000,
        state: 'running',
        cancellationRequested: false,
        exitCode: null,
        failure: null,
      },
      init.run,
      () => {
        this.terminateChildren(pid)
        init.cancel()
      },
      (id) => {
        this.runners.delete(id)
      },
    )
    this.runners.set(pid, { generation: this.generations.get(init.sessionId) ?? 0, handle })
    return handle
  }

  /**
   * Request cancellation of every live runner whose parent is `pid` or
   * whose execution group `pid` started, so grandchildren are reached
   * after an intermediate runner has exited.
   */
  terminateChildren(pid: number): void {
    for (const child of this.live())
      if (child.info.parentPid === pid || (child.info.groupId === pid && child.info.pid !== pid))
        child.terminate()
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
    return Object.freeze({
      list: () =>
        Object.freeze(
          [...this.runners.values()].flatMap(({ handle }) => {
            const info = visible(handle)
            return info === null ? [] : [info]
          }),
        ),
      get: (pid: number) => {
        const entry = this.runners.get(pid)
        return entry === undefined ? null : visible(entry.handle)
      },
      checkSpawn: () => {
        if (!valid())
          throw Object.assign(new Error('process spawn is not permitted'), { code: 'EACCES' })
      },
      probe: (pid: number) => signalTarget(pid) !== null,
      terminate: (pid: number) => signalTarget(pid)?.terminate() ?? false,
      wait: async (pid: number) => {
        const entry = this.runners.get(pid)
        if (entry === undefined || visible(entry.handle) === null) return null
        await entry.handle.join()
        return visible(entry.handle)
      },
    })
  }

  /**
   * Revoke the session's views and cancel its runners. A closed session's
   * ID can be reused and a replaced profile grants a new view, so neither
   * may keep a door, or a runner admitted under the old grants.
   */
  revokeSession(sessionId: string): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
    for (const process of this.live()) if (process.info.sessionId === sessionId) process.terminate()
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
      try {
        process.terminate()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'process cancellation failed')
  }
}
