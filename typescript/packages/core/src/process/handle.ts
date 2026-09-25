import { withProcessCleanup } from './cleanup.ts'
import type { ProcessInfo, ProcessRunner } from './types.ts'

/** Host-side runner lifecycle; cancellation and actual completion are separate.
 * Joining covers the runner's finally blocks, not untracked native descendants.
 */
export class ProcessHandle {
  readonly task: Promise<number>
  private current: ProcessInfo
  private readonly completion: Promise<ProcessInfo>

  constructor(
    info: ProcessInfo,
    run: ProcessRunner,
    private readonly cancel: () => void,
    finished: (pid: number) => void,
  ) {
    this.current = Object.freeze(info)
    // Register identity before executing even a synchronous runner prelude.
    this.task = Promise.resolve().then(() => withProcessCleanup(run))
    this.completion = this.task.then(
      (code) => this.settle(code, null, finished),
      (error: unknown) => {
        const aborted = error instanceof Error && error.name === 'AbortError'
        if (aborted) this.current = Object.freeze({ ...this.current, cancellationRequested: true })
        return this.settle(
          aborted ? 137 : 1,
          aborted ? null : error instanceof Error ? error.message : String(error),
          finished,
        )
      },
    )
  }

  get info(): ProcessInfo {
    return this.current
  }

  terminate(): boolean {
    if (this.current.state === 'exited' || this.current.cancellationRequested) return false
    const previous = this.current
    this.current = Object.freeze({
      ...this.current,
      state: 'stopping',
      cancellationRequested: true,
    })
    try {
      this.cancel()
    } catch (error) {
      this.current = previous
      throw error
    }
    return true
  }

  private settle(
    code: number,
    failure: string | null,
    finished: (pid: number) => void,
  ): ProcessInfo {
    this.current = Object.freeze({ ...this.current, state: 'exited', exitCode: code, failure })
    finished(this.current.pid)
    return this.current
  }

  join(): Promise<ProcessInfo> {
    return this.completion
  }
}
