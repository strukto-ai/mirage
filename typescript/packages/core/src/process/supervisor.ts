import {
  DEFAULT_PROCESS_PERMISSIONS,
  type ProcessPermissions,
  type ProcessScope,
} from './config.ts'
import type { PathSpec } from '../types.ts'
import { ProcessHandle } from './handle.ts'
import type { ProcessRunner, ProcessView } from './types.ts'

/** Workspace-owned live runners; exited handles retain their own results. */
export class ProcessSupervisor {
  private nextPid = 1
  private readonly runners = new Map<number, { generation: number; handle: ProcessHandle }>()
  private readonly generations = new Map<string, number>()
  private stopped = false

  /** Host-only: the supplied runner must admit commands before effects. */
  start(init: {
    sessionId: string
    command: string
    cwd: PathSpec
    run: ProcessRunner
    cancel: () => void
    parentPid?: number | null
  }): ProcessHandle {
    if (this.stopped) throw new Error('process supervisor is stopped')
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
        for (const child of this.live())
          if (
            child.info.parentPid === pid ||
            (child.info.groupId === pid && child.info.pid !== pid)
          )
            child.terminate()
        init.cancel()
      },
      (id) => {
        this.runners.delete(id)
      },
    )
    this.runners.set(pid, { generation: this.generations.get(init.sessionId) ?? 0, handle })
    return handle
  }

  view(
    sessionId: string,
    permissions: () => ProcessPermissions = () => DEFAULT_PROCESS_PERMISSIONS,
  ): ProcessView {
    const generation = this.generations.get(sessionId) ?? 0
    const valid = () => (this.generations.get(sessionId) ?? 0) === generation
    const allowed = (scope: ProcessScope, handle: ProcessHandle) =>
      scope === 'workspace' || (scope === 'session' && handle.info.sessionId === sessionId)
    const visible = (handle: ProcessHandle) => {
      const entry = this.runners.get(handle.info.pid)
      if (
        handle.info.sessionId === sessionId &&
        entry !== undefined &&
        entry.generation !== generation
      )
        return null
      const grants = permissions()
      if (!valid() || !allowed(grants.metadata, handle)) return null
      return allowed(grants.details, handle)
        ? handle.info
        : Object.freeze({ ...handle.info, command: null, cwd: null, failure: null })
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
        if (!valid() || !permissions().spawn)
          throw Object.assign(new Error('process spawn is not permitted'), { code: 'EACCES' })
      },
      terminate: (pid: number) => {
        const entry = this.runners.get(pid)
        return (
          entry !== undefined &&
          visible(entry.handle) !== null &&
          allowed(permissions().control, entry.handle) &&
          entry.handle.terminate()
        )
      },
      wait: async (pid: number) => {
        const entry = this.runners.get(pid)
        if (entry === undefined || visible(entry.handle) === null) return null
        await entry.handle.join()
        return visible(entry.handle)
      },
    })
  }

  revokeSession(sessionId: string): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
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
