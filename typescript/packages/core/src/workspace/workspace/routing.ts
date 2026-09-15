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
  RouteError,
  type RouteContext,
  type RouteDecision,
  type RoutePolicy,
} from '../../runtime/routing/index.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { MountResolver } from '../../runtime/resolver.ts'
import { catchAll, runtimeBindingsFor } from '../../runtime/table.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { Consumer, lookup } from '../lookup/index.ts'
import type { Session } from '../session/session.ts'
import { envSnapshot } from '../session/state.ts'
import type { ExecuteOptions } from './types.ts'
import type { Runtimes } from './runtimes.ts'

/**
 * The policy ladder for one typed line: runtime argument, policy,
 * scripts. Mirrors the Python `Router` in `workspace/routing.py`.
 *
 * `decide` returns null when nothing decides (no runtime argument, no
 * policy configured) so dispatch falls to the static bindings; a nested
 * eval inherits the typed line's decision and never re-routes.
 */
export class Router {
  private readonly registry: MountRegistry
  private readonly runtimes: Runtimes
  private readonly routePolicy: RoutePolicy | null
  private readonly agentId: string | null
  private readonly resolver: MountResolver

  constructor(
    registry: MountRegistry,
    runtimes: Runtimes,
    routePolicy: RoutePolicy | null,
    agentId: string | null,
    resolver: MountResolver,
  ) {
    this.registry = registry
    this.runtimes = runtimes
    this.routePolicy = routePolicy
    this.agentId = agentId
    this.resolver = resolver
  }

  async decide(
    root: TSNodeLike,
    command: string,
    options: ExecuteOptions,
    session: Session,
  ): Promise<RouteDecision | null> {
    if (options.routingDecision !== undefined) return options.routingDecision
    if (options.runtime !== undefined) {
      let overlay: Record<string, Runtime>
      try {
        overlay = runtimeBindingsFor(this.runtimes.entries, options.runtime)
      } catch (caught) {
        throw new RouteError(caught instanceof Error ? caught.message : String(caught), {
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
    if (this.routePolicy === null && !hasScripts) return null
    const commands = parsedCommands(root, this.registry.clis.names(), (words) =>
      this.registry.matchCommandPrefix(words),
    )
    const externalCommands = commands
      .filter((parsed) => {
        const name = parsed.command
        return (
          !name.includes('/') &&
          !Object.hasOwn(this.runtimes.bindings, name) &&
          lookup(name, session, this.registry) === Consumer.EXTERNAL
        )
      })
      .map((parsed) => parsed.command)
    const ctx: RouteContext = {
      line: command,
      commands,
      command: commands[0]?.command ?? '',
      builtin: commands[0]?.builtin ?? false,
      cwd: options.cwd ?? session.cwd,
      env: { ...envSnapshot(session), ...(options.env ?? {}) },
      sessionId: session.sessionId,
      agentId: options.agentId ?? this.agentId ?? '',
      mounts: this.resolver.prefixes(),
    }
    return decideLine(
      this.runtimes.entries,
      this.routePolicy,
      ctx,
      this.runtimes.bindings,
      externalCommands,
    )
  }
}
