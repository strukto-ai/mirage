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

import type { Context } from '../commands/config.ts'
import type { PathSpec } from '../types.ts'
import type { OutputFn, RunResult, RuntimeIdentity } from './types.ts'

/**
 * The nominal line-executor brand (python's LineExecutorMixin
 * inheritance). Detection is by this marker, never by probing for a
 * `runLine` method or a flag, so a runtime with an unrelated `runLine`
 * cannot accidentally claim whole lines.
 */
export const LINE_EXECUTOR: unique symbol = Symbol.for('mirage.lineExecutor')

/**
 * The whole-line capability: a raw command line in, a result out
 * (Python's LineExecutorMixin). A Runtime that also implements this
 * owns any line routed to it wholesale: pipes, redirects, and every
 * command in the line run inside the runtime's world (its own cat,
 * its own grep), the workspace shell never splits the line. A line
 * lands on it whole only with an explicit "*" capture; named captures
 * receive one safely quoted command. Interpreter runtimes never implement it: they are the engine
 * inside one command (python3, node), never the line. The workspace runtime
 * does not either: a line resolved to workspace runs on the workspace
 * executor inline, so there is no delegate to call.
 */
export interface LineExecutor<E = unknown> {
  readonly [LINE_EXECUTOR]: true

  /**
   * Execute one raw command line wholesale, `sh -c` with it.
   *
   * @param engine the runtime's engine.
   * @param paths unused; a line names its own paths.
   * @param texts unused.
   * @param ctx the line in `flags.c`, its stdin, the session environment
   *   and working directory, the signal that stops it.
   * @param output receives stdout as it arrives, each write awaited, which
   *   the result then leaves out; undefined, or a transport that cannot
   *   stream, returns it whole.
   * @param errors the same for stderr.
   */
  runLine(
    engine: E,
    paths: PathSpec[],
    texts: string[],
    ctx: Context,
    output?: OutputFn,
    errors?: OutputFn,
  ): Promise<RunResult>
}

/** Whether this runtime carries the whole-line capability. */
export function isLineExecutor<T extends RuntimeIdentity>(runtime: T): runtime is T & LineExecutor {
  return (runtime as Partial<LineExecutor>)[LINE_EXECUTOR] === true
}

/**
 * The nominal argv-executor brand (Python's ProcessExecutorMixin): an
 * argv run without shell interpretation, its input read as the program
 * consumes it and its output handed over as it comes.
 */
export const PROCESS_EXECUTOR: unique symbol = Symbol.for('mirage.processExecutor')

export interface ProcessExecutor<E = unknown> {
  readonly [PROCESS_EXECUTOR]: true
  /**
   * Run the program `texts` names, with `ctx`'s working directory,
   * environment and stdin, and resolve with its status once it exits.
   *
   * @param engine the runtime's engine.
   * @param paths unused; argv is words.
   * @param texts the argv, program first.
   * @param ctx the run's context; its stdin is read as the program consumes it.
   * @param output receives stdout as it arrives, each write awaited, which
   *   the result then leaves out; undefined, or a transport that cannot
   *   stream, returns it whole.
   * @param errors the same for stderr.
   */
  runProcess(
    engine: E,
    paths: PathSpec[],
    texts: string[],
    ctx: Context,
    output?: OutputFn,
    errors?: OutputFn,
  ): Promise<RunResult>
}

export function isProcessExecutor<T extends RuntimeIdentity>(
  runtime: T,
): runtime is T & ProcessExecutor {
  return (runtime as Partial<ProcessExecutor>)[PROCESS_EXECUTOR] === true
}
