import { GuestProcesses } from '../../../process/bridge.ts'
import type { ProcessView } from '../../../process/types.ts'
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

import { CommandTimeoutError } from '../../../commands/errors.ts'
import { EvalError } from '../../errors.ts'
import type { EvalResult, EvalValue, RunArgs, RunResult } from '../../types.ts'
import type { PathSpec } from '../../../types.ts'
import {
  loadMontyModule,
  type MontyModuleLike,
  type MontyPoolLike,
  type MontySessionLike,
} from './binding.ts'
import { DEFAULT_PROG, EVAL_INTERRUPT_SECONDS, INCOMPLETE_MARKERS } from './constants.ts'
import { displayError } from './errors.ts'
import { MirageOSAccess } from './osaccess.ts'
import type { MontyVFS } from './vfs.ts'

const INTERRUPTED = Symbol('interrupted')

interface RunInterruption {
  promise: Promise<typeof INTERRUPTED>
  timedOut: { value: boolean }
  dispose: () => void
}

/**
 * Hard-stop one monty worker. The binding offers no cancel: feedRun
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

/**
 * Fold Monty's value shapes into the EvalValue contract: the worker
 * hands python dicts back as Map, but EvalValue promises str-keyed
 * plain objects (what pyodide's JSON transport already yields).
 */
function toEvalValue(value: unknown): EvalValue {
  if (value instanceof Map) {
    const obj: Record<string, EvalValue> = {}
    for (const [key, entry] of value) obj[String(key)] = toEvalValue(entry)
    return obj
  }
  if (Array.isArray(value)) return value.map(toEvalValue)
  return value as EvalValue
}

export class MontyExecution {
  private readonly name = 'monty'
  private module: MontyModuleLike | null = null
  private pool: MontyPoolLike | null = null
  private poolPromise: Promise<MontyPoolLike> | null = null
  private readonly evalSessions = new Map<string, MontySessionLike>()

