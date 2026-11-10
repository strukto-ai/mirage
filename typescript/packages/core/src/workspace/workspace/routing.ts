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

import { RouteError } from '../../runtime/routing/index.ts'
import type { RouteDecision } from '../../runtime/types.ts'
import type {
  Ask,
  Claimant,
  CommandContext,
  Deny,
  Occurrence,
  Pending,
  Route,
  RouteContext,
} from '../../policy/types.ts'
import { opQuestion, sameOccurrence } from '../../policy/decisions.ts'
import { agreed, commandRoute, settled } from '../../policy/policies.ts'
import type { Runtime } from '../../runtime/base.ts'
import { EXTERNAL_COMMANDS, WHOLE_LINE } from '../../runtime/constants.ts'
import { catchAll, routed, runtimeBindingsFor, wholeLineRuntime } from '../../runtime/table.ts'
import { PathSpec } from '../../types.ts'
import { PROGRAM_WRAPPERS } from '../lookup/constants.ts'
import { mirageProgramAt, routedConsumer, wrapperRunsOutside } from '../lookup/lookup.ts'
import { Consumer } from '../lookup/types.ts'
import { WorkspaceRuntime } from '../../runtime/workspace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { type Judged, refusedWhereItStands, type Walked } from '../node/explain.ts'
import { innerLines, type Word, wordValue } from '../node/inner_lines.ts'
import { argvFrame, wholeOccurrence } from '../node/occurrence.ts'
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
    runsOnMachine?: (
      words: readonly (string | null)[],
      session: SessionState,
      routing: RouteDecision<Runtime>,
    ) => boolean
  }
}

/** The machine a runtime would run a command on under a decision, as its id; empty for the workspace's own. */
function machineOf(runtime: Runtime, decision: RouteDecision<Runtime>): string {
  let machine
  try {
    machine = runtime.machineFor({
      stdin: null,
      flags: {},
      cwd: PathSpec.fromStrPath('/'),
      ...(decision.machine !== undefined ? { machine: decision.machine } : {}),
    })
  } catch (caught) {
    console.debug(`${runtime.name}: no machine to explain:`, caught)
    return ''
  }
  return machine === null ? '' : machine.toString()
}

/** A decision as it places each command on its own, its whole-line runtime left out. Mirrors Python's `_apart`. */
function apart(decision: RouteDecision<Runtime>): RouteDecision<Runtime> {
  const bindings = Object.create(null) as Record<string, Runtime | null>
  for (const [name, runtime] of Object.entries(decision.bindings)) {
    if (name !== WHOLE_LINE) bindings[name] = runtime
  }
  return { ...decision, bindings }
}

/**
 * The judged commands a wrapper's run answers for, as the run walks them: a
 * shell line under the wrapper is the machine's to run, so what it names
 * places nothing.
 */
function wrappedPrograms(
  words: readonly Word[],
  occurrence: Occurrence,
  judged: readonly Judged[],
): Judged[] {
  const [first, ...rest] = words
  if (first === undefined) return []
  const found: Judged[] = []
  for (const inner of innerLines(wordValue(first), rest)) {
    if (inner.argv.length === 0) continue
    const place = wholeOccurrence(argvFrame(inner.argv.map(wordValue), occurrence))
    const held = judged.find((other) => sameOccurrence(other.occurrence, place))
    if (held !== undefined) found.push(held, ...wrappedPrograms(inner.argv, place, judged))
  }
  return found
}

