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

import type { ProcessHandle } from '../process/handle.ts'
import { shownPid } from '../process/types.ts'
import { JobId, type LineId } from '../types.ts'
import type { IOResult } from '../../io/types.ts'
import type { ExecutionNode } from '../../workspace/types.ts'
import {
  Channel,
  JobConsole,
  KILLED_OUTCOME,
  exitOutcome,
  killedOutcome,
} from '../../shell/console/index.ts'
import { encodeText } from '../../shell/bytes.ts'
import { sleep } from '../../utils/abort.ts'
import { SystemClock } from '../../utils/clock.ts'
import { KILLED_EXIT_CODE, WATCH_RETRY_SECONDS } from './constants.ts'
import type { Job, JobState } from './types.ts'

export type JobResult = [IOResult, ExecutionNode]

/** Produces a job's output and its result. */
export type JobRunner = (job: JobHandle) => Promise<JobResult>

/** The status and signal a console's ending records. */
function ending(outcome: string): [number, number | null] {
  const [form = '', code = '0', signal = ''] = outcome.split(':')
  return [Number(code), form === KILLED_OUTCOME ? Number(signal) : null]
}

/** Write the kill marker and the ending chunk. Mirrors Python's `mark_killed`. */
export async function markKilled(
  console: JobConsole,
  exitCode: number,
  signal: number,
): Promise<void> {
  await console.emit(Channel.STDERR, encodeText('Killed'))
  await console.finish(killedOutcome(exitCode, signal))
}

/**
 * One background command as the daemon running or listing it holds it: its
 * runner, its console, and how it ended. `record` is the `Job` every daemon
 * on the store reads.
 *
 * Output lives in `console` rather than in byte fields, so a reader can
 * watch a job while it runs instead of waiting for it to end. A `simple`
 * job is one simple command, which the job is, so a program it ran that
 * handled a `kill` leaves the job its own status. Its `owner` is the daemon
 * that runs it; a job another daemon runs has no `process` here. Its
 * `consoleName` is the name its store keeps the console under, which tells
 * apart two jobs a reused number gave the same id. A `reported` job's shell
 * printed the report of the signal that ended it, so `jobs` and a `%N` no
 * longer name it, and its pid still answers `wait`.
 *
 * A job a `kill` reached is `stopping` until its console ends, the one
 * record of how it ended, which every daemon reads: the first ending
 * written stands, and the handle takes it (`take`).
 */
export class JobHandle {
  id: number
  readonly command: string
  // null for jobs restored from a snapshot (already finished, no runner)
  // and for jobs another workspace runs.
  process: ProcessHandle | null = null
  readonly abort: AbortController | null
  readonly cwd: string
  readonly sessionId: string
  readonly createdAt: number
  console: JobConsole
  readonly simple: boolean
  owner: string
  consoleName: string
  workspaceId: string
  line: LineId | null
  group: number | null
  private readonly now: () => number
  private ended: ((record: Job) => void) | null

  state: JobState = 'running'
  exitCode = 0
  signal: number | null = null
  endedAt: number | null = null
  ending = 0
  private static endings = 0
  reported = false
  /** A `jobs` has shown it, which `jobs -n` leaves out while it goes on running. */
  listed = false