  async run(
    args: RunArgs,
    vfs: MontyVFS | null,
    processes: ProcessView | null = null,
  ): Promise<RunResult> {
    const pool = await this.ensurePool()
    const session = await pool.checkout()
    // Monty executes on its own worker process, so the event loop stays
    // live to observe the limit deadline and the kill signal; a trip
    // SIGKILLs the worker (see killWorker). Deadline -> exit 124 via
    // CommandTimeoutError, kill -> exit 1 like the local runtime.
    const workerPid = session.workerPid
    const interruption = this.installInterruption(args.signal, args.timeoutSeconds)
    try {
      const run = this.feedOne(session, args.code, args, vfs, processes)
      const winner = await Promise.race([run, interruption.promise])
      if (winner !== INTERRUPTED) return winner
      run.catch(() => undefined)
      killWorker(workerPid)
      if (interruption.timedOut.value && args.timeoutSeconds !== undefined) {
        throw new CommandTimeoutError(this.name, args.timeoutSeconds)
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

  /**
   * Evaluate code in-process; the last expression is the value.
   *
   * One-shot mode evaluates on a throwaway pool session; a session id
   * keeps the session (heap and namespace) alive per id, which is the
   * console. Inputs bind as globals via monty's native mechanism, and
   * the code sees workspace files through the same bridge agent code
   * uses. Console failures come back as transcript results (stderr +
   * exitCode 1); one-shot failures reject with EvalError.
   */
  async eval(
    code: string,
    vfs: MontyVFS | null,
    opts: { inputs?: Record<string, EvalValue>; session?: string; cwd?: PathSpec } = {},
  ): Promise<EvalResult> {
    const pool = await this.ensurePool()
    const module = await this.loadModule()
    const fresh = opts.session === undefined || !this.evalSessions.has(opts.session)
    let session: MontySessionLike
    if (opts.session !== undefined) {
      let existing = this.evalSessions.get(opts.session)
      if (existing === undefined) {
        existing = await pool.checkout()
        this.evalSessions.set(opts.session, existing)
      }
      session = existing
    } else {
      session = await pool.checkout()
    }
    const out: string[] = []
    const err: string[] = []
    const options: Record<string, unknown> = {
      inputs: { ...(opts.inputs ?? {}) },
      cwd: fresh ? opts.cwd?.virtual : undefined,
      printCallback: (stream: 'stdout' | 'stderr', text: string) => {
        if (stream === 'stderr') err.push(text)
        else out.push(text)
      },
      os: new MirageOSAccess(module, {}, vfs).handle,
    }
    const enc = new TextEncoder()
    // One-shot evals get the quickjs-style 10s bound (the policy layer
    // above times out but cannot stop the worker; SIGKILLing it does).
    // Console sessions stay unbounded, matching python where
    // cancellation is ambient.
    const workerPid = session.workerPid
    const interruption =
      opts.session === undefined
        ? this.installInterruption(undefined, EVAL_INTERRUPT_SECONDS)
        : null
    try {
      const fed = session.feedRun(code, options)
      const winner =
        interruption !== null ? await Promise.race([fed, interruption.promise]) : await fed
      if (winner === INTERRUPTED) {
        fed.catch(() => undefined)
        killWorker(workerPid)
        throw new EvalError(`monty eval timed out after ${String(EVAL_INTERRUPT_SECONDS)}s`)
      }
      const value = toEvalValue(winner)
      return {
        value,
        stdout: enc.encode(out.join('')),
        stderr: err.length > 0 ? enc.encode(err.join('')) : null,
        exitCode: 0,
        status: 'complete',
      }
    } catch (caught) {
      if (caught instanceof module.MontySyntaxError) {
        const trace = displayError(caught)
        // Console continuation, not a broken program: the source
        // merely stopped early (an open block or unclosed suite).
        const incomplete = INCOMPLETE_MARKERS.some((marker) => trace.includes(marker))
        if (opts.session !== undefined) {
          if (incomplete) {
            return {
              value: null,
              stdout: new Uint8Array(),
              stderr: null,
              exitCode: 0,
              status: 'incomplete',
            }
          }
          return {
            value: null,
            stdout: enc.encode(out.join('')),
            stderr: enc.encode(trace + '\n'),
            exitCode: 1,
            status: 'complete',
          }
        }
        throw new EvalError(trace, { syntax: true, cause: caught })
      }
      if (caught instanceof module.MontyRuntimeError) {
        const trace = displayError(caught)
        if (opts.session !== undefined) {
          return {
            value: null,
            stdout: enc.encode(out.join('')),
            stderr: enc.encode(err.join('') + trace + '\n'),
            exitCode: 1,
            status: 'complete',
          }
        }
        throw new EvalError(trace, { cause: caught })
      }
      throw caught
    } finally {
      interruption?.dispose()
      if (opts.session === undefined) await session.close()
    }
  }

  async close(): Promise<void> {
    for (const session of this.evalSessions.values()) {
      await session.close()
    }
    this.evalSessions.clear()
    if (this.pool !== null) {
      await this.pool.close()
      this.pool = null
    }
    this.poolPromise = null
  }

  private async ensurePool(): Promise<MontyPoolLike> {
    if (this.pool !== null) return this.pool
    this.poolPromise ??= this.loadPool()
    this.pool = await this.poolPromise
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

  private async feedOne(
    session: MontySessionLike,
    code: string,
    args: RunArgs,
    vfs: MontyVFS | null,
    processes: ProcessView | null,
  ): Promise<RunResult> {
    const module = await this.loadModule()
    const out: string[] = []
    const err: string[] = []
    const options: Record<string, unknown> = {
      // argv[0] is the program's own name when the caller has one (a
      // CLI install's head word), else the interpreter's placeholder.
      externalLookup: {
        mirage_run: (argv: string[], input?: string, cwd?: string) =>
          new GuestProcesses(processes).run(argv, input, cwd),
      },
      inputs: { argv: [args.prog ?? DEFAULT_PROG, ...args.args], stdin: args.stdin },
      cwd: args.cwd?.virtual,
      printCallback: (stream: 'stdout' | 'stderr', text: string) => {
        if (stream === 'stderr') err.push(text)
        else out.push(text)
      },
      os: new MirageOSAccess(module, args.env, vfs).handle,
    }
    try {
      await session.feedRun(code, options)
    } catch (caught) {
      if (caught instanceof module.MontySyntaxError || caught instanceof module.MontyRuntimeError) {
        err.push(displayError(caught) + '\n')
        return {
          stdout: new TextEncoder().encode(out.join('')),
          stderr: err.length > 0 ? new TextEncoder().encode(err.join('')) : null,
          exitCode: 1,
        }
      }
      // A dead worker (hard crash, or the pool's own watchdog) is a
      // failed command, not a broken host: exit 1 with a note, prior
      // stdout kept, mirroring python's MontyCrashedError handler.
      // eval() deliberately does not map this — python's eval lets it
      // propagate too.
      if (caught instanceof module.MontyCrashedError) {
        err.push(`${this.name}: worker ${caught.timedOut ? 'timed out' : 'crashed'}\n`)
        return {
          stdout: new TextEncoder().encode(out.join('')),
          stderr: new TextEncoder().encode(err.join('')),
          exitCode: 1,
        }
      }
      throw caught
    }
    return {
      stdout: new TextEncoder().encode(out.join('')),
      stderr: err.length > 0 ? new TextEncoder().encode(err.join('')) : null,
      exitCode: 0,
    }
  }
}
