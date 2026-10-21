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

import { RouteError, type RouteDecision } from '../../runtime/routing/index.ts'
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
import { bindCommands, catchAll, runtimeBindingsFor } from '../../runtime/table.ts'
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
 * the coded policies), then each command's first capturer. Mirrors the
 * Python `Router` in `workspace/routing.py`.
 *
 * `decide` returns the static bindings as the decision when nothing
 * decides (no runtime argument, nothing to consult), the stage's Deny when
 * a policy refuses the line, and the ledger's answer to its Ask when the
 * host refuses the line or has not answered yet; a nested eval inherits
 * the typed line's decision and never re-routes. The runtime argument is
 * the caller's own placement, so a Route is not asked for, but a coded
 * policy's Deny or Ask still holds the line. Admission comes first: a line
 * `held` reports refused or waiting on a question is left unplaced, for
 * the gate to answer. `judged` is
 * the line pass's reading of the line (`lineJudgments`), which gives
 * `preExecute` its commands; awaited only when there is a placement to
 * consult. `claimant` is
 * the line as a whole on its hand-off, so an approval of the line is
 * claimed there like a command's: kept for the retry of a line still
 * waiting on another question, spent when the line ends.
 */
// The line's decision rides its evaluation's frame, which the walker
// reads per command and a child evaluation forks with it: nested lines
// never re-route. Declared here, where the decision is made, so the
// frame's module imports no runtime.
declare module '../frame.ts' {
  interface ExecutionFrame {
    routing?: RouteDecision<Runtime>
  }
}

export class Router {
  private readonly registry: MountRegistry
  private readonly runtimes: Runtimes

  constructor(registry: MountRegistry, runtimes: Runtimes) {
    this.registry = registry
    this.runtimes = runtimes
  }

  async decide(
    command: string,
    options: ExecuteOptions,
    session: SessionState,
    judged: () => Promise<readonly [Walked, Judged[]][]>,
    held?: () => Promise<boolean>,
    claimant: Claimant | null = null,
    signal?: AbortSignal,
  ): Promise<RouteDecision<Runtime> | Deny | Pending> {
    if (options.routingDecision !== undefined) return options.routingDecision
    const policies = this.registry.policies
    const placing = await policies.wantsFor('preExecute', session.sessionId)
    const placed = options.runtime === undefined ? null : this.placed(options.runtime)
    if (!placing || (held !== undefined && (await held()))) return placed ?? this.unplaced()
    const ctx = this.context(command, session, await judged())
    const [said, route] = await policies.preExecute(ctx, placed !== null)
    const action =
      said?.kind === 'ask'
        ? await this.registry.decisions.resolve(...opQuestion(ctx, said), signal, claimant)
        : said
    if (action?.kind === 'abandoned') throw makeAbortError()
    if (action !== null) return action
    if (placed !== null) return placed
    if (route !== null) return this.routed(route.runtime)
    return this.unplaced()
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
  ): Promise<[readonly (Deny | Ask | Route)[], RouteDecision<Runtime> | Deny | Pending]> {
    const policies = this.registry.policies
    const placing = await policies.wantsFor('preExecute', session.sessionId)
    if (!placing) return [[], this.unplaced()]
    const ctx = this.context(command, session, await judged())
    const answers = await policies.answers('preExecute', ctx)
    let winner = settled(answers)
    if (winner?.kind === 'ask') {
      const standing = await this.registry.decisions.held(...opQuestion(ctx, winner))
      if (standing !== null) return [answers, standing]
      winner = agreed(answers.filter((a): a is Route => a.kind === 'route'))
    }
    if (winner?.kind === 'deny') return [answers, winner]
    if (winner?.kind === 'route') return [answers, this.routed(winner.runtime)]
    return [answers, this.unplaced()]
  }

  /**
   * The decision a policy's route places a line on. `workspace` keeps the
   * line in Mirage: no line executor (a `*` capture) takes it, and each
   * command stays on its first other capturer. Any other name places it as
   * the runtime argument does. Mirrors Python's `Router._routed`.
   */
  private routed(name: string): RouteDecision<Runtime> {
    if (name !== 'workspace') return this.placed(name)
    const entries = this.runtimes.entries
    const kept = entries.filter((entry) => !entry.captures.includes('*'))
    // Null prototype: captures are arbitrary command names.
    const bindings = Object.create(null) as Record<string, Runtime | null>
    for (const entry of entries) {
      for (const command of entry.captures) bindings[command] = null
    }
    Object.assign(bindings, bindCommands(kept))
    return { bindings, fallback: catchAll(entries) }
  }

  /**
   * The decision for a line no policy placed: each command on its first
   * capturer, kept for the line's nested evals. Mirrors Python's
   * `Router._unplaced`.
   */
  private unplaced(): RouteDecision<Runtime> {
    return {
      bindings: Object.assign(
        Object.create(null) as Record<string, Runtime | null>,
        this.registry.runtimeBindings,
      ),
      fallback: catchAll(this.runtimes.entries),
    }
  }

  /**
   * The runtime entry that serves a command under a decision, empty when
   * the workspace runs it itself. Mirrors Python's `Router.runtime_for`.
   */
  runtimeFor(command: string, decision: RouteDecision<Runtime>): string {
    const serving = Object.hasOwn(decision.bindings, command)
      ? (decision.bindings[command] ?? null)
      : decision.fallback
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
        this.registry.runtimeBindings,
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
    session: SessionState,
    judged: readonly [Walked, Judged[]][],
  ): RouteContext {
    const views = this.registry.policies.views
    const commands: CommandContext[] = []
    for (const [item, explained] of judged) {
      for (const one of explained) {
        if (one.ctx === undefined) continue
        const walked = one.session ?? item.session
        commands.push({ ...one.ctx, ...views?.(walked.sessionId, walked) })
      }
    }
    return {
      line: command,
      commands,
      sessionId: session.sessionId,
      ...views?.(session.sessionId, session),
    }
  }
}
