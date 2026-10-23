import type { ProcessInfo, ProcessRunner } from './types.ts'

/**
 * Runs a runner as part of its execution, so what it records names it and
 * the runner it is. The workspace hands over the caller's binder: the
 * process layer sits below the session the caller carries, so it cannot
 * import it.
 */
export type ExecutionBind = <T>(
  executionId: string,
  run: () => Promise<T>,
  process: ProcessHandle,
) => Promise<T>

/** Host-side runner lifecycle; cancellation and actual completion are separate.
 * A cancellation stands for a signal: a native program the runner started
 * receives it, and a cancelled runner's status is 128 plus it, as a shell
 * reports a child the signal ended. Joining covers the runner's finally
 * blocks, not untracked native descendants.
 */
export class ProcessHandle {
  readonly task: Promise<number>
  private current: ProcessInfo
  private stopSignal: number | null = null
  private readonly completion: Promise<ProcessInfo>

  constructor(
    info: ProcessInfo,
    run: ProcessRunner,
    private readonly cancel: (signal: number) => void,
    finished: (pid: number) => void,
    bind: ExecutionBind = (_id, run) => run(),
  ) {
    this.current = Object.freeze(info)
    // Register identity before executing even a synchronous runner prelude.
    this.task = Promise.resolve().then(() => bind(info.executionId, run, this))
    this.completion = this.task.then(
      (code) => this.settle(code, null, finished),
      (error: unknown) => {
        const aborted = error instanceof Error && error.name === 'AbortError'
        if (aborted) this.current = Object.freeze({ ...this.current, cancellationRequested: true })
        return this.settle(
          aborted ? 128 + (this.stopSignal ?? 9) : 1,
          aborted ? null : error instanceof Error ? error.message : String(error),
          finished,
        )
      },
    )
  }

  get info(): ProcessInfo {
    return this.current
  }

  /** The signal the runner was stopped with, null while it runs. */
  get signal(): number | null {
    return this.stopSignal
  }

  /**
   * Request cancellation without waiting for the runner to exit.
   *
   * @param signal what the stop stands for, KILL (9) unless a `kill` named another.
   */
  terminate(signal = 9): boolean {
    if (this.current.state === 'exited' || this.current.cancellationRequested) return false
    const previous = this.current
    this.current = Object.freeze({
      ...this.current,
      state: 'stopping',
      cancellationRequested: true,
    })
    this.stopSignal = signal
    try {
      this.cancel(signal)
    } catch (error) {
      this.current = previous
      this.stopSignal = null
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
