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
import { evalWithCtx } from '../script.ts'
import { bindCommands, catchAll } from '../table.ts'
import { CommandTimeoutError } from '../../errors/types.ts'
import { scriptContext } from '../../policy/script.ts'
import type { RouteContext } from '../../policy/types.ts'
import { EvalError } from '../errors.ts'
import { isEvaluator, type Evaluator } from '../mixin.ts'
import { ScriptSource, type EvalValue } from '../types.ts'
import { RouteError } from './errors.ts'
import type { RouteDecision, RoutePolicy, RouteScript, RouteVerdict } from './types.ts'
import { SCRIPT_EVAL_TIMEOUT } from '../constants.ts'

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
 * entry point and another at that one.
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
    throw new RouteError(
      'policy scripts need an evaluator runtime in the workspace ' +
        '(the default python runtime, or use a function instead)',
    )
  }
  try {
    return await evalWithCtx(
      source,
      ctxPayload,
      evaluator,
      SCRIPT_EVAL_TIMEOUT.seconds,
      'policy script',
    )
  } catch (caught) {
    if (caught instanceof CommandTimeoutError) {
      throw new RouteError(
        `policy script timed out after ${String(SCRIPT_EVAL_TIMEOUT.seconds)}s`,
        { cause: caught },
      )
    }
    if (caught instanceof EvalError) {
      const prefix = caught.syntax ? 'policy script syntax error: ' : 'policy script failed: '
      throw new RouteError(prefix + caught.message, { cause: caught })
    }
    throw new RouteError(caught instanceof Error ? caught.message : String(caught), {
      cause: caught,
    })
  }
}

/**
 * Ask one runtime's script whether it wants the line.
 *
 * The script sees the line's context with `runtime` added (its name and
 * captures), so it can find the commands it would serve. A script
 * answering with a policy answer (an object or Map) fails loud: a
 * deny-dict is truthy, so coercing it would mean "willing", the
 * opposite of intent.
 */
export async function evaluateScript(
  script: RouteScript,
  ctx: RouteContext,
  runtime: Runtime,
  entries: readonly Runtime[],
): Promise<boolean> {
  const verdict: unknown =
    script instanceof ScriptSource
      ? await evalSource(
          script.source,
          {
            ...scriptContext(ctx),
            runtime: { name: runtime.name, captures: [...runtime.captures] },
          },
          evaluatorOf(entries, script.language),
        )
      : await script(ctx)
  if (
    verdict !== null &&
    typeof verdict === 'object' &&
    !Array.isArray(verdict) &&
    !(verdict instanceof Uint8Array)
  ) {
    throw new RouteError(
      "entry scripts answer a boolean (placement is the route policy's, " +
        `refusal a policy's), got ${JSON.stringify(verdict)} from '${runtime.name}'`,
    )
  }
  return Boolean(verdict)
}

/** Run the route policy and return what it answered, unread. */
export async function evaluatePolicy(
  policy: RoutePolicy,
  ctx: RouteContext,
  entries: readonly Runtime[],
): Promise<RouteVerdict | EvalValue> {
  // An untyped JS policy can return undefined for "pass"; `?? null`
  // folds it into python's None instead of erroring.
  return policy instanceof ScriptSource
    ? await evalSource(policy.source, scriptContext(ctx), evaluatorOf(entries, policy.language))
    : ((await policy(ctx)) ?? null)
}

/**
 * The runtimes' own scripts' decision, for a line no policy placed.
 *
 * Each runtime's script filters the entry list: an entry with no script
 * is always willing, and the willing entries re-bind in list order. The
 * workspace runtime is filtered exactly like the others; a command left
 * without a willing runtime is an admission failure at dispatch.
 * Config-borne scripts run on the world's evaluator (evaluatorOf),
 * never on a hardcoded interpreter.
 */
export async function decideLine(
  entries: readonly Runtime[],
  ctx: RouteContext,
): Promise<RouteDecision<Runtime>> {
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
