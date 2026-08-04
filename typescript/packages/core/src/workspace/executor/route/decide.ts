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

import { CommandTimeoutError, runWithTimeout } from '../../../commands/builtin/utils/limit.ts'
import { PolicyError } from '../../../policy/errors.ts'
import { ctxForRuntime, executeContextPayload, type ExecuteContext } from '../../../policy/types.ts'
import { bindCommands, catchAll, type Runtime } from '../runtime.ts'
import { EvalError } from '../runtime_errors.ts'
import { isEvaluator, type Evaluator } from '../runtime_mixin.ts'
import type { EvalValue } from '../runtime_types.ts'
import { ScriptSource, type PolicyDecision, type PolicyScript } from './types.ts'

/** Policy evaluation is bounded: a hung script must not freeze every
 * line (command limits resolve after policy, so nothing above this
 * layer would). Matches the python POLICY_EVAL_TIMEOUT_SECONDS; a
 * holder object so tests can tighten it. */
export const POLICY_EVAL_TIMEOUT = { seconds: 10 }

/**
 * The world's policy engine for a script.
 *
 * Config-borne policy scripts run on it; any runtime implementing
 * Evaluator qualifies (monty/pyodide in the default worlds, or a user
 * runtime in any language). The first evaluator whose evalLanguage
 * matches the script's language wins, so a .js policy runs on quickjs
 * even when a python evaluator sits earlier in the world; with no
 * language (or no match) the first evaluator serves. Null when the
 * world has no evaluator, which only matters once a ScriptSource
 * actually needs one.
 */
export function evaluatorOf(
  entries: readonly Runtime[],
  language?: string,
): (Runtime & Evaluator) | null {
  let first: (Runtime & Evaluator) | null = null
  for (const entry of entries) {
    if (isEvaluator(entry)) {
      first ??= entry
      if (language !== undefined && entry.evalLanguage === language) return entry
    }
  }
  return first
}

/**
 * Evaluate a config script on the world's evaluator. The script sees
 * the ctx payload as the `ctx` global and its LAST EXPRESSION is the
 * verdict; the script's language is the evaluator's language.
 *
 * Throws PolicyError for the caller-fixable mistakes: no evaluator in
 * the world, a script that hangs, a script that does not parse or
 * raises. Any other failure is the evaluator's own infrastructure
 * breaking (a dead container, a dropped connection); it propagates
 * unchanged so the policy chain fails closed on it, matching the
 * python eval_source.
 */
export async function evalSource(
  source: string,
  ctxPayload: Record<string, EvalValue>,
  evaluator: Evaluator | null,
): Promise<EvalValue> {
  if (evaluator === null) {
    throw new PolicyError(
      'policy scripts need an evaluator runtime in the workspace ' +
        '(the default python runtime, or use a function instead)',
    )
  }
  try {
    const result = await runWithTimeout(
      evaluator.eval(source, { inputs: { ctx: ctxPayload } }),
      POLICY_EVAL_TIMEOUT.seconds,
      'policy script',
    )
    return result.value
  } catch (caught) {
    if (caught instanceof CommandTimeoutError) {
      throw new PolicyError(
        `policy script timed out after ${String(POLICY_EVAL_TIMEOUT.seconds)}s`,
        { cause: caught },
      )
    }
    if (caught instanceof EvalError) {
      const prefix = caught.syntax ? 'policy script syntax error: ' : 'policy script failed: '
      throw new PolicyError(prefix + caught.message, { cause: caught })
    }
    throw caught
  }
}

/**
 * Ask one runtime's script whether it wants the line.
 *
 * The script sees the runtime's own view of the context
 * (ctxForRuntime): `command` is its first captured stage, plus
 * `runtime` identity in the script payload. A script answering with a
 * policy verdict shape (an object or Map) fails loud: a deny-dict is
 * truthy, so coercing it would mean "willing", the opposite of intent.
 */
async function evaluateScript(
  script: PolicyScript,
  ctx: ExecuteContext,
  runtime: Runtime,
  entries: readonly Runtime[],
): Promise<boolean> {
  const view = ctxForRuntime(ctx, runtime)
  const verdict: unknown =
    script instanceof ScriptSource
      ? await evalSource(
          script.source,
          executeContextPayload(view, runtime),
          evaluatorOf(entries, script.language),
        )
      : await script(view)
  if (
    verdict !== null &&
    typeof verdict === 'object' &&
    !Array.isArray(verdict) &&
    !(verdict instanceof Uint8Array)
  ) {
    throw new PolicyError(
      'entry scripts answer a boolean (deny and placement belong to ' +
        `the routing policy), got ${JSON.stringify(verdict)} from '${runtime.name}'`,
    )
  }
  return Boolean(verdict)
}

/**
 * Resolve entry-script willingness for one line.
 *
 * Per-runtime scripts filter the entry list: an entry with no script
 * is always willing, and the willing entries re-bind in list order.
 * The vfs runtime is filtered exactly like the others; a command left
 * without a willing runtime is an admission failure at dispatch.
 * Config-borne scripts run on the world's evaluator (evaluatorOf),
 * never on a hardcoded interpreter. Routing verdicts do not live
 * here: the `policy` script fires earlier, as the RoutingPolicy
 * built-in on the preExecute hook.
 */
export async function decideLine(
  entries: readonly Runtime[],
  ctx: ExecuteContext,
): Promise<PolicyDecision> {
  const willing: Runtime[] = []
  for (const entry of entries) {
    const wants =
      entry.script === undefined ? true : await evaluateScript(entry.script, ctx, entry, entries)
    if (wants) willing.push(entry)
  }
  // Every captured command resolves: to its first willing capturer, or
  // to null (all capturers refused -> admission failure). Null
  // prototype: captures are arbitrary command names.
  const bindings: Record<string, Runtime | null> = Object.create(null) as Record<
    string,
    Runtime | null
  >
  for (const entry of entries) {
    for (const command of entry.captures) bindings[command] = null
  }
  Object.assign(bindings, bindCommands(willing))
  return { bindings, fallback: catchAll(willing) }
}
