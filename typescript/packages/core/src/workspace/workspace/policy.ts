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

import { PolicyDeny, PolicyError } from '../../policy/errors.ts'
import { preExecuteGate } from '../../policy/gates.ts'
import type { ExecuteContext } from '../../policy/types.ts'
import { decideLine, parsedCommands, type PolicyDecision } from '../executor/route/index.ts'
import { catchAll, runtimeBindingsFor, type Runtime } from '../executor/runtime.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionManager } from '../session/manager.ts'
import type { ExecuteOptions } from './types.ts'
import type { Runtimes } from './runtimes.ts'

/**
 * Decides which runtime a typed line routes to.
 *
 * The order is: an inherited decision, then the execute() runtime
 * argument, then the preExecute policies (the `policy` script rides
 * the chain as the RoutingPolicy built-in) and any entry scripts.
 * Mirrors the Python `PolicyRouter` in `workspace/policy.py`.
 *
 * `decide` returns null when nothing decides (no runtime argument, no
 * preExecute policy, no entry scripts) so dispatch falls to the static
 * bindings; a nested eval inherits the typed line's decision and never
 * re-routes.
 */
export class PolicyRouter {
  private readonly registry: MountRegistry
  private readonly runtimes: Runtimes
  private readonly sessions: SessionManager
  private readonly agentId: string | null
  private readonly visibleMounts: () => string[]

  constructor(
    registry: MountRegistry,
    runtimes: Runtimes,
    sessions: SessionManager,
    agentId: string | null,
    visibleMounts: () => string[],
  ) {
    this.registry = registry
    this.runtimes = runtimes
    this.sessions = sessions
    this.agentId = agentId
    this.visibleMounts = visibleMounts
  }

  /**
   * Overlay one named runtime's captures on the static bindings: the
   * shared tail of the two affirmative placements (the `runtime`
   * argument and a Route from preExecute), so both spell an unknown
   * name identically (PolicyError).
   */
  private place(name: string): PolicyDecision {
    let overlay: Record<string, Runtime>
    try {
      overlay = runtimeBindingsFor(this.runtimes.entries, name)
    } catch (caught) {
      throw new PolicyError(caught instanceof Error ? caught.message : String(caught), {
        cause: caught,
      })
    }
    return {
      bindings: Object.assign(
        Object.create(null) as Record<string, Runtime>,
        this.runtimes.bindings,
        overlay,
      ),
      fallback: catchAll(this.runtimes.entries),
    }
  }

  async decide(
    root: TSNodeLike,
    command: string,
    options: ExecuteOptions,
  ): Promise<PolicyDecision | null> {
    if (options.routingDecision !== undefined) return options.routingDecision
    if (options.runtime !== undefined) return this.place(options.runtime)
    const policies = this.registry.policies
    const hasScripts = this.runtimes.entries.some((entry) => entry.script !== undefined)
    if (!policies.wants('preExecute') && !hasScripts) return null
    const commands = parsedCommands(root, this.registry.clis.names())
    const sessionId = options.sessionId ?? this.sessions.defaultId
    const session = this.sessions.get(sessionId)
    const ctx: ExecuteContext = {
      line: command,
      commands,
      command: commands[0]?.command ?? '',
      builtin: commands[0]?.builtin ?? false,
      cwd: options.cwd ?? session.cwd,
      env: { ...session.env, ...(options.env ?? {}) },
      sessionId,
      agentId: options.agentId ?? this.agentId ?? '',
      mounts: this.visibleMounts(),
    }
    const [deny, route] = await preExecuteGate(policies, ctx)
    if (deny !== null) throw new PolicyDeny(deny.message.replace(/\n$/, ''))
    if (route !== null) return this.place(route.runtime)
    return decideLine(this.runtimes.entries, ctx)
  }
}
