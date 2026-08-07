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

import type { Runtime } from '../base.ts'
import { LanguageRuntime } from '../language.ts'
import { bindCommands, catchAll, runtimeBindingsFor } from '../table.ts'
import { CommandTimeoutError, runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import { EvalError } from '../errors.ts'
import { isEvaluator, type Evaluator } from '../mixin.ts'
import type { EvalValue } from '../types.ts'
import { PolicyDeny, PolicyError } from './errors.ts'
import {
  DenyResult,
  RouteResult,
  ScriptSource,
  policyContextPayload,
  type PolicyDecision,
  type PolicyContext,
  type PolicyFn,
  type PolicyScript,
} from './types.ts'

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
 * runtime in any language). The first evaluator whose `language`
 * matches the script's wins, so a .js policy runs on quickjs even when
 * a python evaluator sits earlier in the world; with no language (or no
 * match) the first evaluator serves. Null when the world has no
 * evaluator, which only matters once a ScriptSource actually needs one.
 * The attribute read here is the one `run` answers for too
 * (Runtime.language), so an engine cannot speak one language at this
 * door and another at that one.
 */
export function evaluatorOf(
  entries: readonly Runtime[],
  language?: string,
): (Runtime & Evaluator) | null {
  let first: (Runtime & Evaluator) | null = null
  for (const entry of entries) {
    if (isEvaluator(entry)) {
      first ??= entry
      if (language !== undefined && entry instanceof LanguageRuntime && entry.language === language)
        return entry
    }
  }
  return first
}

/**
 * The world's interpreter for a script CLI, evaluatorOf's run twin.
 *
 * The first entry whose `run` speaks the language wins, the same
 * first-match rule. Unlike evaluatorOf there is no any-language
 * fallback: a python program cannot run on a js engine, so no match
 * means null and the caller reports the world's entries.
 */
export function runtimeForLanguage(
  entries: readonly Runtime[],
  language: string,
): LanguageRuntime | null {
  for (const entry of entries) {
    if (entry instanceof LanguageRuntime && entry.language === language) return entry
  }
  return null
}

/**
 * Evaluate a config script on the world's evaluator. The script sees
 * the ctx payload as the `ctx` global and its LAST EXPRESSION is the
 * verdict; the script's language is the evaluator's language.
 */
async function evalSource(
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
    throw new PolicyError(caught instanceof Error ? caught.message : String(caught), {
      cause: caught,
    })
  }
}

/**
 * The context as one runtime's script sees it: command/builtin become
 * the first stage the runtime captures, so `ctx.command === 'python3'`
 * means what it reads as even on `cat x | python3`. A runtime with no
 * captured stage on the line (including the catch-all vfs) keeps the
 * line's first stage.
 */
function ctxForRuntime(ctx: PolicyContext, runtime: Runtime): PolicyContext {
  for (const parsed of ctx.commands) {
    if (runtime.captures.includes(parsed.command)) {
      return { ...ctx, command: parsed.command, builtin: parsed.builtin }
    }
  }
  return ctx
}

/**
 * Ask one runtime's script whether it wants the line.
 *
 * A script answering with a policy verdict shape (an object, Map, or a
 * PolicyResult arm) fails loud: a deny-dict is truthy, so coercing it
 * would mean "willing", the opposite of intent.
 */
async function evaluateScript(
  script: PolicyScript,
  ctx: PolicyContext,
  runtime: Runtime,
  entries: readonly Runtime[],
): Promise<boolean> {
  const view = ctxForRuntime(ctx, runtime)
  const verdict: unknown =
    script instanceof ScriptSource
      ? await evalSource(
          script.source,
          policyContextPayload(view, runtime),
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
        `the global policy), got ${JSON.stringify(verdict)} from '${runtime.name}'`,
    )
  }
  return Boolean(verdict)
}

/**
 * Normalize a policy verdict to a runtime name or null to pass.
 *
 * The object form is the extensible spelling: `{runtime: name}` places
 * the line, `{deny: reason}` refuses it, and the keys are mutually
 * exclusive. Unknown keys fail loud so a typo never silently passes.
 */
export function parseVerdict(verdict: unknown): string | null {
  if (verdict === null) return null
  if (typeof verdict === 'string') return verdict
  if (verdict instanceof RouteResult) return verdict.runtime
  if (verdict instanceof DenyResult) throw new PolicyDeny(verdict.reason)
  if (verdict instanceof Map) {
    // A custom evaluator may hand python dicts back as Map (the monty
    // engine did before its boundary normalized); fold to the plain
    // object wire shape instead of misreading Map as an empty dict.
    const folded: Record<string, unknown> = {}
    for (const [key, value] of verdict) folded[String(key)] = value
    return parseVerdict(folded)
  }
  if (typeof verdict === 'object' && !Array.isArray(verdict) && !(verdict instanceof Uint8Array)) {
    const obj = verdict as Record<string, unknown>
    const unknown = Object.keys(obj)
      .filter((key) => key !== 'runtime' && key !== 'deny')
      .sort()
    if (unknown.length > 0) {
      throw new PolicyError(`unknown policy verdict keys: ${JSON.stringify(unknown)}`)
    }
    if ('deny' in obj && 'runtime' in obj) {
      throw new PolicyError('policy verdict cannot both place and deny')
    }
    if ('deny' in obj) throw new PolicyDeny(String(obj.deny))
    if (typeof obj.runtime === 'string') return obj.runtime
    throw new PolicyError("policy verdict dict needs a 'runtime' name or a 'deny' reason")
  }
  throw new PolicyError(
    `policy must return a runtime name, a verdict dict, or null, got ${JSON.stringify(verdict)}`,
  )
}

/** Run the global policy, returning a runtime name or null to pass. */
async function evaluatePolicy(
  policy: PolicyFn,
  ctx: PolicyContext,
  entries: readonly Runtime[],
): Promise<string | null> {
  // An untyped JS policy can return undefined for "pass"; `?? null`
  // folds it into python's None instead of erroring.
  const verdict =
    policy instanceof ScriptSource
      ? await evalSource(
          policy.source,
          policyContextPayload(ctx),
          evaluatorOf(entries, policy.language),
        )
      : ((await policy(ctx)) ?? null)
  return parseVerdict(verdict)
}

/**
 * Resolve the policy ladder for one line: policy, then scripts.
 *
 * A policy verdict overlays the named runtime's captures on the static
 * bindings (an affirmative choice, never a refusal). With no verdict,
 * per-runtime scripts filter the entry list: an entry with no script
 * is always willing, and the willing entries re-bind in list order.
 * The vfs runtime is filtered exactly like the others; a command left
 * without a willing runtime is an admission failure at dispatch.
 * Config-borne scripts run on the world's evaluator (evaluatorOf),
 * never on a hardcoded interpreter.
 */
export async function decideLine(
  entries: readonly Runtime[],
  policy: PolicyFn | null,
  ctx: PolicyContext,
  staticBindings: Record<string, Runtime>,
): Promise<PolicyDecision> {
  if (policy !== null) {
    const name = await evaluatePolicy(policy, ctx, entries)
    if (name !== null) {
      let overlay: Record<string, Runtime>
      try {
        overlay = runtimeBindingsFor(entries, name)
      } catch (caught) {
        throw new PolicyError(caught instanceof Error ? caught.message : String(caught), {
          cause: caught,
        })
      }
      return {
        bindings: Object.assign(
          Object.create(null) as Record<string, Runtime>,
          staticBindings,
          overlay,
        ),
        fallback: catchAll(entries),
      }
    }
  }
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
