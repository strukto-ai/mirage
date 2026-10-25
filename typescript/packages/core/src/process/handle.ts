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
 * The runner starts once `start` is called, so whoever tracks the handle
 * registers it before even a synchronous prelude of the runner runs.
 */
export class ProcessHandle {
  task!: Promise<number>
  private current: ProcessInfo
  private stopSignal: number | null = null
  private exitedCode: number | null = null
  private completion!: Promise<ProcessInfo>

  constructor(
    info: ProcessInfo,
    private readonly run: ProcessRunner,
    private readonly cancel: (signal: number) => void,
    private readonly finished: (pid: number) => void,
    private readonly cancelChildren: (signal: number) => void = () => undefined,
    private readonly bind: ExecutionBind = (_id, run) => run(),
  ) {
    this.current = Object.freeze(info)
  }

  /**
   * Start the runner.
   *
   * @param eager run it at once, up to its first wait, for a caller with
   *   nothing left to set up; otherwise it starts on the next microtask.
   */
  start(eager = false): void {
    const work = () => this.bind(this.current.executionId, this.run, this)
    this.task = eager ? work() : Promise.resolve().then(work)
    this.completion = this.task.then(
      (code) => this.settle(code, null, this.finished),
      (error: unknown) => {
        const aborted = error instanceof Error && error.name === 'AbortError'
        if (aborted) this.current = Object.freeze({ ...this.current, cancellationRequested: true })
        return this.settle(
          aborted ? 128 + (this.stopSignal ?? 9) : 1,
          aborted ? null : error instanceof Error ? error.message : String(error),
          this.finished,
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

  /** The status a program the runner started exited with on its own after the stop signal, null unless one did. */
  get programCode(): number | null {
    return this.exitedCode
  }

  /**
   * Record that a program the runner started handled the stop signal and
   * exited: a job that is that one program reports its status, as bash
   * reports a child that handled the signal.
   *
   * @param code the program's exit status.
   */
  programExited(code: number): void {
    this.exitedCode = code
  }

  /**
   * Request cancellation without waiting for the runner to exit. A runner
   * that already exited has nothing to cancel, but what it started may
   * still run (`sh -c 'sleep 100 &'`), so its children are stopped all the
   * same.
   *
   * @param signal what the stop stands for, KILL (9) unless a `kill` named another.
   */
  terminate(signal = 9): boolean {
    if (this.current.state === 'exited') {
      this.cancelChildren(signal)
      return false
    }
    if (this.current.cancellationRequested) return false
    const previous = this.current
    this.current = Object.freeze({
      ...this.current,
      state: 'stopping',
      cancellationRequested: true,
    })
    this.stopSignal = signal
    try {
      this.cancelChildren(signal)
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
