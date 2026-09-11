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

import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import { runWithRecording } from '../../observe/context.ts'
import type { Observer } from '../../observe/observer.ts'
import type { OpRecord } from '../../observe/record.ts'
import { Channel } from '../../shell/console/types.ts'
import type { JobConsole } from '../../shell/console/job_console.ts'
import type { Resource } from '../../resource/base.ts'
import { getCurrentSessionFor, runWithSession } from '../../context/session_context.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import {
  findSyntaxError,
  findUnterminatedBacktick,
  type ShellParser,
} from '../../shell/parse/index.ts'
import type { ProvisionResult } from '../../provision/types.ts'
import { errorVirtualPath, gnuStrerror } from '../../utils/errors.ts'
import { makeAbortError, mergeSignals } from '../abort.ts'
import type { Dispatcher } from '../dispatcher/index.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { RouteDeny, type RouteDecision } from '../../runtime/routing/index.ts'
import { refusalOf, renderDeny, type Deny, type HandOff } from '../../policy/index.ts'
import type { Refusal } from '../../types.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { recordStatus } from '../executor/statement.ts'
import type { ExecuteFn } from '../expand/node.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import { withHandOff } from '../node/execute_node.ts'
import type { ExecuteNodeDeps } from '../node/execute_node.ts'
import { prejudgeLine, unrefusedNodes } from '../node/explain.ts'
import { runCommandTree } from '../node/run_tree.ts'
import type { DriftQueue } from '../snapshot/drift.ts'
import type { SessionManager } from '../session/manager.ts'
import type { Session } from '../session/session.ts'
import type { ExecutionNode } from '../types.ts'
import { failureResult, isControlFlowError } from './failure.ts'
import type { ResolvedSource } from '../../secrets/types.ts'
import { cliEnvNames, fillEnv, fillNames, guestBound, lineNodes } from './fill.ts'
import { admitLine, isPending, isPendingRefusal } from '../node/admission.ts'
import { evaluatedFrom } from '../node/occurrence.ts'
import { runWholeLine } from './line.ts'
import type { WorkspaceMeta } from './meta.ts'
import type { Router } from './routing.ts'
import type { Runtimes } from './runtimes.ts'
import { ExecuteResult, type ExecuteOptions } from './types.ts'
import { commandName, forkForCall } from './utils.ts'

/**
 * Everything `executeLine` needs from the workspace, passed explicitly
 * so the executor stays a module function (mirroring the Python
 * `execute_line` in `workspace/execute.py`, which reaches the same
 * parts through the workspace instance).
 */
export interface ExecuteEnv {
  parser(): Promise<ShellParser>
  meta: WorkspaceMeta
  drift: DriftQueue
  statFn(path: string): Promise<unknown>
  namespace: Namespace
  sessions: SessionManager
  registry: MountRegistry
  dispatcher: Dispatcher
  observer: Observer
  records: OpRecord[]
  jobTable: JobTable
  agentId: string | null
  workspaceId: string
  runtimes: Runtimes
  router: Router
  secretSources(): Promise<Readonly<Record<string, ResolvedSource>>>
  registerCloser(fn: () => Promise<void>): void
  ensureOpen(resource: Resource): Promise<void>
  invalidateAllAfterRemote(): Promise<void>
  provision(
    command: string,
    options?: Pick<ExecuteOptions, 'sessionId' | 'agentId' | 'cwd' | 'env'>,
  ): Promise<ProvisionResult>
  execute(cmd: string, options: ExecuteOptions): Promise<ExecuteResult>
}

/**
 * The record the line's nested evaluations earned, latest kept. Every
 * nested line re-enters execute through `executeFn`, and a substitution
 * keeps only the inner stdout, so that door is the one place its record
 * survives. The typed line reports it when its own tree earned none: the
 * rightmost rule IOResult.merge applies, with the inner line standing
 * left of the command that consumed its output. Mirrors Python's
 * `NestedRefusal`.
 */
interface NestedRefusal {
  latest: Refusal | null
}

function syntaxErrorResult(offending: string): ExecuteResult {
  const snippet = offending.trim()
  const errMsg =
    snippet.length > 0
      ? `mirage: syntax error near '${snippet}'\n`
      : 'mirage: syntax error in command\n'
  return new ExecuteResult(new Uint8Array(), new TextEncoder().encode(errMsg), 2)
}

