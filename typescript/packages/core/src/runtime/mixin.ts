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

import type { Runtime } from './base.ts'
import type { EvalResult, EvalValue, RunResult } from './types.ts'

/**
 * The nominal evaluator brand (python's EvaluatorMixin inheritance).
 * Detection is by this marker, never by probing for an `eval` method,
 * so a runtime with an unrelated `eval` cannot accidentally become
 * the policy engine. `Symbol.for` keeps the brand stable even when
 * two copies of the package are loaded.
 */
export const EVALUATOR: unique symbol = Symbol.for('mirage.evaluator')

/**
 * The evaluator capability: named inputs in, a value out (Python's
 * EvaluatorMixin). A Runtime that also implements this can evaluate
 * expressions, which is what the routing policy engine and the repl
 * consume; process-only runtimes never implement it and are never
 * asked to evaluate. The contract promises the shape, not value
 * fidelity: inputs and the returned value stay within EvalValue so
 * any transport can carry them, and errors surface as the
 * evaluator's own diagnostics wrapped in EvalError.
 */
export interface Evaluator {
  readonly [EVALUATOR]: true

  /**
   * The language `eval` speaks is `Runtime.language`, the same
   * attribute `run` answers for: the policy engine matches it against a
   * config script's extension so a .js policy lands on a JS evaluator.
   * A separate name here would let one runtime claim two languages.
   */

  /**
   * Evaluate one program and return its last expression. `inputs`
   * bind as globals in the evaluator's own idiom; a `session` id
   * keeps state alive per id (console semantics), absent evaluates
   * one-shot.
   */
  eval(
    code: string,
    opts?: { inputs?: Record<string, EvalValue>; session?: string },
  ): Promise<EvalResult>
}

/** Whether this runtime carries the evaluator capability. */
export function isEvaluator(runtime: Runtime): runtime is Runtime & Evaluator {
  return (runtime as Partial<Evaluator>)[EVALUATOR] === true
}

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
 * lands on it when the runtime captures one of the line's commands or
 * "*". Interpreter runtimes never implement it: they are the engine
 * inside one command (python3, node), never the line. The vfs runtime
 * does not either: a line resolved to vfs runs on the workspace
 * executor inline, so there is no delegate to call.
 */
export interface LineExecutor {
  readonly [LINE_EXECUTOR]: true

  /** Execute one raw command line wholesale. */
  runLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult>
}

/** Whether this runtime carries the whole-line capability. */
export function isLineExecutor(runtime: Runtime): runtime is Runtime & LineExecutor {
  return (runtime as Partial<LineExecutor>)[LINE_EXECUTOR] === true
}
