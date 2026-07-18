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

import { SPECS } from '../../commands/spec/index.ts'
import type { BridgeDispatchFn } from './python/mirage_bridge.ts'
import { evalMontyValue } from './python/runtimes/monty.ts'
import { bindCommands, pinBindings, VfsEntry, type Runtime, type RuntimeEntry } from './runtime.ts'
import type { TSNodeLike } from '../expand/variable.ts'

/** Parse facts for one command of the line being routed. */
export interface CommandFacts {
  command: string
  words: readonly string[]
  known: boolean
  paths: readonly string[]
}

/** Facts about the line being routed, parse-before-route. */
export interface RouteContext {
  line: string
  commands: readonly CommandFacts[]
  command: string
  known: boolean
  cwd: string
  env: Record<string, string>
  sessionId: string
  agentId: string
  mounts: readonly string[]
}

export type RouteScript = ((ctx: RouteContext) => boolean | Promise<boolean>) | string
export type RouteFn = ((ctx: RouteContext) => string | null | Promise<string | null>) | string

/**
 * A pin, route, or script could not decide the line. Caller-fixable
 * routing mistakes (unknown pin name, a script that does not parse, a
 * missing monty package) propagate loud instead of folding into the
 * line's IOResult like a command failure.
 */
export class RoutingDecisionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RoutingDecisionError'
  }
}

/** The one-line placement decision the dispatcher consults. */
export interface LineRouting {
  /** Command -> runtime for this line. */
  bindings: Record<string, Runtime>
  /**
   * Whether unbound commands may run on the vfs executor; false turns
   * them into admission failures.
   */
  vfsAllowed: boolean
  /**
   * Commands captured by some entry; an unbound captured command is an
   * admission failure (its capturers all refused), never a silent
   * fallback.
   */
  captured: ReadonlySet<string>
}

const WORD_TYPES: ReadonlySet<string> = new Set([
  'command_name',
  'word',
  'string',
  'raw_string',
  'number',
  'concatenation',
])

/** Extract per-command parse facts from a parsed line. */
export function commandFacts(root: TSNodeLike): CommandFacts[] {
  const facts: CommandFacts[] = []
  const stack: TSNodeLike[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (node.type === 'command') {
      const words = node.children.filter((c) => WORD_TYPES.has(c.type)).map((c) => c.text)
      const [command] = words
      if (command !== undefined) {
        facts.push({
          command,
          words,
          known: command in SPECS,
          paths: words.slice(1).filter((w) => w.startsWith('/')),
        })
      }
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i]
      if (child !== undefined) stack.push(child)
    }
  }
  return facts
}

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
): Promise<LineRouting> {
  if (route !== null) {
    const name = await evaluateRoute(route, ctx, bridge)
    if (name !== null) {
      let overlay: Record<string, Runtime>
      try {
        overlay = pinBindings(entries, name)
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