/**
 * A deny is a policy outcome, not a mistake: it folds into the line's
 * result the way a timeout does, never a throw. The typed line still
 * records and the session still flushes, mirroring Python's finally
 * path. The denied party is the command, so the message carries its
 * name like every per-command error, in bash's voice; the reason rides
 * the result's `refusal` record.
 */
async function deniedResult(
  env: ExecuteEnv,
  command: string,
  options: ExecuteOptions,
  session: Session,
  reason: string,
): Promise<ExecuteResult> {
  const cmdName = commandName(command) || command
  const deny: Deny = { kind: 'deny', reason, scope: 'command' }
  const [msg, exitCode] = renderDeny(cmdName, deny)
  const refusal = refusalOf(deny)
  recordStatus(session, exitCode)
  if (options.record !== false) {
    await env.observer.logExecution(
      command,
      new IOResult({ exitCode, stderr: msg, refusal }),
      [],
      options.agentId ?? env.agentId ?? '',
      session.sessionId,
      options.cwd ?? session.cwd,
    )
  }
  await env.sessions.flush()
  return new ExecuteResult(new Uint8Array(), msg, exitCode, refusal)
}

/**
 * Move a buffered result into the sink, so a caller that gave one reads
 * the whole line there.
 *
 * Most of a line streams as it runs, but several paths answer with bytes
 * in hand and never reach the walk that emits: a whole-line runtime
 * returns its own buffer, and the syntax gate, a policy denial and a
 * failed line all return before or around the tree. Draining here rather
 * than at each of those keeps the contract one rule instead of five, and
 * a path added later cannot forget it. Nothing is emitted twice: a line
 * that did stream returns empty, which is the same fact this reads.
 *
 * @param sink console the caller passed as `ExecuteOptions.sink`.
 * @param result the line's result, buffered or already streamed.
 */
async function drainToSink(sink: JobConsole, result: ExecuteResult): Promise<ExecuteResult> {
  if (result.stdout.byteLength === 0 && result.stderr.byteLength === 0) return result
  if (result.stdout.byteLength > 0) await sink.emit(Channel.STDOUT, result.stdout)
  if (result.stderr.byteLength > 0) await sink.emit(Channel.STDERR, result.stderr)
  return new ExecuteResult(new Uint8Array(), new Uint8Array(), result.exitCode, result.refusal)
}

/**
 * The body of `Workspace.execute`; see its docstring for the argument
 * contract. Runs the line, then honors the sink contract for every path
 * `runLine` can answer on.
 */
export async function executeLine(
  env: ExecuteEnv,
  command: string,
  options: ExecuteOptions,
): Promise<ExecuteResult | ProvisionResult> {
  const result = await runLine(env, command, options)
  const sink = options.sink
  // A provision run answers with a plan, not output, so it has nothing
  // to stream.
  if (sink === undefined || !(result instanceof ExecuteResult)) return result
  return drainToSink(sink, result)
}

/**
 * Order of gates: hydrate stores, drain any queued drift check, parse,
 * syntax gate, provision branch, policy, then the strategies (whole-line
 * runtime or command tree). Failures fold into the line's result via
 * `failureResult`, except the kinds that are the caller's problem (abort,
 * drift), which propagate.
 */