  constructor(init: {
    id: number
    command: string
    abort?: AbortController | null
    cwd: string
    sessionId?: string
    createdAt: number
    state?: JobState
    exitCode?: number
    signal?: number | null
    endedAt?: number | null
    console?: JobConsole
    simple?: boolean
    owner?: string
    consoleName?: string
    workspaceId?: string
    line?: LineId | null
    group?: number | null
    now?: () => number
    ended?: ((record: Job) => void) | null
  }) {
    this.id = init.id
    this.command = init.command
    this.abort = init.abort ?? null
    this.cwd = init.cwd
    this.sessionId = init.sessionId ?? ''
    this.createdAt = init.createdAt
    this.console = init.console ?? new JobConsole()
    this.simple = init.simple ?? false
    this.owner = init.owner ?? ''
    this.consoleName = init.consoleName ?? ''
    this.workspaceId = init.workspaceId ?? ''
    this.line = init.line ?? null
    this.group = init.group ?? null
    const clock = new SystemClock()
    this.now = init.now ?? (() => clock.now())
    this.ended = init.ended ?? null
    if (init.state !== undefined) this.state = init.state
    if (init.exitCode !== undefined) this.exitCode = init.exitCode
    if (init.signal !== undefined) this.signal = init.signal
    if (init.endedAt !== undefined) this.endedAt = init.endedAt
  }

  /** The job as its record reads. */
  get record(): Job {
    return {
      id: new JobId(this.workspaceId, this.consoleName),
      number: this.id,
      sessionId: this.sessionId,
      command: this.command,
      cwd: this.cwd,
      startedAt: this.createdAt,
      line: this.line,
      group: this.group,
      pid: this.process?.record.id.pid ?? null,
      state: this.state,
      endedAt: this.endedAt,
      exit: this.state === 'exited' ? this.exitCode : null,
      signal: this.signal,
    }
  }

  /**
   * The managed PID `$!`, `jobs -p` and `wait -p` report. A job restored
   * from a snapshot or run by another workspace has no runner here, so its
   * job number stands in.
   */
  get pid(): number {
    return this.process?.record.id.pid ?? this.id
  }

  /**
   * The pid the agent sees for it: `$!`, `jobs -l` and `jobs -p`, `wait -p`
   * and the reports of how it ended. Its program's on its machine, else
   * `pid`. A pipeline's is its first stage's. Mirrors Python's `shown_pid`.
   */
  get shownPid(): number {
    if (this.process === null) return this.id
    return shownPid((this.process.stages[0] ?? this.process).record)
  }

  /** The pid `$!` names: a pipeline's last stage, else `shownPid`. */
  get lastPid(): number {
    const last = this.process?.stages.at(-1)
    return last === undefined ? this.shownPid : shownPid(last.record)
  }

  /**
   * The id of the process the job runs as, as text: its runner's here, its
   * console's for a job restored or run elsewhere.
   */
  get processId(): string | null {
    return this.process?.record.id.toString() ?? this.console.process
  }

  /** Take how the job ended from its console's ending. */
  take(outcome: string): void {
    ;[this.exitCode, this.signal] = ending(outcome)
    this.markEnded()
  }

  /** Mark the job ended, now, unless it already was. */
  private markEnded(): void {
    if (this.state === 'exited') return
    this.state = 'exited'
    this.endedAt = this.now()
    this.ending = ++JobHandle.endings
  }

  /**
   * Tell `ended` the job's record once, as it ended; a hook that fails is
   * logged, so the job still ends. Mirrors Python's `_tell_ended`.
   */
  private tellEnded(): void {
    const ended = this.ended
    this.ended = null
    if (ended === null) return
    try {
      ended(this.record)
    } catch (err) {
      console.debug('job ended hook failed:', err)
    }
  }

  /** Ask the job's runner to stop with `signal`, without waiting for it. */
  cancel(signal = 9): void {
    this.process?.terminate(signal)
  }

  /**
   * Stop the job's runner, the job answering as killed by `signal`, its
   * status 128 plus it, while it stops.
   */
  kill(signal: number): void {
    this.cancel(signal)
    this.state = 'stopping'
    this.signal = signal
    this.exitCode = 128 + signal
  }

  /** Stop the job and end it as killed by `signal` at once. */
  async stop(signal = 9): Promise<void> {
    this.cancel(signal)
    await this.end(128 + signal, signal)
  }

