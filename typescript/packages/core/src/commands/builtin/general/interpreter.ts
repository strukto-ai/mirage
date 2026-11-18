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

import { currentCaller, withCaller } from '../../../context/session_context.ts'
import { chunks } from '../../../io/cooperative.ts'
import { checkMemory } from '../../../io/memory.ts'
import { BytePipe } from '../../../io/pipe.ts'
import { PipeClosed } from '../../../io/errors.ts'
import { OutputStream, closeQuietly } from '../../../io/stream.ts'
import { IOResult, OutputState, materialize, type ByteSource } from '../../../io/types.ts'
import type { LanguageRuntime } from '../../../runtime/language.ts'
import { QuickJsUnavailableError } from '../../../runtime/js/quickjs/errors.ts'
import { MontyUnavailableError } from '../../../runtime/python/monty/errors.ts'
import { PyodideUnavailableError } from '../../../runtime/python/pyodide/errors.ts'
import type { CommandRuntime, OutputFn, RunResult } from '../../../runtime/types.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { Channel, JobConsole } from '../../../shell/console/index.ts'
import { STOP_WAIT_SECONDS } from '../../../execution/job/constants.ts'
import type { PathSpec, Producer } from '../../../types.ts'
import { errorVirtualPath, isFsError } from '../../../errors/fs.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { ABORT_JOIN_MS, hasAborted, runCancellable, mergeSignals } from '../../../utils/abort.ts'
import { concat } from '../../../utils/bytes.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import {
  CANNOT_EXECUTE_STATUS,
  NOT_FOUND_STATUS,
  SIGPIPE_STATUS,
} from '../../../shell/constants.ts'

/**
 * A runtime run as a command's output, handed over as it runs.
 *
 * The one push-to-pull bridge from a run to a command's output shape: the
 * interpreter commands, a script CLI, a program a runtime captured and a
 * whole line all answer through here. The run starts when its output is
 * first read and writes stdout into a bounded pipe, so a reader that falls
 * behind holds the program back and the output is never held whole. A read
 * takes everything the pipe holds, as a kernel pipe's does, so a run of
 * small writes costs its reader one wake. A transport that gets its answer
 * whole wrote it through the same sink. The
 * status settles on the result as the output ends (`IOResult.output`), and
 * so does the stderr the run wrote when no `errors` takes it, after what the
 * result already held. A reader that stops early stops the run,
 * which then exits 141, as SIGPIPE leaves a program, and keeps the stderr it
 * had written. A stopped run that does not end within the stop bound is left
 * running, as a stopped handler is (`runCancellable`). Mirrors Python's
 * `run_output`, whose cancel ends the run outright.
 *
 * @param run starts the run, given where it writes stdout, where it writes
 *   stderr and the signal that stops it.
 * @param producer what made the output, for a program run past the
 *   workspace's own commands.
 * @param errors takes stderr as the run writes it, after the stdout written
 *   before it has been read; undefined lands it on the result's stderr.
 * @param stdin the run's input, closed once the output ends.
 * @param signal the command's own abort, which stops the run too.
 */