async function runLine(
  env: ExecuteEnv,
  command: string,
  options: ExecuteOptions,
): Promise<ExecuteResult | ProvisionResult> {
  if (options.signal?.aborted === true) {
    throw makeAbortError()
  }
  await env.namespace.ensureLoaded()
  await env.meta.ensure()
  await env.sessions.ensureLoaded()
  if (env.drift.pending) {
    await env.drift.drain(env.registry, (p) => env.statFn(p))
  }
  const stdin = options.stdin ?? null
  const parser = await env.parser()
  const root = parser.parse(command)
  // tree-sitter accepts an unclosed backtick as a complete command, so
  // the region is scanned separately.
  const offending = findSyntaxError(root) ?? findUnterminatedBacktick(command)
  if (offending !== null) {
    // The gate runs before the provision branch, mirroring Python: a
    // provision run of unparseable input reports the syntax error
    // instead of walking the ERROR tree.
    return syntaxErrorResult(offending)
  }
  if (options.provision === true) {
    // The plan is judged as this line's caller: the effective session
    // and agent ride into the walk's admission gate, so a command
    // denied to the actual caller cannot have its backend costs
    // exposed under the default session's identity.
    return env.provision(command, {
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    })
  }
  const rootNode = root as unknown as TSNodeLike
  // A re-entrant execute (the evaluator's $(), eval, source, xargs, or
  // an embedder callback fired mid-line) continues in the live ambient
  // session unless it names a different one. An id cannot say that: it
  // names a registered session, never the ephemeral per-call fork the
  // outer line actually runs in, and re-resolving through the manager
  // is how a nested line used to escape the fork and its confinement.
  // Only this workspace's own binding counts: a session carries one
  // workspace's cwd, env and mount grants, so a callback reaching a
  // second workspace must resolve that workspace's session instead.
  const ambient = getCurrentSessionFor(env.sessions)
  const targetSession =
    ambient !== null && (options.sessionId === undefined || options.sessionId === ambient.sessionId)
      ? ambient
      : env.sessions.get(options.sessionId ?? env.sessions.defaultId)
  let routingDecision: RouteDecision | null
  try {
    routingDecision = await env.router.decide(rootNode, command, options, targetSession)
  } catch (caught) {
    if (caught instanceof RouteDeny) {
      return deniedResult(env, command, options, targetSession, caught.reason)
    }
    throw caught
  }

  const dispatch: DispatchFn = env.dispatcher.dispatch

  const nested: NestedRefusal = { latest: null }

  // The line's hand-off: the grants its passes and gates claim for its
  // commands, which the gates run on and the line's end spends. A
  // nested evaluation runs on one made under the hand-off of the node
  // that runs it, which the walker binds into the door (`withHandOff`),
  // not this line's: a background job's subtree runs on a hand-off of
  // the job's own.
  const handed: HandOff = options.handed ?? { claimed: [], parent: null, origin: null }

  const executeFn: ExecuteFn = async (cmd, opts) => {
    // The executor's internal evals ($(), eval, source, xargs) are
    // never a typed line: they must not record a history entry or open
    // their own recording context, so their ops flow into this line's
    // recorder (GNU: history is appended by the line reader).
    const innerOpts: ExecuteOptions & { provision?: false } = {
      record: false,
      sessionId: opts.sessionId,
    }
    if (options.signal !== undefined) innerOpts.signal = options.signal
    // The agent rides with the execution: an approval a nested line
    // raises is the typed line's agent's, not the workspace default's.
    if (options.agentId !== undefined) innerOpts.agentId = options.agentId
    // Nested lines never re-route: the evaluator's inner lines keep
    // the typed line's decision (runtime argument, policy, or scripts).
    if (routingDecision !== null) innerOpts.routingDecision = routingDecision
    // Under the hand-off the walker bound, standing at the node whose
    // text this is; outside a walk (no hand-off bound) the inner line
    // is a line of its own.
    if (opts.handed !== undefined) {
      innerOpts.handed =
        opts.node === undefined
          ? { claimed: [], parent: opts.handed, origin: null }
          : evaluatedFrom(opts.node, opts.handed, opts.span)
    }
    // `command NAME` re-runs the inner line and must forward the pipe
    // stdin so `... | command cat` filters the upstream output; the same
    // path carries `echo hi | bash -c 'cat'` into the inner line.
    if (opts.stdin !== undefined && opts.stdin !== null) innerOpts.stdin = opts.stdin
    const res = await env.execute(cmd, innerOpts)
    // The record rides back with the streams: a refusal the inner line
    // earned is the outer line's to report.
    if (res.refusal !== null) nested.latest = res.refusal
    return new IOResult({
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      refusal: res.refusal,
    })
  }

  const deps = withHandOff(
    {
      dispatch,
      registry: env.registry,
      namespace: env.namespace,
      jobTable: env.jobTable,
      executeFn,
      agentId: options.agentId ?? env.agentId ?? '',
      workspaceId: env.workspaceId,
      registerCloser: (fn: () => Promise<void>) => {
        env.registerCloser(fn)
      },
      ensureOpen: (resource: Resource) => env.ensureOpen(resource),
      runtimeBindings: env.runtimes.bindings,
      // Alias expansion rewrites the head word and reads the result as a
      // fresh line, so it needs the same parser the line reader used. The
      // parser is already resolved by the time the tree runs.
      reparse: (line: string) => parser.parse(line),
      ...(routingDecision !== null ? { routingDecision } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.sink !== undefined ? { sink: options.sink } : {}),
    },
    handed,
  )
  // The line runs as its own fork of the session, and everything that
  // judges it runs bound to that fork: admission and the policies it
  // consults (a profile policy reads the mounts as the session it judges
  // for, so a path the session cannot see is one its policy cannot read
  // either), a whole-line runtime, and the tree. Python binds the
  // effective session the same way before it parses.
  const effectiveSession = forkForCall(targetSession, options.cwd, options.env)
  try {
    return await runWithSession(
      effectiveSession,
      () =>
        runParsedLine(
          env,
          command,
          options,
          rootNode,
          deps,
          targetSession,
          effectiveSession,
          stdin,
          (line) => parser.parse(line),
          nested,
          handed,
        ),
      env.sessions,
    )
  } finally {
    // Durable session fields (cwd, env, grants) flush at the end of
    // every execute, success or failure, mirroring Python's finally.
    await env.sessions.flush()
  }
}

