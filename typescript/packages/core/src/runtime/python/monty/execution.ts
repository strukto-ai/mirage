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

import { CommandTimeoutError } from '../../../errors/types.ts'
import { mainFilename } from '../execution.ts'
import type { Context } from '../../../commands/config.ts'
import { materialize } from '../../../io/types.ts'
import type { OutputFn, Program, RunResult } from '../../types.ts'
import {
  loadMontyModule,
  type MontyModuleLike,
  type MontyPoolLike,
  type MontySessionLike,
} from './loader.ts'
import { DEFAULT_PROG, LIMITS } from './constants.ts'
import { displayError } from './errors.ts'
import { MontyFs } from './fs.ts'
import type { RuntimeFiles } from '../../files.ts'
import { concat } from '../../../utils/bytes.ts'

const INTERRUPTED = Symbol('interrupted')
const ENC = new TextEncoder()

type Stream = 'stdout' | 'stderr'

interface RunInterruption {
  promise: Promise<typeof INTERRUPTED>
  timedOut: { value: boolean }
  dispose: () => void
}

/**
 * Hard-stop one monty worker. The engine offers no cancel: feedRun
 * has no signal and session.close() waits for the in-flight turn
 * (probed live), so the only way to stop a busy guest is to kill its
 * worker process — which poisons the session (the pool discards and
 * replaces the worker) and settles the pending feedRun. The pid is
 * only readable while the session is idle, so callers capture it
 * before feeding. Python's runtime does the same reclaim: cancelling
 * a feed leaves the worker running, so its `_kill_worker` SIGKILLs it
 * on cancellation exactly like this.
 */
function killWorker(pid: number | undefined): void {
  if (pid === undefined) return
  const proc = (globalThis as { process?: { kill?: (pid: number, signal?: string) => void } })
    .process
  if (typeof proc?.kill !== 'function') return
  try {
    proc.kill(pid, 'SIGKILL')
  } catch {
    // the worker may already have exited; nothing left to reclaim
  }
}

export class MontyExecution {
  private readonly name = 'monty'
  private readonly limits: typeof LIMITS & { maxMemory?: number }
  private module: MontyModuleLike | null = null
  private pool: MontyPoolLike | null = null
  private poolPromise: Promise<MontyPoolLike> | null = null

  /**
   * Args:
   *   maxMemory: the heap one run may use, in bytes; null for no cap.
   */
  constructor(maxMemory: number | null = null) {
    this.limits = maxMemory === null ? LIMITS : { ...LIMITS, maxMemory }
  }

  /**
   * Run one program on a pooled worker.
   *
   * @param program the source and argv to run.
   * @param ctx the run's context: working directory, environment, signal
   *   and limit.
   * @param files the run's file adapter; null outside a workspace.
   * @param output receives stdout as it is printed; absent returns it in
   *   the result.
   * @param errors the same for stderr.
   * @param externalLookup the host functions the program may call by name.
   */
  async run(
    program: Program,
    ctx: Context,
    files: RuntimeFiles | null,
    output?: OutputFn,
    errors?: OutputFn,
    externalLookup: Readonly<Record<string, (...args: never[]) => unknown>> = {},
  ): Promise<RunResult> {
    // A script is Monty's own script_name, which it keeps the last part of
    // for `__file__`, under the directory a feed starts in.
    const session = await this.checkout(
      program.scriptPath === undefined ? undefined : mainFilename(program, ctx.cwd),
    )
    // Monty executes on its own worker process, so the event loop stays
    // live to observe the limit deadline and the kill signal; a trip
    // SIGKILLs the worker (see killWorker). Deadline -> exit 124 via
    // CommandTimeoutError, kill -> exit 1 like the local runtime.
    const workerPid = session.workerPid
    const interruption = this.installInterruption(ctx.signal, ctx.timeoutSeconds)
    const prints = new Prints(output, errors)
    try {
      // The prints are handed on inside the race, so a deadline or a kill
      // still stops a run whose reader holds its last writes back.
      const run = this.feedOne(session, program, ctx, files, prints, externalLookup).then(
        async (outcome) => {
          await prints.end()
          return outcome
        },
      )
      const winner = await Promise.race([run, interruption.promise])
      if (winner !== INTERRUPTED) {
        const [exitCode, note] = winner
        const [stdout, stderr] = prints.streams()
        return {
          stdout,
          stderr: note === '' ? stderr : concat([stderr ?? new Uint8Array(), ENC.encode(note)]),
          exitCode,
        }
      }
      prints.stop()
      run.catch(() => undefined)
      killWorker(workerPid)
      if (interruption.timedOut.value && ctx.timeoutSeconds !== undefined) {
        throw new CommandTimeoutError(this.name, ctx.timeoutSeconds)
      }
      return { stdout: new Uint8Array(), stderr: null, exitCode: 1 }
    } finally {
      interruption.dispose()
      await session.close()
    }
  }