/** The judged commands a wrapper's run answers for; none for any other command. */
function programsOf(one: Judged, judged: readonly Judged[]): Judged[] {
  const command = one.judgment.command
  if (!PROGRAM_WRAPPERS.has(command) || one.ctx === undefined) return []
  return wrappedPrograms(
    [command, ...one.ctx.argv].map((w) => ({ raw: w, text: w })),
    one.occurrence,
    judged,
  )
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
    const placed =
      options.runtime === undefined && options.machine === undefined
        ? null
        : this.placed(options.runtime, options.machine)
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
    if (route !== null) return this.routed(route)
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
    if (winner?.kind === 'route') return [answers, this.routed(winner)]
    return [answers, this.unplaced()]
  }

  /**
   * The decision a policy's route places a line on (`routed`). Mirrors
   * Python's `Router._routed`.
   *
   * Throws:
   *   RouteError: no entry or machine has the name.
   */
  private routed(route: Route): RouteDecision<Runtime> {
    this.knownMachine(route.machine)
    try {
      return routed(
        this.runtimes.entries,
        this.registry.runtimeBindings,
        route.runtime,
        route.machine,
      )
    } catch (caught) {
      throw new RouteError(caught instanceof Error ? caught.message : String(caught), {
        cause: caught,
      })
    }
  }

  /**
   * Refuse a machine the workspace does not have.
   *
   * Throws:
   *   RouteError: no machine has the name.
   */
  private knownMachine(machine: string | undefined): void {
    if (machine === undefined) return
    try {
      this.runtimes.machines.get(machine)
    } catch (caught) {
      throw new RouteError(caught instanceof Error ? caught.message : String(caught), {
        cause: caught,
      })
    }
  }

  /**
   * The decision for a line no policy placed: each command on its first
   * capturer, kept for the line's nested evals. Mirrors Python's
   * `Router._unplaced`.
   */
  unplaced(): RouteDecision<Runtime> {
    return {
      bindings: Object.assign(
        Object.create(null) as Record<string, Runtime | null>,
        this.registry.runtimeBindings,
      ),
      fallback: catchAll(this.runtimes.entries),
    }
  }

  /**
   * The runtime entry that serves a command under a decision, as its run
   * places it, and the machine it runs there on: the `@external` runtime
   * for a program no name binds (a path runs through the workspace's exec
   * path first); both empty when the workspace runs it itself. A
   * `preCommand` route of the command places it over the line's decision,
   * as its run does, and so does the route of a program a wrapper takes
   * along to a runtime (`programs`, the commands its run answers for,
   * outermost first).
   * Mirrors Python's `Router.placement_for`.
   */
  placementFor(
    one: Judged,
    line: RouteDecision<Runtime>,
    programs: readonly Judged[] = [],
  ): [string, string] {
    const whole = wholeLineRuntime(line.bindings)
    if (whole !== null) return [whole.name, machineOf(whole, line)]
    const placed = this.ownPlaced(one, line)
    const answer = this.wrapperAnswer(one, placed, programs)
    if (answer?.kind !== 'route') return this.serving(one, placed)
    return this.serving(
      one,
      routed(
        this.runtimes.entries,
        placed.bindings,
        answer.runtime,
        answer.machine ?? placed.machine,
      ),
    )
  }

  /** A decision with a command's own `preCommand` route over it. */
  private ownPlaced(one: Judged, line: RouteDecision<Runtime>): RouteDecision<Runtime> {
    const route = commandRoute(one.judgment.answers)
    if (route === null) return line
    return routed(
      this.runtimes.entries,
      line.bindings,
      route.runtime,
      route.machine ?? line.machine,
    )
  }

  /**
   * What the routes answering for a wrapper a runtime takes and for the
   * programs its run judges come to, as its run settles them; null for any
   * other command. Mirrors Python's `Router._wrapper_answer`.
   */
  private wrapperAnswer(
    one: Judged,
    placed: RouteDecision<Runtime>,
    programs: readonly Judged[],
  ): Deny | Route | null {
    if (
      one.ctx === undefined ||
      one.session === undefined ||
      !wrapperRunsOutside(one.judgment.command, one.ctx.argv, one.session, this.registry, placed)
    ) {
      return null
    }
    return agreed(
      [one, ...programs]
        .map((held) => commandRoute(held.judgment.answers))
        .filter((route): route is Route => route !== null),
    )
  }

  /**
   * The placement a command runs under: its line's, with the route of each
   * command running it (`eval`) over that, as its run keeps it.
   */
  private outerPlaced(
    one: Judged,
    judged: readonly Judged[],
    decision: RouteDecision<Runtime>,
  ): RouteDecision<Runtime> {
    const outer: Judged[] = []
    for (let at = one.occurrence.parent; at !== null; at = at.parent) {
      const place = at
      const held = judged.find((other) => sameOccurrence(other.occurrence, place))
      if (held !== undefined) outer.push(held)
    }
    return outer.reverse().reduce((line, held) => this.ownPlaced(held, line), decision)
  }

  /**
   * A line's judged commands, each wrapper whose routes one run cannot honor
   * refused at its own node, as its run refuses it. A wrapper or program its
   * gate stops keeps that answer: the run stops there before it compares
   * routes. Mirrors Python's `Router.refuse_disagreeing`.
   */
  refuseDisagreeing(judged: readonly Judged[], decision: RouteDecision<Runtime>): Judged[] {
    return judged.map((one) => {
      const programs = programsOf(one, judged)
      if (programs.length === 0) return one
      if ([one, ...programs].some((held) => held.judgment.exitCode !== 0)) return one
      const answer = this.wrapperAnswer(
        one,
        this.ownPlaced(one, this.outerPlaced(one, judged, decision)),
        programs,
      )
      return answer?.kind === 'deny' ? refusedWhereItStands(one, answer) : one
    })
  }

  /**
   * `placementFor` for each of a line's judged commands, one a line runs in
   * turn (`eval`) under the placement a `preCommand` route gave the command
   * running it, as its run keeps it. Mirrors Python's `Router.placements`.
   */
  placements(
    judged: readonly Judged[],
    decision: RouteDecision<Runtime>,
  ): (one: Judged) => [string, string] {
    return (one) =>
      this.placementFor(one, this.outerPlaced(one, judged, decision), programsOf(one, judged))
  }

  /**
   * Whether a command's `preCommand` route places it off the runtime or
   * machine its line runs whole on, which that one run cannot honor: a
   * route that leaves the command where it stands (a runtime that does not
   * capture it) holds. Throws a `RouteError` for a route that names no
   * runtime entry. Mirrors Python's `Router.off_line`.
   */
  offLine(one: Judged, decision: RouteDecision<Runtime>): boolean {
    const route = commandRoute(one.judgment.answers)
    const whole = wholeLineRuntime(decision.bindings)
    if (route === null || whole === null) return false
    let placed: RouteDecision<Runtime>
    try {
      placed = routed(
        this.runtimes.entries,
        decision.bindings,
        route.runtime,
        route.machine ?? decision.machine,
      )
    } catch (caught) {
      throw new RouteError(caught instanceof Error ? caught.message : String(caught), {
        cause: caught,
      })
    }
    const [runtime, machine] = this.serving(one, apart(placed))
    const [lineRuntime, lineMachine] = this.serving(one, apart(decision))
    return (
      wholeLineRuntime(placed.bindings) !== whole ||
      machineOf(whole, placed) !== machineOf(whole, decision) ||
      runtime !== lineRuntime ||
      machine !== lineMachine
    )
  }

  /**
   * The runtime entry and machine that serve a command under a decision
   * that places each command on its own, as `placementFor` answers them.
   * Mirrors Python's `Router._serving`.
   */
  private serving(one: Judged, placed: RouteDecision<Runtime>): [string, string] {
    const command = one.judgment.command
    let decision = placed
    let fallback = placed.fallback
    if (one.ctx !== undefined && one.session !== undefined) {
      if (mirageProgramAt(command, one.ctx.argv, one.session, this.registry, placed) !== null) {
        return ['', '']
      }
      const [consumer, rerouted] = routedConsumer(
        command,
        one.ctx.argv,
        one.session,
        this.registry,
        placed,
      )
      decision = rerouted ?? placed
      if (consumer === Consumer.EXTERNAL && !command.includes('/')) {
        fallback = Object.hasOwn(decision.bindings, EXTERNAL_COMMANDS)
          ? (decision.bindings[EXTERNAL_COMMANDS] ?? null)
          : null
      }
    }
    const serving = Object.hasOwn(decision.bindings, command)
      ? (decision.bindings[command] ?? null)
      : fallback
    if (serving === null || serving instanceof WorkspaceRuntime) return ['', '']
    return [serving.name, machineOf(serving, decision)]
  }

  /**
   * The decision that serves a line on one named runtime, its captures over
   * the static bindings, on one named machine; no runtime leaves each
   * command on its first capturer.
   *
   * Throws:
   *   RouteError: no entry or machine has the name, or the runtime cannot be selected.
   */
  private placed(name: string | undefined, machine: string | undefined): RouteDecision<Runtime> {
    this.knownMachine(machine)
    let overlay: Record<string, Runtime>
    try {
      overlay = name === undefined ? {} : runtimeBindingsFor(this.runtimes.entries, name)
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
      ...(machine !== undefined ? { machine } : {}),
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