async function runParsedLine(
  env: ExecuteEnv,
  command: string,
  options: ExecuteOptions,
  rootNode: TSNodeLike,
  deps: ExecuteNodeDeps,
  targetSession: Session,
  effectiveSession: Session,
  stdin: ByteSource | null,
  reparse: (line: string) => TSNodeLike,
  nested: NestedRefusal,
  handed: HandOff,
): Promise<ExecuteResult> {
  const cacheable = env.dispatcher.captureCacheablePaths()
  const callAgentId = options.agentId ?? env.agentId ?? ''
  // The line-reader decision (GNU: history is appended where the typed
  // line is read, never inside the evaluator). Internal evaluations run
  // with record:false: no new recording scope, so their ops land in the
  // caller's recorder, and no command entry is logged for them.
  const isLine = options.record !== false
  if (isLine) {
    // Each typed line reads stdin fresh; a buffer left behind by a
    // previous line's read/select would otherwise serve EOF forever.
    effectiveSession.stdinBuffer = null
  }
  // The session's kill channel folded in, as the dispatcher folds it
  // for the tree: a question put to a host has to answer to both, and
  // both admission passes below can put one.
  const killed = mergeSignals(deps.signal, effectiveSession.abortSignal)
  const lineRuntime = env.runtimes.wholeLineFor(rootNode, deps.routingDecision ?? null)
  // Filled only after the applicable line-tier admission (a refused
  // line must never reach a secret store) and before expansion or the
  // runtime's env snapshot reads the vars. The prejudge pass leaves
  // single-command lines to the per-command gate, so the tree branch
  // asks the same text-tier question itself (`probeText`), over the
  // same walked set the names came from: a node already denied on its
  // literal words never reaches a source, and a rule that asks is
  // answered before the fetch, with the approval left for the gate to
  // spend. A deny only the value gate can see still follows the fetch,
  // because expansion is what consumes the values. A SecretsError
  // folds like any failed line: the line exits 1 and never runs.
  const writesGated = await env.registry.policies.wantsFor('preSession', effectiveSession.sessionId)
  const fillManaged = async (
    nodes: TSNodeLike[],
    whole: boolean,
    lineCliEnvNames: ReadonlySet<string>,
    probeText: boolean,
  ): Promise<ExecuteResult | null> => {
    try {
      let planNodes = nodes
      let planWhole = whole
      let planCli = lineCliEnvNames
      let names = fillNames(effectiveSession, planNodes, planWhole, planCli, writesGated)
      if (names.size > 0 && probeText) {
        const served = await unrefusedNodes(
          nodes,
          effectiveSession,
          env.registry,
          env.namespace,
          callAgentId,
          handed,
          reparse,
          killed,
        )
        if (served.length !== nodes.length) {
          planNodes = served
          planWhole = guestBound(served, deps.routingDecision ?? null, env.runtimes.bindings)
          planCli = cliEnvNames(served, effectiveSession, env.registry)
          names =
            served.length === 0
              ? new Set<string>()
              : fillNames(effectiveSession, planNodes, planWhole, planCli, writesGated)
        }
      }
      // A fetched value can name another managed variable (the
      // arithmetic chase recurses through values), and what a value
      // spells is unknowable before its fetch, so the plan reruns
      // over the same admitted nodes until it reaches nothing new.
      // fillNames returns pending names only, so every pass fetches
      // names the last one could not see and the loop settles.
      while (names.size > 0) {
        // Built here, not above the plan: the declarations are read
        // only once an admitted node actually wants a value, so a line
        // the per-command gate refuses never reaches a bootstrap
        // source either. An unknown source name already fails at
        // construction; what is left for this to discover is an
        // unreadable dotenv or a config the source refuses, which is
        // the same treatment an unreachable store gets. Memoized, so
        // the loop's later passes cost one await.
        const sources = await env.secretSources()
        await fillEnv(effectiveSession, names, sources)
        names = fillNames(effectiveSession, planNodes, planWhole, planCli, writesGated)
      }
      return null
    } catch (err) {
      if (isControlFlowError(err)) throw err
      const failed = failureResult(err)
      recordStatus(targetSession, failed.exitCode)
      return new ExecuteResult(new Uint8Array(), failed.stderr, failed.exitCode)
    }
  }
  let held = false
  let execResult: [[ByteSource | null, IOResult, ExecutionNode], OpRecord[]]
  try {
    if (lineRuntime?.runLine !== undefined) {
      // A whole line is a command like any other: the same visibility and
      // admission gate as the tree, per parsed command, before the
      // runtime sees a byte of it. No gate follows, so the pass claims on
      // the hand-off and the sweep below spends what it claimed, or keeps
      // it for the retry of a line held on a question.
      const refused = await admitLine(
        rootNode,
        effectiveSession,
        env.registry,
        env.namespace,
        callAgentId,
        reparse,
        killed,
        handed,
      )
      if (refused !== null) {
        held = isPending(refused)
        recordStatus(targetSession, refused.exitCode)
        if (isLine) {
          await env.observer.logExecution(
            command,
            new IOResult({
              exitCode: refused.exitCode,
              stderr: refused.stderr,
              refusal: refused.refusal,
            }),
            [],
            callAgentId,
            targetSession.sessionId,
            effectiveSession.cwd,
          )
        }
        return new ExecuteResult(
          new Uint8Array(),
          refused.stderr,
          refused.exitCode,
          refused.refusal,
        )
      }
      if (env.sessions.hasManagedEnv) {
        // A whole-line program may read any name, so the walk is not
        // consulted, and admitLine above already ran the real gate.
        const filled = await fillManaged([rootNode], true, new Set(), false)
        if (filled !== null) return filled
      }
      const result = await runWholeLine(
        lineRuntime,
        command,
        stdin,
        effectiveSession,
        env.registry.allMounts(),
        env.registry.policies,
        () => env.invalidateAllAfterRemote(),
      )
      recordStatus(targetSession, result.exitCode)
      if (isLine) {
        const lineIo = new IOResult({
          exitCode: result.exitCode,
          stdout: result.stdout,
          refusal: result.refusal,
          ...(result.stderr !== null ? { stderr: result.stderr } : {}),
        })
        await env.observer.logExecution(
          command,
          lineIo,
          [],
          callAgentId,
          targetSession.sessionId,
          effectiveSession.cwd,
        )
      }
      return new ExecuteResult(
        result.stdout,
        result.stderr ?? new Uint8Array(),
        result.exitCode,
        result.refusal,
      )
    }
    // The line is the unit a rule judges, so every command in it is
    // judged before any of it runs. Nothing here replaces the per-command
    // gate below, which still binds each command's own entry gate; this
    // only stops a line a rule refuses from running half-way. The grants
    // the passes claim for the gates ride the hand-off, swept in the
    // finally however the line ends: the sweep has to cover everything
    // from the preflight on, since a fetch that fails or a kill between it
    // and the run leaves a claimed grant just as unspent as a skipped gate
    // does.
    const prejudged = await prejudgeLine(
      rootNode,
      effectiveSession,
      env.registry,
      env.namespace,
      callAgentId,
      handed,
      reparse,
      killed,
    )
    if (prejudged !== null) {
      // A question left waiting holds the line for its retry, which has
      // to find the grants standing, so they are released rather than
      // spent; any other refusal ends the line.
      held = isPending(prejudged)
      recordStatus(targetSession, prejudged.exitCode)
      return new ExecuteResult(
        new Uint8Array(),
        prejudged.stderr,
        prejudged.exitCode,
        prejudged.refusal,
      )
    }
    if (env.sessions.hasManagedEnv) {
      // The walked set carries stored function bodies and alias
      // expansions too, so a body invoked by bare name still fills what
      // it reads.
      const nodes = lineNodes(rootNode, effectiveSession, reparse)
      const filled = await fillManaged(
        nodes,
        guestBound(nodes, deps.routingDecision ?? null, env.runtimes.bindings),
        cliEnvNames(nodes, effectiveSession, env.registry),
        true,
      )
      if (filled !== null) return filled
    }
    const runBody = (): Promise<[ByteSource | null, IOResult, ExecutionNode]> =>
      runCommandTree(deps, rootNode, effectiveSession, stdin)
    try {
      execResult = isLine ? await runWithRecording(runBody) : [await runBody(), []]
      // A record a nested line earned is the line's to report when its
      // own tree earned none (see NestedRefusal). A question a gate left
      // waiting holds the line exactly as one the pass left waiting
      // does: the retry has to find the grants the pass claimed for the
      // other commands standing, or it asks for them again, and the
      // answer to this one would be taken by the first spelling the pass
      // reads.
      const treeIo = execResult[0][1]
      treeIo.refusal ??= nested.latest
      held = isPendingRefusal(treeIo.refusal)
    } catch (err) {
      // Abort (cancellation) and content drift are control-flow signals
      // that must propagate, mirroring the Python workspace. Any other
      // execution failure (timeout, usage error, an unsupported shell
      // construct) is surfaced as a failed command rather than crashing
      // the caller.
      if (isControlFlowError(err)) throw err
      const failed = failureResult(err)
      recordStatus(targetSession, failed.exitCode)
      return new ExecuteResult(new Uint8Array(), failed.stderr, failed.exitCode)
    }
  } finally {
    if (held) env.registry.decisions.release(effectiveSession.sessionId, handed)
    // A nested evaluation's claims are the outer line's to keep for the
    // next evaluation from the same node and to spend at its own end.
    else if (handed.parent !== null)
      env.registry.decisions.handUp(effectiveSession.sessionId, handed)
    else await env.registry.decisions.revoke(effectiveSession.sessionId, handed)
  }
  const [[materialized, io], opRecords] = execResult
  // The program loop stamped each statement; the line as a whole is a
  // wrapper around them, like a group.
  recordStatus(targetSession, io.exitCode, true)
  let stdoutBytes: Uint8Array
  try {
    await env.dispatcher.applyIo(io, opRecords, cacheable)
    stdoutBytes = materialized === null ? new Uint8Array() : await materialize(materialized)
  } catch (err) {
    // Lazy reads can fail while draining (e.g. head/tail that open the
    // stream mid-pipeline, or a backend size guard thrown on the first
    // pull); surface that as a failed command, not a crash. The command
    // name is the first token of the pipeline's failing stage; for a bare
    // command it is simply the command.
    const strerror = gnuStrerror((err as { code?: string }).code)
    const cmdName = commandName(command) || command
    io.exitCode = 1
    io.stderr = new TextEncoder().encode(
      strerror !== null
        ? `${cmdName}: ${errorVirtualPath(err)}: ${strerror}\n`
        : `${err instanceof Error ? err.message : String(err)}\n`,
    )
    recordStatus(targetSession, 1)
    stdoutBytes = new Uint8Array()
  }
  const stderrBytes = await materialize(io.stderr)

  // One rule on every path: an op that happened is always accounted, in
  // byte accounting (which feeds snapshot fingerprints/drift) and as
  // observer op events. The command event's exit_code says whether the
  // line that emitted them succeeded. Internal evals (record:false) have
  // an empty opRecords here: their ops were accounted by the line above.
  env.records.push(...opRecords)
  if (isLine) {
    io.stdout = stdoutBytes
    await env.observer.logExecution(
      command,
      io,
      opRecords,
      callAgentId,
      targetSession.sessionId,
      effectiveSession.cwd,
    )
  }

  return new ExecuteResult(stdoutBytes, stderrBytes, io.exitCode, io.refusal)
}