  /**
   * End the job's console with how it ended, then take the ending the
   * console holds. Another workspace's `kill`, or the bound on a killed
   * job's stop, may have ended the console first; the store keeps the first
   * ending, and every workspace answers that one. The job's fields are set
   * before the console is finished, so a reader released by the ending
   * chunk always sees them settled. `signal` is null for a job that ran to
   * completion; `marker` writes the `Killed` marker a stop leaves in the
   * output, which a program a signal ended outside a kill leaves out.
   */
  async end(exitCode: number, signal: number | null = null, marker = true): Promise<void> {
    this.exitCode = exitCode
    this.signal = signal
    this.markEnded()
    if (signal === null) await this.console.finish(exitOutcome(exitCode))
    else if (marker) await markKilled(this.console, exitCode, signal)
    else await this.console.finish(killedOutcome(exitCode, signal))
    if (!this.console.store.closed) {
      const outcome = await this.console.outcome()
      if (outcome !== null) this.take(outcome)
    }
    this.tellEnded()
  }

  /**
   * The status and signal a stopped job answers: the status its program
   * exited with after handling the signal, when the job is that one
   * program, else 128 plus the signal, KILL's 137 without one.
   */
  private stopped(): [number, number] {
    const signal = this.process?.signal ?? KILLED_EXIT_CODE - 128
    const code = this.process?.programCode ?? null
    if (this.simple && code !== null) return [code, signal]
    return [128 + signal, signal]
  }

  /**
   * Run the job to completion and record how it ended.
   *
   * A job's console ends here, in the job's own task, once its runner has:
   * `kill` only stops the runner, so a program that handled the signal
   * leaves its own status (`stopped`) in the ending every workspace reads.
   * A job something stopped ends as killed however its runner finished.
   */
  async settle(run: JobRunner): Promise<number> {
    let result: JobResult
    try {
      if (this.abort?.signal.aborted) throw new DOMException('aborted', 'AbortError')
      result = await run(this)
    } catch (err) {
      const aborted =
        (err instanceof Error || err instanceof DOMException) && err.name === 'AbortError'
      if (aborted || this.state !== 'running') {
        await this.end(...this.stopped())
        return aborted ? this.exitCode : 1
      }
      // Recorded as the job's output and exit status rather than
      // rethrown: nobody awaits this task, so rethrowing would only
      // strand the error in an unhandled rejection.
      const msg = err instanceof Error ? err.message : String(err)
      await this.console.emit(Channel.STDERR, encodeText(msg))
      await this.end(1)
      return 1
    }
    const [ioResult] = result
    const code = ioResult.exitCode
    const ended = this.process?.endedOn ?? null
    if (this.state !== 'running') await this.end(...this.stopped())
    else if (ended !== null && code === 128 + ended) await this.end(code, ended, false)
    else await this.end(code)
    return code
  }

  /**
   * Stop the job's runner if another workspace ended its console. A `kill`
   * elsewhere ends the job's console, the one record of how the job ended,
   * and this stops the runner the way a local kill does, with the signal
   * the ending records.
   */
  async adoptEnding(): Promise<void> {
    if (this.state !== 'running') return
    const outcome = await this.console.outcome()
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the runner may settle it across the await
    if (outcome === null || this.state !== 'running') return
    this.take(outcome)
    this.cancel(this.signal ?? 9)
  }

  /**
   * Stop the job's runner once another workspace ends it. A failed read is
   * retried until the runner settles, which aborts the watch: one that gave
   * up would leave a kill from elsewhere unheeded while the job ran on.
   *
   * @param signal aborted once its runner settles, ending the watch
   */
  async watch(signal: AbortSignal): Promise<void> {
    const store = this.console.store
    while (!signal.aborted && !store.closed) {
      try {
        await store.waitEnded(signal)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the runner may settle across the await
        if (!signal.aborted) await this.adoptEnding()
        return
      } catch (err) {
        console.debug('job watch failed:', err)
      }
      await sleep(WATCH_RETRY_SECONDS * 1000, signal)
    }
  }
}
