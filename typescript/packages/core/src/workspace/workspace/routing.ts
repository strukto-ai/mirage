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
  evaluateScript,
  RouteError,
  type RouteContext,
  type RouteDecision,
} from '../../runtime/routing/index.ts'
import type { ParsedCommand } from '../../runtime/routing/types.ts'
import type { Deny, Route } from '../../policy/types.ts'
import { settled } from '../../policy/policies.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { MountResolver } from '../../runtime/resolver.ts'
import { WorkspaceRuntime, catchAll, runtimeBindingsFor } from '../../runtime/table.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { Consumer, lookup } from '../lookup/index.ts'
import type { SessionState } from '../session/session.ts'
import { envSnapshot } from '../session/state.ts'
import type { ExecuteOptions } from './types.ts'
import type { Runtimes } from './runtimes.ts'

/**
 * The policy ladder for one typed line: runtime argument, the placement
 * stage (`preExecute`: the configured route policy as a built-in, then
 * the coded policies), entry scripts. Mirrors the Python `Router` in
 * `workspace/routing.py`.
 *
 * `decide` returns null when nothing decides (no runtime argument,
 * nothing to consult) so dispatch falls to the static bindings, and the
 * stage's Deny when a placing policy refuses the line; a nested eval
 * inherits the typed line's decision and never re-routes. The runtime
 * argument is the caller's own placement, so a Route is not asked for and
 * the runtime's own `script:` is not consulted (the caller forces it), but
 * a coded policy's Deny still refuses the line. A runtime a policy names
 * must take the line itself (`validated`). Admission comes first: a line `held` reports refused or waiting on a question is left
 * on the static bindings, unplaced, for the gate to answer.
 */
export class Router {
  private readonly registry: MountRegistry
  private readonly runtimes: Runtimes
  private readonly agentId: string | null
  private readonly resolver: MountResolver

  constructor(
    registry: MountRegistry,
    runtimes: Runtimes,
    agentId: string | null,
    resolver: MountResolver,
  ) {
    this.registry = registry
    this.runtimes = runtimes
    this.agentId = agentId
    this.resolver = resolver
  }

  async decide(
    root: TSNodeLike,
    command: string,
    options: ExecuteOptions,
    session: SessionState,
    held?: () => Promise<boolean>,
  ): Promise<RouteDecision | Deny | null> {
    if (options.routingDecision !== undefined) return options.routingDecision
    const policies = this.registry.policies
    const placing = policies.wants('preExecute')
    if (options.runtime !== undefined) {
      const placed = this.placed(options.runtime)
      if (!placing || (held !== undefined && (await held()))) return placed
      const said = await policies.preExecute(this.context(root, command, options, session), true)
      return said?.kind === 'deny' ? said : placed
    }
    const hasScripts = this.runtimes.entries.some((entry) => entry.script !== undefined)
    if (!placing && !hasScripts) return null
    if (held !== undefined && (await held())) return null
    const ctx = this.context(root, command, options, session)
    const said = await policies.preExecute(ctx)
    if (said?.kind === 'deny') return said
    if (said?.kind === 'route') return this.validated(said.runtime, ctx, session)
    return this.scripted(ctx, session)
  }

  /**
   * Every placement answer for a line and what they decide, without
   * running it: what `explain` shows. Mirrors Python's
   * `Router.placement`.
   */
  async placement(
    root: TSNodeLike,
    command: string,
    session: SessionState,
  ): Promise<[readonly (Deny | Route)[], RouteDecision | Deny | null]> {
    const policies = this.registry.policies
    const hasScripts = this.runtimes.entries.some((entry) => entry.script !== undefined)
    if (!hasScripts && !policies.wants('preExecute')) return [[], null]
    const ctx = this.context(root, command, {}, session)
    const said = await policies.answers('preExecute', ctx)
    const answers = said.filter((a): a is Deny | Route => a.kind !== 'ask')
    const winner = settled(answers)
    if (winner?.kind === 'deny') return [answers, winner]
    if (winner?.kind === 'route') {
      const checked = await this.validated(winner.runtime, ctx, session)
      return 'kind' in checked ? [[...answers, checked], checked] : [answers, checked]
    }
    return [answers, await this.scripted(ctx, session)]
  }

  /**
   * The decision placing a line on the runtime `name`, once the runtime
   * agrees: its own `script:`, when it has one, must take the line, or
   * the placement and the runtime conflict and the line is refused, as two
   * policies placing it apart refuse it. Mirrors Python's
   * `Router._validated`.
   */
  private async validated(
    name: string,
    ctx: RouteContext,
    session: SessionState,
  ): Promise<RouteDecision | Deny> {
    const placed = this.placed(name)
    const entries = this.runtimes.entries
    const entry = entries.find((e) => e.name === name)
    if (entry?.script === undefined) return placed
    const willing = await evaluateScript(
      entry.script,
      ctx,
      entry,
      entries,
      this.external(ctx.commands, session),
    )
    if (willing) return placed
    return {
      kind: 'deny',
      reason: `runtime ${name} declines this line`,
      policy: `runtimes.${name}`,
    }
  }

  /**
   * The entry scripts' decision, for a line no policy placed: each
   * runtime's `script:` says whether it takes the line. Mirrors Python's
   * `Router._scripted`.
   */
  private scripted(ctx: RouteContext, session: SessionState): Promise<RouteDecision> {
    return decideLine(
      this.runtimes.entries,
      null,
      ctx,
      this.runtimes.bindings,
      this.external(ctx.commands, session),
    )
  }

  /**
   * The runtime entry that serves a command under a decision (the static
   * bindings when there is none), empty when the workspace runs it itself.
   * Mirrors Python's `Router.runtime_for`.
   */
  runtimeFor(command: string, decision: RouteDecision | null): string {
    const bindings: Record<string, Runtime | null> = decision?.bindings ?? this.runtimes.bindings
    const serving = Object.hasOwn(bindings, command)
      ? (bindings[command] ?? null)
      : (decision?.fallback ?? null)
    if (serving === null || serving instanceof WorkspaceRuntime) return ''
    return serving.name
  }

  /** The decision that serves a line on one named runtime: its captures over the static bindings. */
  private placed(name: string): RouteDecision {
    let overlay: Record<string, Runtime>
    try {
      overlay = runtimeBindingsFor(this.runtimes.entries, name)
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

  /** The stages workspace lookup leaves to the external fallback. */
  private external(commands: readonly ParsedCommand[], session: SessionState): string[] {
    return commands
      .filter((parsed) => {
        const name = parsed.command
        return (
          !name.includes('/') &&
          !Object.hasOwn(this.runtimes.bindings, name) &&
          lookup(name, session, this.registry) === Consumer.EXTERNAL
        )
      })
      .map((parsed) => parsed.command)
  }

  /** The placement stage's payload for one line, the one a route policy has always read. */
  private context(
    root: TSNodeLike,
    command: string,
    options: ExecuteOptions,
    session: SessionState,
  ): RouteContext {
    const commands = parsedCommands(root, this.registry.clis.names(), (words) =>
      this.registry.matchCommandPrefix(words),
    )
    return {
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
  }
}
