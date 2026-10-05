import { runWithTimeout } from '../commands/builtin/utils/limit.ts'
import { Runtime } from './base.ts'
import { LanguageRuntime } from './language.ts'
import { isEvaluator, type Evaluator } from './mixin.ts'
import type { ScriptSource } from './types.ts'
import { buildRuntime } from './table.ts'
import type { EvalValue } from './types.ts'

export const CTX_GLOBAL = 'ctx'

/**
 * Build the engine a config script runs on: the one the config named,
 * and the config always names one.
 *
 * There is no default engine to fall back to: a script without a
 * `runtime` is refused where the config is validated, because a default
 * the operator never wrote is an engine they never chose. The engine is
 * built fresh and never picked out of a workspace's runtime world: the
 * world is the ordered set that serves *agent* code, it is mutable
 * after construction, and an entry drops out of it silently when an
 * optional dependency is missing. Throws a plain Error whose message is
 * a clause about "script", for the caller to prefix with whose script
 * it is.
 */
export function scriptEngine(script: ScriptSource, runtime: string): Runtime & Evaluator {
  let built: Runtime
  try {
    built = buildRuntime(runtime)
  } catch (err) {
    // An engine reports a missing dependency as its own error, each
    // carrying its own install hint.
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`script names runtime '${runtime}': ${detail}`)
  }
  if (!isEvaluator(built)) {
    throw new Error(
      `script names runtime '${runtime}', which runs programs but cannot evaluate one`,
    )
  }
  // `language` is declared by LanguageRuntime, not by Runtime, so an
  // engine that interprets no language at all cannot answer here and
  // is left to the evaluation arm rather than compared against nothing.
  if (built instanceof LanguageRuntime && built.language !== script.language) {
    throw new Error(
      `script is ${script.language}, but names runtime '${runtime}', which speaks ${built.language}`,
    )
  }
  return built
}

/**
 * Evaluate a config-borne script and return its last expression.
 *
 * The one place the config-script calling convention is written down:
 * the payload arrives as a single global named `ctx`, and the script's
 * last expression is its answer. Every config script speaks it (the
 * runtime router's `policy:`, a runtime's entry script, a profile's
 * `script:`), and they used to spell it out one at a time, which is a
 * convention two callers can drift apart on: this host passed the
 * payload's keys as separate globals for exactly one release, so `ctx`
 * was undefined here and defined in Python.
 *
 * Deliberately throws rather than wording its failures. Each caller
 * refuses in its own voice and its own error type (the runtime router's
 * RouteError is not the permissions layer's PolicyError), so a shared wording here
 * would put one layer's words on the other layer's failure.
 *
 * @throws CommandTimeoutError - the script outran `timeoutSeconds`.
 * @throws EvalError - the script did not parse, or threw.
 */
export async function evalWithCtx(
  source: string,
  ctx: Record<string, EvalValue>,
  evaluator: Evaluator,
  timeoutSeconds: number,
  label: string,
): Promise<EvalValue> {
  const release = evaluator instanceof Runtime ? evaluator.admit() : undefined
  try {
    const result = await runWithTimeout(
      evaluator.eval(source, { inputs: { [CTX_GLOBAL]: ctx } }),
      timeoutSeconds,
      label,
    )
    return result.value
  } finally {
    release?.()
  }
}
