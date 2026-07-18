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
import {
  bindCommands,
  runtimeBindingsFor,
  VfsEntry,
  type Runtime,
  type RuntimeEntry,
} from '../runtime.ts'
import { RoutingDecisionError } from './errors.ts'
import type { RoutingDecision, RouteContext, RouteFn, RouteScript } from './types.ts'

function ctxPayload(ctx: RouteContext, runtime?: Runtime): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    line: ctx.line,
    commands: ctx.commands.map((c) => ({
      command: c.command,
      words: [...c.words],
      known: c.known,
      paths: [...c.paths],
    })),
    command: ctx.command,
    known: ctx.known,
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

/** Ask one runtime's script whether it wants the line. */
async function evaluateScript(
  script: RouteScript,
  ctx: RouteContext,
  runtime: Runtime,
  bridge: BridgeDispatchFn | null,
): Promise<boolean> {
  if (typeof script === 'string') {
    return Boolean(await evalMonty(script, ctxPayload(ctx, runtime), bridge))
  }
  return await script(ctx)
}

/** Run the global route, returning a runtime name or null to pass. */
async function evaluateRoute(
  route: RouteFn,
  ctx: RouteContext,
  bridge: BridgeDispatchFn | null,
): Promise<string | null> {
  const verdict =
    typeof route === 'string' ? await evalMonty(route, ctxPayload(ctx), bridge) : await route(ctx)
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
 * is always willing, and the willing entries re-bind in list order. A
 * captured command whose capturers all refused, or an uncaptured
 * command when the vfs entry is absent or unwilling, is an admission
 * failure at dispatch.
 */
export async function decideLine(
  entries: readonly RuntimeEntry[],
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
        vfsAllowed: true,
        captured: new Set(),
      }
    }
  }
  const willing: RuntimeEntry[] = []
  const captured = new Set<string>()
  let vfsAllowed = false
  for (const entry of entries) {
    if (typeof entry === 'string') {
      vfsAllowed = true
      willing.push(entry)
      continue
    }
    for (const command of entry.captures) captured.add(command)
    const wants =
      entry.script === undefined ? true : await evaluateScript(entry.script, ctx, entry, bridge)
    if (!wants) continue
    if (entry instanceof VfsEntry) vfsAllowed = true
    willing.push(entry)
  }
  return { bindings: bindCommands(willing), vfsAllowed, captured }
}