  private installInterruption(
    signal: AbortSignal | undefined,
    timeoutSeconds: number | undefined,
  ): RunInterruption {
    const timedOut = { value: false }
    let timer: ReturnType<typeof setTimeout> | null = null
    let removeAbort: (() => void) | null = null
    const promise = new Promise<typeof INTERRUPTED>((resolve) => {
      if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
        timer = setTimeout(() => {
          timedOut.value = true
          resolve(INTERRUPTED)
        }, timeoutSeconds * 1000)
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          resolve(INTERRUPTED)
          return
        }
        const onAbort = (): void => {
          resolve(INTERRUPTED)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbort = () => {
          signal.removeEventListener('abort', onAbort)
        }
      }
    })
    return {
      promise,
      timedOut,
      dispose: () => {
        if (timer !== null) clearTimeout(timer)
        if (removeAbort !== null) removeAbort()
      },
    }
  }

  async close(): Promise<void> {
    // A pool still being opened must be awaited before teardown, or its
    // workers outlive the runtime that asked for them. One that fails to
    // open has nothing to close; the command that asked already reported it.
    if (this.pool === null && this.poolPromise !== null) {
      try {
        this.pool = await this.poolPromise
      } catch (err) {
        console.debug('monty: the pool being opened at close failed', err)
      }
    }
    this.poolPromise = null
    if (this.pool !== null) {
      await this.pool.close()
      this.pool = null
    }
  }

  private async ensurePool(): Promise<MontyPoolLike> {
    if (this.pool !== null) return this.pool
    const opening = (this.poolPromise ??= this.loadPool())
    try {
      this.pool = await opening
    } catch (err) {
      if (this.poolPromise === opening) this.poolPromise = null
      throw err
    }
    return this.pool
  }

  private async loadPool(): Promise<MontyPoolLike> {
    const module = await this.loadModule()
    return module.Monty.create()
  }

  private async loadModule(): Promise<MontyModuleLike> {
    this.module ??= await loadMontyModule()
    return this.module
  }

  private async checkout(scriptName?: string | null): Promise<MontySessionLike> {
    const pool = await this.ensurePool()
    return pool.checkout({
      ...(scriptName === undefined ? {} : { scriptName }),
      limits: this.limits,
      assertMessageAnnotations: false,
      osPolicy: { sleepSystemMax: Infinity },
    })
  }

  /** Feed the program to a worker; its status and what to add to its stderr. */
  private async feedOne(
    session: MontySessionLike,
    program: Program,
    ctx: Context,
    files: RuntimeFiles | null,
    prints: Prints,
    externalLookup: Readonly<Record<string, (...args: never[]) => unknown>>,
  ): Promise<[number, string]> {
    const module = await this.loadModule()
    // Monty has no `sys.stdin`, so piped bytes ride in as a global the
    // same way argv does: raw bytes, null when nothing was piped.
    const stdin = program.stdin === null ? null : await materialize(program.stdin)
    const options: Record<string, unknown> = {
      // argv[0] is the program's own name when the caller has one (a
      // CLI install's head word), else the interpreter's placeholder.
      // `??`, not `||`: "" is CPython's own argv[0] for a program piped in
      // with no operand, so an empty prog is an answer.
      inputs: { argv: [program.prog ?? DEFAULT_PROG, ...program.args], stdin },
      cwd: ctx.cwd.virtual,
      printCallback: prints.write,
      os: new MontyFs(module, ctx.env ?? {}, files).handle,
      ...(Object.keys(externalLookup).length > 0 ? { externalLookup: { ...externalLookup } } : {}),
    }
    try {
      await session.feedRun(program.code, options)
    } catch (caught) {
      if (caught instanceof module.MontySyntaxError || caught instanceof module.MontyRuntimeError) {
        const inner = (caught as { exception?: { typeName: string; message: string } }).exception
        if (inner?.typeName === 'SystemExit') {
          return inner.message ? [1, inner.message + '\n'] : [0, '']
        }
        return [1, displayError(caught) + '\n']
      }
      if (caught instanceof module.MontyCrashedError) {
        return [1, `${this.name}: worker ${caught.timedOut ? 'timed out' : 'crashed'}\n`]
      }
      throw caught
    }
    return [0, '']
  }
}

/**
 * What a program prints, in the order it printed it: each write handed to
 * its stream's sink as it comes, or kept for the result where the stream
 * has none.
 *
 * Monty calls back without waiting, so a write for a sink is chained
 * behind the one before it; the first that fails stops the rest, and
 * `end` reports it.
 */
class Prints {
  private readonly sinks: Record<Stream, OutputFn | undefined>
  private readonly kept: Record<Stream, string[]> = { stdout: [], stderr: [] }
  private writing: Promise<void> = Promise.resolve()
  private failure: { error: unknown } | null = null
  private stopped = false

  /**
   * @param output where stdout goes; absent keeps it.
   * @param errors where stderr goes; absent keeps it.
   */
  constructor(output?: OutputFn, errors?: OutputFn) {
    this.sinks = { stdout: output, stderr: errors }
  }

  readonly write = (stream: Stream, text: string): void => {
    const sink = this.sinks[stream]
    if (sink === undefined) {
      this.kept[stream].push(text)
      return
    }
    this.writing = this.writing
      .then(() => (this.failure === null && !this.stopped ? sink(ENC.encode(text)) : undefined))
      .catch((error: unknown) => {
        this.failure ??= { error }
      })
  }

  /** Skip the writes still queued once the run is interrupted. */
  stop(): void {
    this.stopped = true
  }

  /** Wait until every write has been handed on. */
  async end(): Promise<void> {
    await this.writing
    if (this.failure !== null) throw this.failure.error
  }

  /** The stdout and stderr kept for the result, null for no stderr. */
  streams(): [Uint8Array, Uint8Array | null] {
    const err = this.kept.stderr
    return [ENC.encode(this.kept.stdout.join('')), err.length > 0 ? ENC.encode(err.join('')) : null]
  }
}
