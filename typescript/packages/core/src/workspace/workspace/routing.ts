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
  Pending,
  Route,
  RouteContext,
} from '../../policy/types.ts'
import { opQuestion } from '../../policy/decisions.ts'
import { agreed, settled } from '../../policy/policies.ts'
import type { Runtime } from '../../runtime/base.ts'
import { EXTERNAL_COMMANDS, WHOLE_LINE } from '../../runtime/constants.ts'
import {
  bindCommands,
  catchAll,
  runtimeBindingsFor,
  servesWorkspace,
  wholeLineRuntime,
} from '../../runtime/table.ts'
import { WorkspaceRuntime } from '../../runtime/workspace.ts'
import { fsError } from '../../errors/fs.ts'
import { startsAJob } from '../../shell/helpers.ts'
import { parameterReads } from '../../shell/parse/env.ts'
import { commandWords, inheritedReads } from '../../shell/parse/names.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { VarAttr } from '../../shell/variable.ts'
import { CycleError, resolvePath } from '../../utils/path.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { expandingAliases } from '../executor/builtins/alias/alias.ts'
import { FRESH_SHELL_NAMES, INTERPRETER_NAMES, WORKSPACE_JOB_WORDS } from '../lookup/constants.ts'
import { Consumer } from '../lookup/types.ts'
import { interpreterScript, invocationRouting } from '../executor/command/routing.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Judged, Walked } from '../node/explain.ts'
import type { SessionState } from '../session/session.ts'
import type { ExecuteOptions } from './types.ts'
import type { Runtimes } from './runtimes.ts'
import { lookup, mayRunProgram } from '../lookup/lookup.ts'
import { makeAbortError } from '../../utils/abort.ts'