export function runOutput(
  run: (output: OutputFn, errors: OutputFn, signal: AbortSignal) => Promise<RunResult>,
  producer: Producer | null = null,
  errors?: OutputFn,
  stdin: ByteSource | null = null,
  signal?: AbortSignal,
): [OutputStream, IOResult] {
  const pipe = new BytePipe()
  const stop = new AbortController()
  const runSignal = mergeSignals(signal, stop.signal) ?? stop.signal
  const caller = currentCaller()
  const io = new IOResult({ producer })
  const state = new OutputState()
  io.output = state
  let task: Promise<void> | undefined
  let settled = false
  let stopped = false
  let closing: Promise<void> | undefined
  const kept: Uint8Array[] = []
  // Stdout written before this chunk reaches its reader first, so the two
  // keep the order the program wrote them in (`2>&1`).
  const ordered = async (chunk: Uint8Array): Promise<void> => {
    await pipe.drain()
    await errors?.(chunk)
  }
  let held = 0
  const keep = (chunk: Uint8Array): Promise<void> => {
    held += chunk.byteLength
    checkMemory(held)
    kept.push(new Uint8Array(chunk))
    return Promise.resolve()
  }
  // A run its reader or deadline stopped, or a `kill` naming a signal, gets
  // the stop bound to answer, which a sandbox's reap fits within; a run whose
  // caller went away releases it soon, as a stopped handler does.
  const grace = (): number =>
    hasAborted(signal) && (caller.process?.signal ?? null) === null
      ? ABORT_JOIN_MS
      : STOP_WAIT_SECONDS * 1000
  const execute = async (): Promise<void> => {
    try {
      const result = await run(
        (chunk) => pipe.write(chunk),
        errors === undefined ? keep : ordered,
        runSignal,
      )
      if (stopped) return
      io.exitCode = result.exitCode
      pipe.end()
    } catch (error) {
      stop.abort()
      pipe.end(error)
      throw error
    } finally {
      settled = true
    }
  }
  const close = (): Promise<void> => {
    closing ??= (async () => {
      pipe.closeReader()
      if (task !== undefined && !settled) {
        stopped = true
        stop.abort()
      }
      if (task !== undefined) {
        await runCancellable(task, stop.signal, grace).catch((error: unknown) => {
          if (stopped || error instanceof PipeClosed) return
          console.debug(`runtime output ended: ${String(error)}`)
        })
      }
      if (stopped) io.exitCode = SIGPIPE_STATUS
      if (kept.length > 0) io.stderr = concat([await materialize(io.stderr), ...kept])
      await closeQuietly(stdin)
      state.finish()
    })()
    return closing
  }
  async function* output(): AsyncGenerator<Uint8Array> {
    task = execute()
    void task.catch(() => undefined)
    try {
      yield* pipe.stream(true)
    } finally {
      await close()
    }
  }
  return [new OutputStream(withCaller(output(), caller), close), io]
}

/** A console that hands each chunk a line writes on as it comes. */
export class Relay extends JobConsole {
  constructor(
    private readonly output: OutputFn,
    private readonly errors: OutputFn,
  ) {
    super()
  }

  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    await (channel === Channel.STDOUT ? this.output : this.errors)(data)
  }
}

/**
 * A nested line run as a command's output, through `runOutput`: the line
 * writes into a `Relay` as it runs, what it returned rather than wrote
 * follows, and its status, at least `least`, and its stderr settle on the
 * result as the output ends. A reader that stops early stops the line,
 * which then exits 141. The way `find -exec`, `find -files0-from` and a
 * wrapper builtin run their program. Mirrors Python's `line_output`.
 *
 * @param run runs the line, given the console it writes into and the
 *   signal that stops it.
 * @param least the lowest status the line ends with.
 * @param sink where the caller's statement writes, which the line's stderr
 *   goes to in its order with stdout (`runOutput`); none lands it on the
 *   result.
 */
export function lineOutput(
  run: (sink: JobConsole, signal: AbortSignal) => Promise<IOResult>,
  least = 0,
  sink?: JobConsole,
): [OutputStream, IOResult] {
  return runOutput(
    async (output, errors, signal) => {
      const ran = await run(new Relay(output, errors), signal)
      if (ran.stdout !== null) for await (const chunk of chunks(ran.stdout)) await output(chunk)
      if (ran.stderr !== null) for await (const chunk of chunks(ran.stderr)) await errors(chunk)
      return { exitCode: Math.max(ran.exitCode, least) }
    },
    null,
    sink === undefined ? undefined : (chunk) => sink.emit(Channel.STDERR, chunk),
  )
}

/**
 * Whether a thrown error means the runtime itself is missing (exit 127),
 * not that the program it ran failed.
 *
 * Args:
 *   err: the error the runtime threw.
 */
export function runtimeUnavailable(err: unknown): err is Error {
  return (
    err instanceof QuickJsUnavailableError ||
    err instanceof MontyUnavailableError ||
    err instanceof PyodideUnavailableError
  )
}

