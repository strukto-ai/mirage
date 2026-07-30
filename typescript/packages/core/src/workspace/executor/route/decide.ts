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

import { bindCommands, catchAll, runtimeBindingsFor, type Runtime } from '../runtime.ts'
import { EvalError } from '../runtime_errors.ts'
import { isEvaluator, type Evaluator } from '../runtime_mixin.ts'
import type { EvalValue } from '../runtime_types.ts'
import { RoutingDecisionError } from './errors.ts'
import {
  ScriptSource,
  routeContextPayload,
  type RoutingDecision,
  type RouteContext,
  type RouteFn,
  type RouteScript,
} from './types.ts'

/**
 * The world's policy engine: its first evaluator-capable entry.
 *
 * Config-borne route scripts run on it; any runtime implementing
 * Evaluator qualifies (monty/pyodide in the default worlds, or a user
 * runtime in any language). Null when the world has no evaluator,
 * which only matters once a ScriptSource actually needs one.
 */
export function evaluatorOf(entries: readonly Runtime[]): (Runtime & Evaluator) | null {
  for (const entry of entries) {
    if (isEvaluator(entry)) return entry
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
    throw new RoutingDecisionError(
      'route scripts need an evaluator runtime in the workspace ' +
        '(the default python runtime, or use a function instead)',
    )
  }
  try {
    const result = await evaluator.eval(source, { inputs: { ctx: ctxPayload } })
    return result.value
  } catch (caught) {
    if (caught instanceof EvalError) {
      const prefix = caught.syntax ? 'route script syntax error: ' : 'route script failed: '
      throw new RoutingDecisionError(prefix + caught.message, { cause: caught })
    }
    throw new RoutingDecisionError(caught instanceof Error ? caught.message : String(caught), {
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
function ctxForRuntime(ctx: RouteContext, runtime: Runtime): RouteContext {
  for (const fact of ctx.commands) {
    if (runtime.captures.includes(fact.command)) {
      return { ...ctx, command: fact.command, builtin: fact.builtin }
    }
  }
  return ctx
}

/** Ask one runtime's script whether it wants the line. */
async function evaluateScript(
  script: RouteScript,
  ctx: RouteContext,
  runtime: Runtime,
  evaluator: Evaluator | null,
): Promise<boolean> {
  const view = ctxForRuntime(ctx, runtime)
  if (script instanceof ScriptSource) {
    return Boolean(await evalSource(script.source, routeContextPayload(view, runtime), evaluator))
  }
  return await script(view)
}

/** Run the global route, returning a runtime name or null to pass. */
async function evaluateRoute(
  route: RouteFn,
  ctx: RouteContext,
  evaluator: Evaluator | null,
): Promise<string | null> {
  // An untyped JS route can return undefined for "pass"; `?? null`
  // folds it into python's None instead of erroring.
  const verdict =
    route instanceof ScriptSource
      ? await evalSource(route.source, routeContextPayload(ctx), evaluator)
      : ((await route(ctx)) ?? null)
  if (verdict === null) return null
  if (typeof verdict === 'string') return verdict
  throw new RoutingDecisionError(
    `route must return a runtime name or null, got ${JSON.stringify(verdict)}`,
  )
}

/**
 * Resolve the routing ladder for one line: route, then scripts.
 *
 * A route verdict overlays the named runtime's captures on the static
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
  route: RouteFn | null,
  ctx: RouteContext,
  staticBindings: Record<string, Runtime>,
): Promise<RoutingDecision> {
  const evaluator = evaluatorOf(entries)
  if (route !== null) {
    const name = await evaluateRoute(route, ctx, evaluator)
    if (name !== null) {
      let overlay: Record<string, Runtime>
      try {
        overlay = runtimeBindingsFor(entries, name)
      } catch (caught) {
        throw new RoutingDecisionError(caught instanceof Error ? caught.message : String(caught), {
          cause: caught,
        })
      }
      return {
        bindings: { ...staticBindings, ...overlay },
        fallback: catchAll(entries),
      }
    }
  }
  const willing: Runtime[] = []
  for (const entry of entries) {
    const wants =
      entry.script === undefined ? true : await evaluateScript(entry.script, ctx, entry, evaluator)
    if (wants) willing.push(entry)
  }
  // Every captured command resolves: to its first willing capturer, or
  // to null (all capturers refused -> admission failure).
  const bindings: Record<string, Runtime | null> = {}
  for (const entry of entries) {
    for (const command of entry.captures) bindings[command] = null
  }
  Object.assign(bindings, bindCommands(willing))
  return { bindings, fallback: catchAll(willing) }
}
