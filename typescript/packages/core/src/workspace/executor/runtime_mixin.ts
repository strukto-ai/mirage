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

import type { Runtime } from './runtime.ts'
import type { EvalResult, EvalValue } from './runtime_types.ts'

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
   * The language `eval` speaks ("python" or "js"); the policy engine
   * matches it against a config script's extension so a .js policy
   * lands on a JS evaluator.
   */
  readonly evalLanguage: 'python' | 'js'

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
