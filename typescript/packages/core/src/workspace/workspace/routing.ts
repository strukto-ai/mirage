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
  decideLine,
  evaluateScript,
  RouteError,
  type RouteDecision,
} from '../../runtime/routing/index.ts'
import type {
  Ask,
  Claimant,
  CommandContext,
  Deny,
  Pending,
  Route,
  RouteContext,
} from '../../policy/types.ts'
import { opQuestion } from '../../policy/decisions.ts'
import { agreed, settled } from '../../policy/policies.ts'
import type { Runtime } from '../../runtime/base.ts'
import { catchAll, runtimeBindingsFor } from '../../runtime/table.ts'
import { WorkspaceRuntime } from '../../runtime/workspace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Judged, Walked } from '../node/explain.ts'
import type { SessionState } from '../session/session.ts'
import type { ExecuteOptions } from './types.ts'
import type { Runtimes } from './runtimes.ts'
import { makeAbortError } from '../../utils/abort.ts'

/**
 * The policy ladder for one typed line: runtime argument, the placement
 * stage (`preExecute`: the configured route policy as a built-in, then
 * the coded policies), entry scripts. Mirrors the Python `Router` in
 * `workspace/routing.py`.
 *
 * `decide` returns null when nothing decides (no runtime argument,
 * nothing to consult) so dispatch falls to the static bindings, the
 * stage's Deny when a policy refuses the line, and the ledger's answer to
 * its Ask when the host refuses the line or has not answered yet; a
 * nested eval inherits the typed line's decision and never re-routes. The
 * runtime argument is the caller's own placement, so a Route is not asked
 * for and the runtime's own `script:` is not consulted (the caller forces
 * it), but a coded policy's Deny or Ask still holds the line. A runtime a
 * policy names must take the line itself (`validated`). Admission comes
 * first: a line `held` reports refused or waiting on a question is left
 * on the static bindings, unplaced, for the gate to answer. `judged` is
 * the line pass's reading of the line (`lineJudgments`), which gives
 * `preExecute` its commands; awaited only when there is a placement to
 * consult. `claimant` is
 * the line as a whole on its hand-off, so an approval of the line is
 * claimed there like a command's: kept for the retry of a line still
 * waiting on another question, spent when the line ends.
 */
export class Router {
  private readonly registry: MountRegistry
  private readonly runtimes: Runtimes
  private readonly agentId: string | null

  constructor(registry: MountRegistry, runtimes: Runtimes, agentId: string | null) {
    this.registry = registry
    this.runtimes = runtimes
    this.agentId = agentId
  }

  async decide(
    command: string,
    options: ExecuteOptions,
    session: SessionState,
    judged: () => Promise<readonly [Walked, Judged[]][]>,
    held?: () => Promise<boolean>,
    claimant: Claimant | null = null,
    signal?: AbortSignal,
  ): Promise<RouteDecision<Runtime> | Deny | Pending | null> {
    if (options.routingDecision !== undefined) return options.routingDecision
    const policies = this.registry.policies
    const placing = await policies.wantsFor('preExecute', session.sessionId)
    const placed = options.runtime === undefined ? null : this.placed(options.runtime)
    if (placed !== null && !placing) return placed
    const hasScripts = this.runtimes.entries.some((entry) => entry.script !== undefined)
    if (placed === null && !placing && !hasScripts) return null
    if (held !== undefined && (await held())) return placed
    const ctx = this.context(command, options, session, await judged())
    const [said, route] = await policies.preExecute(ctx, placed !== null)
    const action =
      said?.kind === 'ask'
        ? await this.registry.decisions.resolve(...opQuestion(ctx, said), signal, claimant)
        : said
    if (action?.kind === 'abandoned') throw makeAbortError()
    if (action !== null) return action
    if (placed !== null) return placed
    if (route !== null) return this.validated(route.runtime, ctx)
    return this.scripted(ctx)
  }

