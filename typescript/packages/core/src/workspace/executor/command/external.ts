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
import { hasAborted } from '../../../utils/abort.ts'
import { runOutput } from '../../../commands/builtin/general/interpreter.ts'
import type { ByteSource, IOResult } from '../../../io/types.ts'
import { EXTERNAL_COMMANDS } from '../../../runtime/constants.ts'
import { isProcessExecutor } from '../../../runtime/mixin.ts'
import type { RouteDecision } from '../../../runtime/types.ts'
import { shellJoin } from '../../../shell/join.ts'
import { PathSpec } from '../../../types.ts'
import type { Argv } from '../../expand/argv.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { SessionState } from '../../session/session.ts'
import { envSnapshot } from '../../session/state.ts'
import { ExecutionNode } from '../../types.ts'
import { admissionDenial } from './run.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { concat } from '../../../utils/bytes.ts'
import { Channel, type JobConsole } from '../../../shell/console/index.ts'

/**
 * Execute one admitted program; its surrounding shell stays in Mirage.
 *
 * Its output is handed over as it runs (`runOutput`), within the line's
 * deadline, kept alive until the output is closed. A program writes its
 * stderr into `sink` as it arrives, where the statement it runs in writes (a
 * job's console, a redirect, a compound body), so it lands beside its stdout
 * and stays when the program is stopped; without one it lands on the result,
 * kept as it arrives all the same.
 */
export async function runExternal(
  argv: Argv,
  stdin: ByteSource | null,
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime>,
  signal?: AbortSignal,
  sink?: JobConsole,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  const bindings = routing.bindings
  const key = Object.hasOwn(bindings, argv.name) ? argv.name : EXTERNAL_COMMANDS
  const runtime = bindings[key]
  const command = shellJoin(argv.tokens)
  if (runtime == null) {
    const denied = admissionDenial(argv.name)
    const stderr = await denied.materializeStderr()
    return [null, denied, new ExecutionNode({ command, exitCode: 126, stderr })]
  }
  // A runtime that runs an argv gets one; a line runtime gets the program
  // as one quoted line.
  const process = isProcessExecutor(runtime)
  const kind: ExecutionKind = process ? 'process' : 'line'
  const ctx: Context = {
    stdin,
    flags: process ? {} : { c: command },
    cwd: PathSpec.fromStrPath(session.cwd),
    env: envSnapshot(session),
  }
  const node = new ExecutionNode({ command, exitCode: 0 })
  const said: Uint8Array[] = []
  const toSink = async (chunk: Uint8Array): Promise<void> => {
    await sink?.emit(Channel.STDERR, chunk)
  }
  const run = async (output: OutputFn, errors: OutputFn, stop: AbortSignal): Promise<RunResult> => {
    // The command's record keeps a copy for the policies that read it.
    const told = async (chunk: Uint8Array): Promise<void> => {
      said.push(new Uint8Array(chunk))
      await errors(chunk)
    }
    try {
      const result = await executeProgram(
        runtime,
        argv.name,
        process ? argv.tokens : [],
        { ...ctx, signal: stop },
        { kind, output, errors: told },
      )
      node.stderr = concat([...said, result.stderr ?? new Uint8Array()])
      return result
    } finally {
      await registry.settle(runtime)
    }
  }
  const [stdout, io] = runOutput(
    run,
    {
      command: argv.name,
      declared: null,
      prefixes: registry.allMounts().map((mount) => mount.prefix),
      native: true,
    },
    sink !== undefined ? toSink : undefined,
    stdin,
    signal,
  )
  // The record takes the status the output settles with: 141 for a reader
  // that stopped early.
  io.output?.callbacks.push(() => {
    node.exitCode = io.exitCode
  })
  return [stdout, io, node]
}

/**
 * Keep an ordinary launch failure within the command that caused it.
 *
 * @param runtime the runtime the line routed to.
 * @param name the program's name, for a launch failure's message.
 * @param texts the argv, or nothing for a line.
 * @param ctx the run's context.
 * @param opts a process or a line, and where a streamed process writes its
 *   stdout and its stderr.
 */
async function executeProgram(
  runtime: Runtime,
  name: string,
  texts: readonly string[],
  ctx: Context,
  opts: { kind: ExecutionKind; output?: OutputFn; errors?: OutputFn },
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
