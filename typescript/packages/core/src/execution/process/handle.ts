import { isAborting } from '../../errors/fs.ts'
import type { MachineId, MachinePid } from '../types.ts'
import { settledWithin, SignalStop } from '../../utils/abort.ts'
import { SIGTERM } from '../../shell/constants.ts'
import { NEVER_TAKEN } from './constants.ts'
import type { Process, ProcessRunner } from './types.ts'

/**
 * Runs a runner as the process it is, so what it records names it. The
 * workspace hands over the caller's binder: the process layer sits below
 * the session the caller carries, so it cannot import it.
 */
export type ExecutionBind = <T>(run: () => Promise<T>, process: ProcessHandle) => Promise<T>

/** A wait another caller ends. */
export interface PauseGate {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

/** A gate nothing has ended yet. */
export function newPauseGate(): PauseGate {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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
  /** Whether the runner has started running. */
  begun = false
  /**
   * The host stopped it (its table stopped, its session closed), which ends
   * whoever waits for it as well.
   */
  revoked = false
  /**
   * Started for exactly one command, whose program, should it run on a
   * runtime of its own, runs as this process (`take`).
   */
  oneCommand = false
  // It belongs to a background job, so nothing waits on it unless something
  // asks to.
  background = false
  // What a `kill -STOP` holds, its table's, by pid: each entry is resolved
  // at the `kill -CONT`.
  pauses = new Map<number, PauseGate>()
  private readonly holds = new Map<(held: boolean) => void, boolean>()
  private taker: ((signal: number) => void) | null = null
  private expired: number | null = null
  /**
   * What the program that takes it (`take`) ignores as well: a job's INT and
   * QUIT, never what only a shell ignores.
   */
  programIgnores: ReadonlySet<number> = new Set()
  /** Told the record each time it changes, as its table keeps it. */
  noted: ((record: Process) => void) | null = null
  private current: Process
  private stopSignal: number | null = null
  private stopped = false
  private exitedCode: number | null = null
  private programSignal: number | null = null
  // The programs `program` runs, each with the signal `interrupt` sent it.
  private readonly programs = new Map<AbortController, number | null>()
  private readonly takes = new Map<AbortController, ReadonlySet<number> | null>()
  private completion!: Promise<Process>
  // Resolved once `$!` can name it: its program's pid is known, or it ended.
  private readonly isPlaced = newPauseGate()
  // It runs a pipeline (`cmd | cmd &`), whose stages are the job.
  pipeline = false
  stages: readonly ProcessHandle[] = []

  constructor(
    record: Process,
    private readonly run: ProcessRunner,
    private readonly cancel: (signal: number) => void,
    private readonly finished: (pid: number) => void,
    private readonly cancelChildren: (signal: number) => void = () => undefined,
    private readonly bind: ExecutionBind = (run) => run(),
    public ignores: ReadonlySet<number> = new Set(),
    private readonly now: () => number = () => Date.now() / 1000,
  ) {
    this.current = Object.freeze(record)
  }

  /**
   * Start the runner.
   *
   * @param eager run it at once, up to its first wait, for a caller with
   *   nothing left to set up; otherwise it starts on the next microtask.
   *   Either way a runner that throws before it returns its promise fails
   *   as one whose promise rejects.
   */
  start(eager = false): void {
    const work = () => {
      this.begun = true
      return this.bind(this.run, this)
    }
    this.task = eager ? (async () => work())() : Promise.resolve().then(work)
    this.completion = this.task.then(
      (code) => this.settle(code, null, this.finished),
      (error: unknown) => {
        const aborted = error instanceof Error && error.name === 'AbortError'
        this.stopped = aborted
        return this.settle(
          aborted ? 128 + (this.stopSignal ?? 9) : 1,
          aborted ? null : error instanceof Error ? error.message : String(error),
          this.finished,
        )
      },
    )
  }

  get record(): Process {
    return this.current
  }

  /** The signal the runner was stopped with, null while it runs. */
  get signal(): number | null {
    return this.stopSignal
  }

  /**
   * The signal that ended the runner, null while it runs or once it exited
   * on its own (a trap that handled the signal): the one it was stopped with,
   * or the one that ended the native program its status is
   * (`programSignaled`). Mirrors Python's ended_by.
   */
  get endedBy(): number | null {
    if (this.stopped) return this.stopSignal ?? 9
    const ended = this.programSignal
    return ended !== null && this.current.exit === 128 + ended ? ended : null
  }

  /** The signal `interrupt` stops the program the runner runs right now with, null while none is stopping. */
  get interrupted(): number | null {
    for (const sent of this.programs.values()) if (sent !== null) return sent
    return this.expired
  }

  /** The status a program the runner started exited with on its own after the stop signal, null unless one did. */
  get programCode(): number | null {
    return this.exitedCode
  }

  /** The signal the native program the runner last started ended on (`programSignaled`), null once one exited on its own. */
  get endedOn(): number | null {
    return this.programSignal
  }

  /**
   * Take the runner as the program it was started for (`oneCommand`),
   * which runs on `machine` with `runtime`, as bash execs a stage's or a
   * job's one program in place. Its record names both from then on, and it
   * ignores only what the program does (`programIgnores`). Answers whether the runner was the program's to take: false for one
   * started for more than one command, or taken already.
   *
   * @param machine where the program runs; null for the workspace's own.
   * @param runtime what runs it.
   */
  take(machine: MachineId | null, runtime: string): boolean {
    if (!this.oneCommand) return false
    this.oneCommand = false
    this.ignores = this.programIgnores
    this.current = Object.freeze({
      ...this.current,
      machine: machine ?? this.current.machine,
      runtime,
    })
    this.tell()
    return true
  }

  /**
   * Record the pid of the native program the runner is, on its machine,
   * which a workspace that outlives this one stops it by.
   */
  setMachinePid(machinePid: MachinePid): void {
    this.current = Object.freeze({ ...this.current, machinePid })
    this.tell()
    this.isPlaced.resolve()
  }

  /**
   * Note the stages of the pipeline this job runs, which `$!` and `jobs -l`
   * name. Mirrors Python's `set_stages`.
   *
   * @param stages the stages, in order.
   */
  setStages(stages: readonly ProcessHandle[]): void {
    this.stages = stages
    this.current = Object.freeze({
      ...this.current,
      stages: stages.map((stage) => stage.record.id.pid),
    })
    this.isPlaced.resolve()
  }

  /**
   * Note what a scan found the program doing, or that a `kill` paused it,
   * which is `ps`'s to show and no store's to keep.
   *
   * @param state its state letter; null for none known.
   */
  showState(state: string | null): void {
    this.current = Object.freeze({ ...this.current, shownState: state })
  }

  /** Whether a `kill -STOP` holds this process or one above it. */
  get paused(): boolean {
    return this.heldBy() !== null
  }

  private heldBy(): PauseGate | null {
    if (this.pauses.size === 0) return null
    const { id, ancestors } = this.current
    for (const pid of [id.pid, ...ancestors]) {
      const held = this.pauses.get(pid)
      if (held !== undefined) return held
    }
    return null
  }

  /**
   * Tell a program that goes on between the calls it makes to Mirage, and has
   * a way of its own to stop, when a `kill -STOP` holds this process. One
   * already held is told at once. Answers what forgets `hold`, letting a
   * program still held go. Mirrors Python's `on_hold`.
   *
   * @param hold told true as the process is held and false as it goes on.
   */
  onHold(hold: (held: boolean) => void): () => void {
    this.holds.set(hold, false)
    this.tellHeld()
    return () => {
      const told = this.holds.get(hold) === true
      this.holds.delete(hold)
      if (told) hold(false)
    }
  }

  /**
   * Have a program that acts on signals itself take what is sent to this
   * runner, which goes on or ends as the program decides. Only a runner
   * started for that one command is the program's: another's signals are the
   * shell's. KILL and STOP are never the program's. Answers what ends it.
   *
   * @param take told each signal sent.
   */
  onSignal(take: (signal: number) => void): () => void {
    if (!this.oneCommand) return () => undefined
    this.taker = take
    return () => {
      this.taker = null
    }
  }

  /**
   * Hand a signal to the program that takes them (`onSignal`). Answers
   * whether one took it.
   *
   * @param signal the signal.
   */
  takeSignal(signal: number): boolean {
    if (this.taker === null || NEVER_TAKEN.has(signal)) return false
    this.taker(signal)
    return true
  }

  /** Whether a program that acts on signals itself is taking them (`onSignal`). */
  get takesSignals(): boolean {
    return this.taker !== null
  }

  /** Tell each program waiting to hear (`onHold`) whether this process is held now. */
  tellHeld(): void {
    const held = this.paused
    for (const [hold, told] of this.holds) {
      if (told === held) continue
      this.holds.set(hold, held)
      hold(held)
    }
  }

  /**
   * Note that a deadline (`@line`) is past: what the runner runs takes TERM
   * as a `kill` would have it send, with a program's grace to finish
   * (`interrupted`), and a `kill -STOP` no longer holds it. The runner's own
   * status stays the deadline's. Mirrors Python's `expire`.
   */
  expire(): void {
    this.expired = SIGTERM
    const pid = this.current.id.pid
    const held = this.pauses.get(pid)
    this.pauses.delete(pid)
    held?.resolve()
    this.tellHeld()
  }

  /** Wait out a `kill -STOP` of this process or one above it. */
  async resumed(): Promise<void> {
    for (let held = this.heldBy(); held !== null; held = this.heldBy()) await held.promise
  }

  /**
   * Wait until `$!` can name the program this runs: its pid on its machine
   * is known or it has ended, for at most `seconds`.
   */
  async placed(seconds: number): Promise<void> {
    await settledWithin(this.isPlaced.promise, seconds)
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
   * Record that a native program the runner started ended on a signal, which
   * names the runner's end when its status is that program's (`true | python3
   * -c 'os.kill(os.getpid(), 9)'`). Every statement the runner starts clears
   * it, so only the last one's end counts. Mirrors Python's program_signaled.
   *
   * @param signal the signal that ended the program; null as a statement
   *   starts.
   */
  programSignaled(signal: number | null): void {
    this.programSignal = signal
  }

  /**
   * Run one program of the runner's shell where `interrupt` reaches it, as
   * bash's background job runs each program as a child that takes the INT
   * the job itself ignores. The program stops when the signal it is handed
   * aborts. `takes` are the signals that stop it, every one when null.
   * Resolves to what it returned, or the signal `interrupt` stopped it with.
   * Mirrors Python's program.
   */
  async program<T>(
    run: (stop: AbortSignal) => Promise<T>,
    takes: ReadonlySet<number> | null = null,
  ): Promise<[T, null] | [null, number]> {
    const stop = new AbortController()
    this.programs.set(stop, null)
    this.takes.set(stop, takes)
    try {
      return [await run(stop.signal), null]
    } catch (error) {
      const signal = this.programs.get(stop) ?? null
      if (signal === null || !isAborting(error)) throw error
      return [null, signal]
    } finally {
      this.programs.delete(stop)
      this.takes.delete(stop)
    }
  }

  /**
   * Deliver a signal the runner's shell ignores, as bash's background job
   * ignores INT: the program it runs right now (`program`) gets it, and the
   * shell goes on.
   */
  interrupt(signal: number): void {
    for (const [stop, sent] of this.programs) {
      const takes = this.takes.get(stop) ?? null
      if (sent !== null || (takes !== null && !takes.has(signal))) continue
      this.programs.set(stop, signal)
      stop.abort(new SignalStop(signal))
    }
  }

  /**
   * Request cancellation without waiting for the runner to exit. A runner
   * that already exited has nothing to cancel, but what it started may
   * still run (`sh -c 'sleep 100 &'`), so its children are stopped all the
   * same. A KILL while the runner still stops under another signal cuts the
   * grace that signal gave its program short, as a second `kill -KILL` does.
   * A signal the runner ignores (`ignores`) does nothing.
   *
   * @param signal what the stop stands for, KILL (9) unless a `kill` named another.
   * @param children stop what the runner started too; false leaves its jobs
   *   running, for a signal they ignore.
   */
  terminate(signal = 9, children = true): boolean {
    if (this.ignores.has(signal)) return false
    if (this.current.state === 'exited') {
      if (children) this.cancelChildren(signal)
      return false
    }
    if (this.current.state === 'stopping') {
      if (signal !== 9 || this.stopSignal === 9) return false
      this.stopSignal = signal
      if (children) this.cancelChildren(signal)
      return true
    }
    const previous = this.current
    this.current = Object.freeze({ ...this.current, state: 'stopping' })
    this.stopSignal = signal
    try {
      if (children) this.cancelChildren(signal)
      this.cancel(signal)
    } catch (error) {
      this.current = previous
      this.stopSignal = null
      throw error
    }
    this.tell()
    return true
  }

  private settle(code: number, error: string | null, finished: (pid: number) => void): Process {
    const stop = this.stopSignal
    const ended = this.programSignal
    const signal = this.stopped
      ? (stop ?? 9)
      : stop !== null && code === 128 + stop
        ? stop
        : ended !== null && code === 128 + ended
          ? ended
          : null
    this.current = Object.freeze({
      ...this.current,
      state: 'exited',
      endedAt: this.now(),
      exit: code,
      signal,
      error,
    })
    this.tell()
    this.isPlaced.resolve()
    finished(this.current.id.pid)
    return this.current
  }

  /** Tell whoever keeps the record that it changed. */
  private tell(): void {
    this.noted?.(this.current)
  }

  join(): Promise<Process> {
    return this.completion
  }

  /**
   * Wait for the runner from the shell that forked it, as wait(2) does: its
   * exit status, 128 plus the signal that stopped it. A stop of the waiting
   * shell itself (`waiter`) stops the runner with it, and a runner the host
   * stopped (`revoked`) ends the wait with its error. Mirrors Python's reap.
   *
   * @param waiter the waiting shell's abort signal.
   */
  async reap(waiter: AbortSignal | null = null): Promise<number> {
    try {
      return await this.task
    } catch (error) {
      if (this.revoked || waiter?.aborted === true || !isAborting(error)) throw error
      return 128 + (this.stopSignal ?? 9)
    }
  }
}
