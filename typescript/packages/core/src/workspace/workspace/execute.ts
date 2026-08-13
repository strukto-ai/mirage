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
import type { Resource } from '../../resource/base.ts'
import { runWithSession } from '../../context/session_context.ts'
import type { JobTable } from '../../shell/job_table.ts'
import { findSyntaxError, findUnterminatedBacktick, type ShellParser } from '../../shell/parse.ts'
import type { ProvisionResult } from '../../provision/types.ts'
import { errorVirtualPath, gnuStrerror } from '../../utils/errors.ts'
import { makeAbortError } from '../abort.ts'
import type { Dispatcher } from '../dispatcher/index.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { PolicyDeny, type PolicyDecision } from '../../runtime/policy/index.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { ExecuteFn } from '../expand/node.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { ExecuteNodeDeps } from '../node/execute_node.ts'
import { runCommandTree } from '../node/run_tree.ts'
import type { DriftQueue } from '../snapshot/drift.ts'
import type { SessionManager } from '../session/manager.ts'
import type { Session } from '../session/session.ts'
import type { ExecutionNode } from '../types.ts'
import { failureResult, isControlFlowError } from './failure.ts'
import { runWholeLine } from './line.ts'
import type { WorkspaceMeta } from './meta.ts'
import type { PolicyRouter } from './policy.ts'
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
  policyRouter: PolicyRouter
  registerCloser(fn: () => Promise<void>): void
  ensureOpen(resource: Resource): Promise<void>
  invalidateAllAfterRemote(): Promise<void>
  provision(command: string): Promise<ProvisionResult>
  execute(cmd: string, options: ExecuteOptions): Promise<ExecuteResult>
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
 * name like every per-command error.
 */
async function deniedResult(
  env: ExecuteEnv,
  command: string,
  options: ExecuteOptions,
  reason: string,
): Promise<ExecuteResult> {
  const cmdName = commandName(command) || command
  const msg = new TextEncoder().encode(`${cmdName}: policy denied: ${reason}\n`)
  const sessionId = options.sessionId ?? env.sessions.defaultId
  const session = env.sessions.get(sessionId)
  session.lastExitCode = 126
  if (options.record !== false) {
    await env.observer.logExecution(
      command,
      new IOResult({ exitCode: 126, stderr: msg }),
      [],
      options.agentId ?? env.agentId ?? '',
      sessionId,
      options.cwd ?? session.cwd,
    )
  }
  await env.sessions.flush()
  return new ExecuteResult(new Uint8Array(), msg, 126)
}

/**
 * The body of `Workspace.execute`; see its docstring for the argument
 * contract. Order of gates: hydrate stores, drain any queued drift
 * check, parse, syntax gate, provision branch, policy, then the
 * strategies (whole-line runtime or command tree). Failures fold into
 * the line's result via `failureResult`, except the kinds that are the
 * caller's problem (abort, drift), which propagate.
 */
export async function executeLine(
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
  if (options.provision === true) return env.provision(command)
  const rootNode = root as unknown as TSNodeLike
  let routingDecision: PolicyDecision | null
  try {
    routingDecision = await env.policyRouter.decide(rootNode, command, options)
  } catch (caught) {
    if (caught instanceof PolicyDeny) {
      return deniedResult(env, command, options, caught.reason)
    }
    throw caught
  }

  const dispatch: DispatchFn = env.dispatcher.dispatch

  const executeFn: ExecuteFn = async (cmd, opts) => {
    // The executor's internal evals ($(), eval, source, xargs) are
    // never a typed line: they must not record a history entry or open
    // their own recording context, so their ops flow into this line's
    // recorder (GNU: history is appended by the line reader).
    const innerOpts: ExecuteOptions & { provision?: false } = { record: false }
    if (options.signal !== undefined) innerOpts.signal = options.signal
    // Nested lines never re-route: the evaluator's inner lines keep
    // the typed line's decision (runtime argument, policy, or scripts).
    if (routingDecision !== null) innerOpts.routingDecision = routingDecision
    // `command NAME` re-runs the inner line and must forward the pipe
    // stdin so `... | command cat` filters the upstream output; the same
    // path carries `echo hi | bash -c 'cat'` into the inner line.
    if (opts.stdin !== undefined && opts.stdin !== null) innerOpts.stdin = opts.stdin
    const res = await env.execute(cmd, innerOpts)
    return new IOResult({
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
    })
  }

  const deps = {
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
    ...(routingDecision !== null ? { routingDecision } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  }
  const targetSessionId = options.sessionId ?? env.sessions.defaultId
  const targetSession = env.sessions.get(targetSessionId)
  try {
    return await runParsedLine(env, command, options, rootNode, deps, targetSession, stdin)
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
  stdin: ByteSource | null,
): Promise<ExecuteResult> {
  const callAgentId = options.agentId ?? env.agentId ?? ''
  const effectiveSession = forkForCall(targetSession, options.cwd, options.env)
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
  const lineRuntime = env.runtimes.wholeLineFor(rootNode, deps.routingDecision ?? null)
  if (lineRuntime?.runLine !== undefined) {
    const result = await runWholeLine(
      lineRuntime,
      command,
      stdin,
      effectiveSession,
      env.registry.allMounts(),
      env.registry.policies,
      () => env.invalidateAllAfterRemote(),
    )
    targetSession.lastExitCode = result.exitCode
    if (isLine) {
      const lineIo = new IOResult({
        exitCode: result.exitCode,
        stdout: result.stdout,
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
    return new ExecuteResult(result.stdout, result.stderr ?? new Uint8Array(), result.exitCode)
  }
  const runBody = (): Promise<[ByteSource | null, IOResult, ExecutionNode]> =>
    runWithSession(effectiveSession, () => runCommandTree(deps, rootNode, effectiveSession, stdin))
  let execResult: [[ByteSource | null, IOResult, ExecutionNode], OpRecord[]]
  try {
    execResult = isLine ? await runWithRecording(runBody) : [await runBody(), []]
  } catch (err) {
    // Abort (cancellation) and content drift are control-flow signals
    // that must propagate, mirroring the Python workspace. Any other
    // execution failure (timeout, usage error, an unsupported shell
    // construct) is surfaced as a failed command rather than crashing
    // the caller.
    if (isControlFlowError(err)) throw err
    const failed = failureResult(err)
    targetSession.lastExitCode = failed.exitCode
    return new ExecuteResult(new Uint8Array(), failed.stderr, failed.exitCode)
  }
  const [[materialized, io], opRecords] = execResult
  targetSession.lastExitCode = io.exitCode
  let stdoutBytes: Uint8Array
  try {
    await env.dispatcher.applyIo(io, opRecords)
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
    targetSession.lastExitCode = 1
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

  return new ExecuteResult(stdoutBytes, stderrBytes, io.exitCode)
}