  /**
   * Every `preExecute` answer for a line and what they decide, without
   * running it: what `explain` shows. An Ask reads the ledger's settled
   * records alone and records nothing. Mirrors Python's
   * `Router.placement`.
   */
  async placement(
    command: string,
    session: SessionState,
    judged: () => Promise<readonly [Walked, Judged[]][]>,
  ): Promise<[readonly (Deny | Ask | Route)[], RouteDecision<Runtime> | Deny | Pending | null]> {
    const policies = this.registry.policies
    const hasScripts = this.runtimes.entries.some((entry) => entry.script !== undefined)
    const placing = await policies.wantsFor('preExecute', session.sessionId)
    if (!hasScripts && !placing) return [[], null]
    const ctx = this.context(command, {}, session, await judged())
    const answers = await policies.answers('preExecute', ctx)
    let winner = settled(answers)
    if (winner?.kind === 'ask') {
      const standing = await this.registry.decisions.held(...opQuestion(ctx, winner))
      if (standing !== null) return [answers, standing]
      winner = agreed(answers.filter((a): a is Route => a.kind === 'route'))
    }
    if (winner?.kind === 'deny') return [answers, winner]
    if (winner?.kind === 'route') {
      const checked = await this.validated(winner.runtime, ctx)
      return 'kind' in checked ? [[...answers, checked], checked] : [answers, checked]
    }
    return [answers, await this.scripted(ctx)]
  }

  /**
   * The decision placing a line on the runtime `name`, once the runtime
   * agrees: its own `script:`, when it has one, must take the line, or
   * the placement and the runtime conflict and the line is refused, as two
   * policies placing it apart refuse it. Mirrors Python's
   * `Router._validated`.
   */
  private async validated(name: string, ctx: RouteContext): Promise<RouteDecision<Runtime> | Deny> {
    const placed = this.placed(name)
    const entries = this.runtimes.entries
    const entry = entries.find((e) => e.name === name)
    if (entry?.script === undefined) return placed
    const willing = await evaluateScript(entry.script, ctx, entry, entries)
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
  private scripted(ctx: RouteContext): Promise<RouteDecision<Runtime>> {
    return decideLine(this.runtimes.entries, ctx)
  }

  /**
   * The runtime entry that serves a command under a decision (the static
   * bindings when there is none), empty when the workspace runs it itself.
   * Mirrors Python's `Router.runtime_for`.
   */
  runtimeFor(command: string, decision: RouteDecision<Runtime> | null): string {
    const bindings: Record<string, Runtime | null> = decision?.bindings ?? this.runtimes.bindings
    const serving = Object.hasOwn(bindings, command)
      ? (bindings[command] ?? null)
      : (decision?.fallback ?? null)
    if (serving === null || serving instanceof WorkspaceRuntime) return ''
    return serving.name
  }

  /** The decision that serves a line on one named runtime: its captures over the static bindings. */
  private placed(name: string): RouteDecision<Runtime> {
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

  /**
   * What `preExecute` sees of one line, and `postExecute` before what came
   * back: the line, every command in it as the gate that runs it will read
   * it, each with the session it would be judged in, and the session, its
   * namespace and its files, which a script reads as plain data too.
   * `judged` is the line pass's reading of the line (`lineJudgments`).
   */
  context(
    command: string,
    options: ExecuteOptions,
    session: SessionState,
    judged: readonly [Walked, Judged[]][],
  ): RouteContext {
    const views = this.registry.policies.views
    const commands: CommandContext[] = []
    for (const [item, explained] of judged) {
      const handles = views?.(item.session.sessionId, item.session) ?? null
      for (const one of explained) {
        if (one.ctx !== undefined) commands.push({ ...one.ctx, ...handles })
      }
    }
    return {
      line: command,
      commands,
      sessionId: session.sessionId,
      agentId: options.agentId ?? this.agentId ?? '',
      ...views?.(session.sessionId, session),
    }
  }
}
