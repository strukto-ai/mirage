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

import type { BridgeDispatchFn } from '../python/mirage_bridge.ts'
import { evalMontyValue } from '../python/runtimes/monty.ts'
import { bindCommands, catchAll, runtimeBindingsFor, type Runtime } from '../runtime.ts'
import { RoutingDecisionError } from './errors.ts'
import {
  ScriptSource,
  type RoutingDecision,
  type RouteContext,
  type RouteFn,
  type RouteScript,
} from './types.ts'

function ctxPayload(ctx: RouteContext, runtime?: Runtime): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    line: ctx.line,
    commands: ctx.commands.map((c) => ({
      command: c.command,
      words: [...c.words],
      builtin: c.builtin,
      paths: [...c.paths],
    })),
    command: ctx.command,
    builtin: ctx.builtin,
    cwd: ctx.cwd,
    env: { ...ctx.env },
    session_id: ctx.sessionId,
    agent_id: ctx.agentId,
    mounts: [...ctx.mounts],
  }
  if (runtime !== undefined) {
    payload.runtime = { name: runtime.name, captures: [...runtime.captures] }
  }
  return payload
}

async function evalMonty(
  source: string,
  payload: Record<string, unknown>,
  bridge: BridgeDispatchFn | null,
): Promise<unknown> {
  try {
    return await evalMontyValue(source, payload, bridge)
  } catch (caught) {
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
  bridge: BridgeDispatchFn | null,
): Promise<boolean> {
  const view = ctxForRuntime(ctx, runtime)
  if (script instanceof ScriptSource) {
    return Boolean(await evalMonty(script.source, ctxPayload(view, runtime), bridge))
  }
  return await script(view)
}

/** Run the global route, returning a runtime name or null to pass. */
async function evaluateRoute(
  route: RouteFn,
  ctx: RouteContext,
  bridge: BridgeDispatchFn | null,
): Promise<string | null> {
  const verdict =
    route instanceof ScriptSource
      ? await evalMonty(route.source, ctxPayload(ctx), bridge)
      : await route(ctx)
  if (verdict === null || verdict === undefined) return null
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
 */
export async function decideLine(
  entries: readonly Runtime[],
  route: RouteFn | null,
  ctx: RouteContext,
  staticBindings: Record<string, Runtime>,
  bridge: BridgeDispatchFn | null,
): Promise<RoutingDecision> {
  if (route !== null) {
    const name = await evaluateRoute(route, ctx, bridge)
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
      entry.script === undefined ? true : await evaluateScript(entry.script, ctx, entry, bridge)
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
