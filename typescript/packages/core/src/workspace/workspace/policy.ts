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

import {
  parsedCommands,
  decideLine,
  PolicyError,
  type PolicyContext,
  type PolicyDecision,
  type PolicyFn,
} from '../executor/policy/index.ts'
import { catchAll, runtimeBindingsFor, type Runtime } from '../executor/runtime.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionManager } from '../session/manager.ts'
import type { ExecuteOptions } from './types.ts'
import type { Runtimes } from './runtimes.ts'

/**
 * The policy ladder for one typed line: runtime argument, policy,
 * scripts. Mirrors the Python `PolicyRouter` in `workspace/policy.py`.
 *
 * `decide` returns null when nothing decides (no runtime argument, no
 * policy configured) so dispatch falls to the static bindings; a nested
 * eval inherits the typed line's decision and never re-routes.
 */
export class PolicyRouter {
  private readonly registry: MountRegistry
  private readonly runtimes: Runtimes
  private readonly policy: PolicyFn | null
  private readonly sessions: SessionManager
  private readonly agentId: string | null
  private readonly visibleMounts: () => string[]

  constructor(
    registry: MountRegistry,
    runtimes: Runtimes,
    policy: PolicyFn | null,
    sessions: SessionManager,
    agentId: string | null,
    visibleMounts: () => string[],
  ) {
    this.registry = registry
    this.runtimes = runtimes
    this.policy = policy
    this.sessions = sessions
    this.agentId = agentId
    this.visibleMounts = visibleMounts
  }

  async decide(
    root: TSNodeLike,
    command: string,
    options: ExecuteOptions,
  ): Promise<PolicyDecision | null> {
    if (options.routingDecision !== undefined) return options.routingDecision
    if (options.runtime !== undefined) {
      let overlay: Record<string, Runtime>
      try {
        overlay = runtimeBindingsFor(this.runtimes.entries, options.runtime)
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
    const hasScripts = this.runtimes.entries.some((entry) => entry.script !== undefined)
    if (this.policy === null && !hasScripts) return null
    const commands = parsedCommands(root, this.registry.clis.names())
    const sessionId = options.sessionId ?? this.sessions.defaultId
    const session = this.sessions.get(sessionId)
    const ctx: PolicyContext = {
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
    return decideLine(this.runtimes.entries, this.policy, ctx, this.runtimes.bindings)
  }
}
