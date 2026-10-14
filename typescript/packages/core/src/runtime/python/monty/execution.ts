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
import type { RunArgs, RunResult } from '../../types.ts'
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

const INTERRUPTED = Symbol('interrupted')

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

  async run(args: RunArgs, files: RuntimeFiles | null): Promise<RunResult> {
    const pool = await this.ensurePool()
    // A script is Monty's own scriptName, which it keeps the last part of
    // for `__file__`, under the directory a feed starts in.
    const session = await pool.checkout(
      args.scriptPath !== undefined
        ? { scriptName: mainFilename(args), limits: this.limits }
        : { limits: this.limits },
    )
    // Monty executes on its own worker process, so the event loop stays
    // live to observe the limit deadline and the kill signal; a trip
    // SIGKILLs the worker (see killWorker). Deadline -> exit 124 via
    // CommandTimeoutError, kill -> exit 1 like the local runtime.
    const workerPid = session.workerPid
    const interruption = this.installInterruption(args.signal, args.timeoutSeconds)
    try {
      const run = this.feedOne(session, args.code, args, files)
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

  private async feedOne(
    session: MontySessionLike,
    code: string,
    args: RunArgs,
    files: RuntimeFiles | null,
  ): Promise<RunResult> {
    const module = await this.loadModule()
    const out: string[] = []
    const err: string[] = []
    const options: Record<string, unknown> = {
      // argv[0] is the program's own name when the caller has one (a
      // CLI install's head word), else the interpreter's placeholder.
      inputs: { argv: [args.prog ?? DEFAULT_PROG, ...args.args], stdin: args.stdin },
      cwd: args.cwd?.virtual,
      printCallback: (stream: 'stdout' | 'stderr', text: string) => {
        if (stream === 'stderr') err.push(text)
        else out.push(text)
      },
      os: new MontyFs(module, args.env, files).handle,
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