export function runtimeVersion(
  label: string,
  runtime: LanguageRuntime,
  env: Record<string, string>,
  signal?: AbortSignal,
  timeoutSeconds?: number,
): CommandFnResult {
  const run = async (output: OutputFn, errors: OutputFn, stop: AbortSignal): Promise<RunResult> => {
    try {
      return await runtime.version(env, output, errors, stop, timeoutSeconds)
    } catch (err) {
      if (err instanceof CommandTimeoutError) throw err
      const message = err instanceof Error ? err.message : String(err)
      await errors(encodeText(`${label}: ${message}\n`))
      return { exitCode: runtimeUnavailable(err) ? NOT_FOUND_STATUS : 1 }
    }
  }
  return runOutput(run, null, undefined, null, signal)
}

function failed(label: string, message: string, exitCode: number): [null, IOResult] {
  return [
    null,
    new IOResult({ exitCode, stderr: new TextEncoder().encode(`${label}: ${message}\n`) }),
  ]
}

/**
 * The answer of an interpreter command no runtime runs: bash's
 * `command not found`, exit 127, whatever the operands say.
 */
export function notBound(label: string): CommandFnResult {
  return failed(label, 'command not found', NOT_FOUND_STATUS)
}

/**
 * Why policy will not let an interpreter command run its program; null
 * when it may.
 *
 * The x check follows the program's entry point. A script operand asks
 * the per-path entry point about the script's own path, so a session
 * whose only x grant is one show subtree runs scripts there and nowhere
 * else; inline code (-c/-e), -m and stdin keep the whole-session rule
 * (`execAllowed`: any x grant), since no path holds them. Outside a
 * workspace no per-path entry point is wired and `execAllowed` answers
 * for files too. Mirrors Python's `exec_refusal`.
 *
 * @param label the command name used in the message.
 * @param script the script operand, null for a program from -c, -m or
 *   stdin (`scriptOperand`).
 * @param placement the command's exec policy; absent allows.
 */
export function execRefusal(
  label: string,
  script: PathSpec | null,
  placement: CommandRuntime | undefined,
): [null, IOResult] | null {
  if (script !== null) {
    const allowed = placement?.execPathAllowed?.(script.virtual) ?? placement?.execAllowed !== false
    if (allowed) return null
    const display = script.rawPath !== '' ? script.rawPath : script.virtual
    return failed(label, `${display}: not in EXEC mode`, CANNOT_EXECUTE_STATUS)
  }
  if (placement?.execAllowed !== false) return null
  return failed(label, "root mount '/' is not in EXEC mode", CANNOT_EXECUTE_STATUS)
}

/**
 * Run an interpreter command's operands on its bound runtime, the program's
 * output handed over as it runs (`runOutput`). A failure of the runtime
 * itself answers as the command: a missing engine 127, any other 1, an
 * in-VM limit interrupt a timeout named after the command, as the
 * workspace's own timer names it. A script the runtime could not read is
 * the command's own read failure, left to the executor to render as any
 * command's is, as Python lets it escape.
 *
 * @param label the command name used in messages.
 * @param runtime the runtime bound to the command.
 * @param paths the path operands.
 * @param texts the text operands.
 * @param ctx the command's context, its flags the runtime's switches.
 * @param script the script operand (`scriptOperand`), null for a program
 *   from -c, -m or stdin.
 */
export function runInterpreter(
  label: string,
  runtime: LanguageRuntime,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  script: PathSpec | null,
): CommandFnResult {
  const run = async (
    output: OutputFn,
    errors: OutputFn,
    signal: AbortSignal,
  ): Promise<RunResult> => {
    try {
      return await runtime.execute(paths, texts, { ...ctx, signal }, { output, errors })
    } catch (err) {
      if (err instanceof CommandTimeoutError) throw new CommandTimeoutError(label, err.seconds)
      if ((err instanceof Error && err.name === 'AbortError') || hasAborted(signal)) throw err
      if (script !== null && isFsError(err) && errorVirtualPath(err) === script.virtual) throw err
      const message = err instanceof Error ? err.message : String(err)
      await errors(encodeText(`${label}: ${message}\n`))
      return { exitCode: runtimeUnavailable(err) ? NOT_FOUND_STATUS : 1 }
    } finally {
      // The program may have written past the dispatcher.
      await ctx.runtime?.settle?.()
    }
  }
  return runOutput(run, null, undefined, ctx.stdin, ctx.signal)
}
