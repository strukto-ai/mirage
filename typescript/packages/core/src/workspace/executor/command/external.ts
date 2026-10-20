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

import type { Context } from '../../../commands/config.ts'
import type { ExecutionKind, OutputFn, RunResult } from '../../../runtime/types.ts'
import type { Runtime } from '../../../runtime/base.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { hasAborted, mergeSignals } from '../../../utils/abort.ts'
import { runWithTimeout } from '../../../commands/builtin/utils/limit.ts'
import { resolveLimit } from '../../../policy/index.ts'
import { IOResult, OutputState, materialize, type ByteSource } from '../../../io/types.ts'
import { EXTERNAL_COMMANDS } from '../../../runtime/constants.ts'
import { BytePipe } from '../../../io/pipe.ts'
import { PipeClosed } from '../../../io/errors.ts'
import { OutputStream, closeQuietly } from '../../../io/stream.ts'
import { currentCaller, withCaller } from '../../../context/session_context.ts'
import { isProcessExecutor, isStreamingProcess } from '../../../runtime/mixin.ts'
import type { RouteDecision } from '../../../runtime/routing/types.ts'
import { shellJoin } from '../../../shell/join.ts'
import { PathSpec } from '../../../types.ts'
import type { Argv } from '../../expand/argv.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { SessionState } from '../../session/session.ts'
import { envSnapshot } from '../../session/state.ts'
import { ExecutionNode } from '../../types.ts'
import { encodeText } from '../../../shell/bytes.ts'

/** Execute one admitted program; its surrounding shell stays in Mirage. */
export async function runExternal(
  argv: Argv,
  stdin: ByteSource | null,
  session: SessionState,
  registry: MountRegistry,
  routing?: RouteDecision<Runtime>,
  signal?: AbortSignal,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  const bindings = routing === undefined ? registry.runtimeBindings : routing.bindings
  const key = Object.hasOwn(bindings, argv.name) ? argv.name : EXTERNAL_COMMANDS
  const runtime = bindings[key]
  const command = shellJoin(argv.tokens)
  if (runtime == null) {
    const stderr = encodeText(`${argv.name}: no runtime accepted this line\n`)
    return [
      null,
      new IOResult({ exitCode: 126, stderr }),
      new ExecutionNode({ command, exitCode: 126, stderr }),
    ]
  }
  const guard = resolveLimit(
    argv.name,
    registry.allMounts(),
    null,
    null,
    registry.commandLimits,
    session.commandLimits,
  )
  const timeout = guard?.timeoutSeconds ?? null
  if (isStreamingProcess(runtime))
    return streamExternal(runtime, argv, stdin, session, registry, timeout, signal)
  const deadline = timeout !== null && timeout > 0 ? new AbortController() : null
  const runSignal = mergeSignals(signal, deadline?.signal)
  const execute = async () => {
    const input = stdin === null ? null : await materialize(stdin)
    runSignal?.throwIfAborted()
    const ctx: Context = {
      stdin: input,
      flags: {},
      cwd: PathSpec.fromStrPath(session.cwd),
      env: envSnapshot(session),
      ...(runSignal !== undefined ? { signal: runSignal } : {}),
    }
    return isProcessExecutor(runtime)
      ? executeProgram(runtime, argv.name, argv.tokens, ctx, { kind: 'process' })
      : executeProgram(runtime, argv.name, [], { ...ctx, flags: { c: command } }, { kind: 'line' })
  }
  try {
    const result = await runWithTimeout(execute(), timeout, argv.name)
    return [
      result.stdout,
      new IOResult({
        exitCode: result.exitCode,
        stderr: result.stderr,
        producer: {
          command: argv.name,
          declared: null,
          prefixes: registry.allMounts().map((mount) => mount.prefix),
        },
      }),
      new ExecutionNode({
        command,
        exitCode: result.exitCode,
        stderr: result.stderr ?? new Uint8Array(),
      }),
    ]
  } catch (err) {
    if (err instanceof CommandTimeoutError) deadline?.abort()
    throw err
  } finally {
    await registry.settle(runtime)
  }
}

function streamExternal(
  runtime: Runtime,
  argv: Argv,
  stdin: ByteSource | null,
  session: SessionState,
  registry: MountRegistry,
  timeout: number | null,
  signal?: AbortSignal,
): [ByteSource, IOResult, ExecutionNode] {
  const cwd = PathSpec.fromStrPath(session.cwd)
  const env = envSnapshot(session)
  const pipe = new BytePipe()
  const controller = new AbortController()
  const runSignal = mergeSignals(signal, controller.signal) ?? controller.signal
  const caller = currentCaller()
  const io = new IOResult({
    producer: {
      command: argv.name,
      declared: null,
      prefixes: registry.allMounts().map((m) => m.prefix),
    },
  })
  const state = new OutputState()
  io.output = state
  const node = new ExecutionNode({ command: shellJoin(argv.tokens), exitCode: 0 })
  let task: Promise<void> | undefined
  let settled = false
  let closing: Promise<void> | undefined
  const execute = async (): Promise<void> => {
    try {
      const result = await runWithTimeout(
        executeProgram(
          runtime,
          argv.name,
          argv.tokens,
          { stdin, flags: {}, cwd, env, signal: runSignal },
          { kind: 'process', output: (chunk) => pipe.write(chunk) },
        ),
        timeout,
        argv.name,
      )
      if (result.stdout.length) await pipe.write(result.stdout)
      io.exitCode = node.exitCode = result.exitCode
      io.stderr = node.stderr = result.stderr ?? new Uint8Array()
      pipe.end()
    } catch (error) {
      controller.abort()
      pipe.end(error)
      throw error
    } finally {
      settled = true
      await registry.settle(runtime)
    }
  }
  const close = (): Promise<void> => {
    closing ??= (async () => {
      pipe.closeReader()
      if (!settled && task !== undefined) {
        io.exitCode = node.exitCode = 141
        controller.abort()
      }
      await task?.catch((error: unknown) => {
        if (error instanceof PipeClosed || (error instanceof Error && error.name === 'AbortError'))
          return
        console.error(`external stream cleanup failed: ${String(error)}`)
      })
      await closeQuietly(stdin)
      state.finish()
    })()
    return closing
  }
  async function* output(): AsyncGenerator<Uint8Array> {
    task = execute()
    void task.catch(() => undefined)
    try {
      yield* pipe.stream()
      await task
    } finally {
      await close()
    }
  }
  return [new OutputStream(withCaller(output(), caller), close), io, node]
}

/**
 * Keep an ordinary launch failure within the command that caused it.
 *
 * @param runtime the runtime the line routed to.
 * @param name the program's name, for a launch failure's message.
 * @param texts the argv, or nothing for a line.
 * @param ctx the run's context.
 * @param opts a process or a line, and where a streamed process writes.
 */
async function executeProgram(
  runtime: Runtime,
  name: string,
  texts: readonly string[],
  ctx: Context,
  opts: { kind: ExecutionKind; output?: OutputFn },
): Promise<RunResult> {
  try {
    return await runtime.execute([], texts, ctx, opts)
  } catch (error) {
    if (
      error instanceof CommandTimeoutError ||
      (error instanceof Error && error.name === 'AbortError') ||
      hasAborted(ctx.signal)
    )
      throw error
    return {
      stdout: new Uint8Array(),
      stderr: encodeText(`${name}: ${error instanceof Error ? error.message : String(error)}\n`),
      exitCode: 1,
    }
  }
}