/**
 * The policy ladder for one typed line: runtime argument, the placement
 * stage (`preExecute`: the configured route policy as a built-in, then
 * the coded policies), then the sandbox default (`defaulted`: a line
 * needing a sandbox's own files whole on it), then each command's first
 * capturer, an interpreter a sandbox took kept off it where one invocation
 * cannot run there (`RouteDecision.unserved`).
 * Mirrors the Python `Router` in `workspace/routing.py`. `ast`, the parsed
 * line, is what the default reads; absent leaves it out, in `decide` and
 * in `placement` alike.
 *
 * `decide` returns the sandbox default's decision or refusal when nothing
 * else decides (`defaulted`), the static bindings when that default does
 * not apply either, the stage's Deny when
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

// Where the router's debug lines go: unset by default, so it logs nothing.
export const logger: { debug?: (message: string) => void } = {}

export class Router {
  private readonly registry: MountRegistry
  private readonly runtimes: Runtimes
  private readonly namespace: Namespace

  /**
   * @param registry carries the resolved static bindings.
   * @param runtimes the ordered runtime entries.
   * @param namespace the links a path the line names follows.
   */
  constructor(registry: MountRegistry, runtimes: Runtimes, namespace: Namespace) {
    this.registry = registry
    this.runtimes = runtimes
    this.namespace = namespace
  }

  async decide(
    command: string,
    options: ExecuteOptions,
    session: SessionState,
    judged: () => Promise<readonly [Walked, Judged[]][]>,
    held?: () => Promise<boolean>,
    claimant: Claimant | null = null,
    signal?: AbortSignal,
    ast?: TSNodeLike,
  ): Promise<RouteDecision<Runtime> | Deny | Pending> {
    if (options.routingDecision !== undefined) return options.routingDecision
    if (options.runtime === undefined) await this.learnPrograms(command, ast)
    const policies = this.registry.policies
    const placing = await policies.wantsFor('preExecute', session.sessionId)
    const placed = options.runtime === undefined ? null : this.placed(options.runtime)
    if (!placing && placed === null && this.sandbox() !== null) {
      if (held !== undefined && (await held())) return this.unplaced()
      return await this.defaulted(session, ast, judged)
    }
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
    return await this.defaulted(session, ast, judged)
  }

  /**
   * Ask each box that has not said which interpreters it holds, the first
   * time a line may run one, and bind what it holds.
   *
   * A typed line decides its own placement after this, so it already runs
   * where the answer puts its interpreters. The ask is the probe alone:
   * nothing of the line reaches the box, so it comes before the line's
   * admission. `explain` never asks. Mirrors Python's
   * `Router._learn_programs`.
   *
   * @param command the raw command line.
   * @param ast the parsed line, whose command heads say whether it runs a
   *   path; undefined for none.
   */
  private async learnPrograms(command: string, ast: TSNodeLike | undefined): Promise<void> {
    const pending = this.runtimes.entries.filter((entry) => entry.programsPending)
    if (pending.length === 0) return
    const heads = ast === undefined ? new Set<string>() : commandWords(ast)
    if (!mayRunProgram(command, heads)) return
    for (const entry of pending) await entry.probePrograms()
    this.runtimes.rebind()
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
    ast?: TSNodeLike,
  ): Promise<[readonly (Deny | Ask | Route)[], RouteDecision<Runtime> | Deny | Pending]> {
    const policies = this.registry.policies
    const placing = await policies.wantsFor('preExecute', session.sessionId)
    if (!placing) return [[], await this.defaulted(session, ast, judged)]
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
    return [answers, await this.defaulted(session, ast, judged)]
  }

  /**
   * The sandbox the default sends a line to whole: the runtime `@external`
   * binds, when it serves the workspace (`servesWorkspace`), no
   * `routePolicy` decides placement and no runtime takes every line
   * (`@line`). Null otherwise, and then lines place as they always have.
   * Mirrors Python's `Router._sandbox`.
   */
  private sandbox(): Runtime | null {
    const bindings = this.registry.runtimeBindings
    if (this.registry.policies.hasPlacement || wholeLineRuntime(bindings) !== null) return null
    const box = Object.hasOwn(bindings, EXTERNAL_COMMANDS) ? bindings[EXTERNAL_COMMANDS] : undefined
    return box !== undefined && servesWorkspace(box) ? box : null
  }

  /**
   * The decision for a line nothing else placed: whole on the sandbox when
   * it needs the sandbox's own files (`whole`), else each command on its
   * first capturer (`unplaced`). Mirrors Python's `Router._defaulted`.
   *
   * @param session the effective session.
   * @param ast the parsed line; undefined for none.
   * @param judged the line pass's reading of the line.
   */
  private async defaulted(
    session: SessionState,
    ast: TSNodeLike | undefined,
    judged: () => Promise<readonly [Walked, Judged[]][]>,
  ): Promise<RouteDecision<Runtime> | Deny> {
    const box = this.sandbox()
    if (ast === undefined || box === null) return this.unplaced()
    return (await this.whole(box, session, ast, await judged())) ?? this.unplaced()
  }

  /**
   * The line whole on the sandbox, when it runs a program there and Mirage
   * would resolve one of its paths to the sandbox's own files; a refusal
   * when running it whole would change what it means; null to place it as
   * usual.
   *
   * The paths are the ones Mirage itself resolves: a Mirage command's
   * operands (the program a wrapper runs, not the wrapper's), a redirect
   * target, a `cd` target. A program's own words resolve in the sandbox
   * either way. Mirrors Python's `Router._whole`.
   *
   * @param box the sandbox (`sandbox`).
   * @param session the effective session.
   * @param ast the parsed line.
   * @param items the line pass's reading of the line.
   */
  private async whole(
    box: Runtime,
    session: SessionState,
    ast: TSNodeLike,
    items: readonly [Walked, Judged[]][],
  ): Promise<RouteDecision<Runtime> | Deny | null> {
    const bindings = this.registry.runtimeBindings
    let program = false
    const mirage: string[] = []
    const unexecutable: string[] = []
    const paths: [string, SessionState][] = []
    for (const [walked, explained] of items) {
      const named = explained.flatMap((one) =>
        one.ctx === undefined ? [] : [{ ctx: one.ctx, stand: one.session ?? walked.session }],
      )
      let consumer: Consumer | null = null
      for (const { ctx, stand } of named) {
        const name = ctx.command
        consumer = lookup(name, stand, this.registry)
        if (INTERPRETER_NAMES.has(name) && !WORKSPACE_ONLY.has(consumer)) {
          const refused = this.execRefused(ctx)
          if (refused !== null) unexecutable.push(refused)
        }
        if (consumer === Consumer.EXTERNAL) {
          const runs = Object.hasOwn(bindings, name) ? bindings[name] : bindings[EXTERNAL_COMMANDS]
          program ||= runs === box
          if (name.includes('/')) {
            const target = resolvePath(name, stand.cwd)
            if (!this.registry.execAllowedAt(target))
              unexecutable.push(`${target} is not in EXEC mode`)
          }
        } else if (
          WORKSPACE_ONLY.has(consumer) ||
          (consumer === Consumer.SESSION && WORKSPACE_JOB_WORDS.has(name))
        ) {
          mirage.push(name)
        }
      }
      const last = named.at(-1)
      if (last === undefined) continue
      if (consumer === Consumer.EXTERNAL) {
        for (const word of walked.redirects) {
          if (word.text !== null && word.text !== '')
            paths.push([resolvePath(word.text, last.stand.cwd), last.stand])
        }
      } else {
        for (const path of last.ctx.paths) paths.push([path.virtual, last.stand])
      }
    }
    if (!program) return null
    const outside: string[] = []
    const held: string[] = []
    for (const [path, stand] of paths) {
      const place = await this.place(this.followed(path, stand))
      if (place === 'sandbox') outside.push(path)
      else if (place === 'held') held.push(path)
    }
    const first = outside[0]
    if (first === undefined) return null
    const reason = wholeRefusal(session, ast, mirage, held, unexecutable, first)
    if (reason !== null)
      return { kind: 'deny', reason, policy: 'sandbox', error: fsError(first, 'EPERM', reason) }
    return {
      bindings: Object.assign(Object.create(null) as Record<string, Runtime | null>, bindings, {
        [WHOLE_LINE]: box,
      }),
      fallback: catchAll(this.runtimes.entries),
    }
  }

  /**
   * `path` with the links Mirage holds followed, as the session sees them;
   * as named when they loop. Mirrors Python's `Router._followed`.
   *
   * @param path an absolute virtual path.
   * @param session the session the path is named in.
   */
  private followed(path: string, session: SessionState): string {
    try {
      return this.namespace.sessionLinks(session).follow(path)
    } catch (caught) {
      if (!(caught instanceof CycleError)) throw caught
      logger.debug?.(`${path}: links loop; judged as named: ${String(caught)}`)
      return path
    }
  }

  /**
   * Whose a path Mirage resolves is: the sandbox's own when it is on no
   * mount or on the workspace's scratch root where Mirage holds nothing at
   * it; Mirage's alone (`held`) where Mirage holds a file there; the
   * workspace's otherwise. `/` and a directory holding mounts are the
   * workspace's. Mirrors Python's `Router._place`.
   *
   * @param path an absolute virtual path, its links followed.
   */
  private async place(path: string): Promise<'workspace' | 'held' | 'sandbox'> {
    const holding = `${rstripSlash(path)}/`
    if (path === '/' || this.registry.allMounts().some((m) => m.prefix.startsWith(holding)))
      return 'workspace'
    const mount = this.registry.tryMountFor(path)
    if (mount === null) return 'sandbox'
    if (!this.registry.isAnchor(mount)) return 'workspace'
    const [vfs, spec] = this.registry.resolve(path)
    return (await vfs.exists(spec)) ? 'held' : 'sandbox'
  }

  /**
   * Why the mounts' exec rule refuses the program an interpreter command
   * runs, null when it may run: its script's mount is not in EXEC mode, or
   * for inline code (`-c`, `-m`, `-e`, stdin) no mount is, as `execRefusal`
   * judges it on Monty. Mirrors Python's `Router._exec_refused`.
   *
   * @param ctx the interpreter command.
   */
  private execRefused(ctx: CommandContext): string | null {
    const script = interpreterScript(ctx.command, ctx.argv, ctx.cwd)
    if (script !== null) {
      if (this.registry.execAllowedAt(script.virtual)) return null
      return `${script.virtual} is not in EXEC mode`
    }
    if (this.registry.isExecAllowed()) return null
    return 'no mount is in EXEC mode'
  }

  /**
   * The decision a policy's route places a line on. `workspace` keeps the
   * line in Mirage: no line executor (an `@line` capture) takes it, an
   * interpreter a sandbox took (`Runtime.learned`) goes back to the runtime
   * that captures it, and each command stays on its first other capturer.
   * Any other name places it as the runtime argument does. Mirrors Python's
   * `Router._routed`.
   */
  private routed(name: string): RouteDecision<Runtime> {
    if (name !== 'workspace') return this.placed(name)
    const entries = this.runtimes.entries
    const kept = entries.filter((entry) => !entry.captures.includes(WHOLE_LINE))
    // Null prototype: captures are arbitrary command names.
    const bindings = Object.create(null) as Record<string, Runtime | null>
    for (const entry of entries) {
      for (const command of entry.offeredCaptures) bindings[command] = null
    }
    Object.assign(bindings, bindCommands(kept))
    const own = captured(kept)
    for (const [name, runtime] of Object.entries(bindings)) {
      if (learned(runtime, name)) bindings[name] = own.get(name) ?? null
    }
    return { bindings, fallback: catchAll(entries) }
  }

  /**
   * The decision for a line no policy placed: each command on its first
   * capturer, kept for the line's nested evals, and each interpreter a
   * sandbox took on the first runtime that captures it for an invocation
   * that sandbox cannot see (`unserved`). Mirrors Python's
   * `Router._unplaced`.
   */
  private unplaced(): RouteDecision<Runtime> {
    const bindings = this.registry.runtimeBindings
    const own = captured(this.runtimes.entries)
    const unserved = Object.create(null) as Record<string, Runtime | null>
    for (const name of INTERPRETER_NAMES) {
      const runtime = own.get(name)
      if (
        runtime !== undefined &&
        learned(Object.hasOwn(bindings, name) ? bindings[name] : null, name)
      )
        unserved[name] = runtime
    }
    return {
      bindings: Object.assign(Object.create(null) as Record<string, Runtime | null>, bindings),
      fallback: catchAll(this.runtimes.entries),
      unserved,
    }
  }

  /**
   * The runtime entry that serves a command under a decision, empty when
   * the workspace runs it itself; judged per invocation
   * (`invocationRouting`), as its run will be. Mirrors Python's
   * `Router.runtime_for`.
   *
   * @param one the command's judgment and context.
   * @param decision the line's placement.
   */
  runtimeFor(one: Judged, decision: RouteDecision<Runtime>): string {
    const whole = wholeLineRuntime(decision.bindings)
    if (whole !== null) return whole.name
    const command = one.judgment.command
    const routed =
      one.ctx === undefined
        ? decision
        : (invocationRouting(
            command,
            one.ctx.argv,
            one.ctx.cwd,
            this.registry,
            decision,
            this.namespace.sessionLinks(one.session ?? null),
          ) ?? decision)
    const serving = Object.hasOwn(routed.bindings, command)
      ? (routed.bindings[command] ?? null)
      : routed.fallback
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

// What only Mirage runs: a sandbox running the line would not find it.
const WORKSPACE_ONLY: ReadonlySet<Consumer> = new Set([
  Consumer.CLI,
  Consumer.FUNCTION,
  Consumer.NAMESPACE,
])

/**
 * Each command on the first entry whose own captures name it, none an entry
 * only learned it can run (`Runtime.learned`). Mirrors Python's
 * `_captured`.
 *
 * @param entries ordered runtimes.
 */
function captured(entries: readonly Runtime[]): Map<string, Runtime> {
  const out = new Map<string, Runtime>()
  for (const entry of entries) {
    for (const command of entry.captures) if (!out.has(command)) out.set(command, entry)
  }
  return out
}

/**
 * Whether `name` binds to a runtime that learned it can run it
 * (`Runtime.learned`), a sandbox holding the interpreter. Mirrors Python's
 * `_learned`.
 *
 * @param runtime the runtime `name` binds to.
 * @param name the command name.
 */
function learned(runtime: Runtime | null | undefined, name: string): boolean {
  return runtime?.learned(name) === true
}

/**
 * Why a line that needs the sandbox's own files may not run there whole,
 * null when it may: it runs something only Mirage has, names a file only
 * Mirage holds, uses an alias, starts a job, or reads a value only Mirage
 * holds. Mirrors Python's `_whole_refusal`.
 *
 * @param session the effective session.
 * @param ast the parsed line.
 * @param mirage the line's commands only Mirage runs.
 * @param held the line's paths only Mirage holds, files on its scratch root
 *   (`Router.place`).
 * @param unexecutable why the mounts' exec rule refuses an interpreter the
 *   sandbox took (`Router.execRefused`).
 * @param path a path of the line that is the sandbox's own.
 */
function wholeRefusal(
  session: SessionState,
  ast: TSNodeLike,
  mirage: readonly string[],
  held: readonly string[],
  unexecutable: readonly string[],
  path: string,
): string | null {
  if (mirage.length > 0) {
    const names = [...new Set(mirage)].join(', ')
    return `${names} runs in Mirage, but ${path} is on the sandbox; run them on separate lines`
  }
  const mine = held[0]
  if (mine !== undefined)
    return `${mine} is in Mirage, but ${path} is on the sandbox; run them on separate lines`
  const refused = unexecutable[0]
  if (refused !== undefined) return `${refused}, and the line runs in the sandbox for ${path}`
  const expanding = expandingAliases(session)
  const aliases = [...commandWords(ast)]
    .filter((word) => expanding.has(word))
    .sort(compareCodePoints)
  if (aliases.length > 0)
    return `${aliases[0] ?? ''} is an alias, which the sandbox does not have, and ${path} is on the sandbox`
  if (startsAJob(ast))
    return `a line using the sandbox's ${path} cannot run with & yet; drop the & or work in a workspace folder`
  const params = [...parameterReads(ast)].sort(compareCodePoints)
  if (params.length > 0)
    return `${params[0] ?? ''} would read Mirage's value, but the line runs in the sandbox for ${path}`
  const unexported = [...inheritedReads(ast)]
    .filter(
      (name) =>
        Object.hasOwn(session.vars, name) &&
        session.vars[name]?.attrs.has(VarAttr.Export) !== true &&
        !FRESH_SHELL_NAMES.has(name),
    )
    .sort(compareCodePoints)
  if (unexported.length > 0)
    return `${unexported[0] ?? ''} is not exported, but the line runs in the sandbox for ${path}`
  return null
}
