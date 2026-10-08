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
  getCurrentEvaluation,
  runWithEvaluation,
  EvaluationContext,
  childContext,
} from '../evaluation.ts'
import { ParseScope } from '../../shell/parse/scope.ts'

import { ExecutionScope } from '../execution.ts'
import { PathSpec } from '../../types.ts'
import { literalTree } from '../../shell/literal.ts'
import { FORK_FAILED, FORK_FAILED_STATUS } from '../../shell/constants.ts'
import type { ProcessHandle } from '../../process/handle.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { activeRecords, runWithRecording } from '../../observe/context.ts'
import type { Observer } from '../../observe/observer.ts'
import { READ_FINGERPRINT_OPS, type OpRecord } from '../../observe/record.ts'
import { Channel } from '../../shell/console/types.ts'
import type { JobConsole } from '../../shell/console/job_console.ts'
import { Terminal } from '../../shell/console/index.ts'
import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import {
  getCurrentSessionFor,
  runWithRefusalSink,
  runWithSession,
} from '../../context/session_context.ts'
import { type JobTable, JobWaits } from '../../shell/job_table/index.ts'
import { checkSyntax, syntaxErrorResult, type ShellParser } from '../../shell/parse/index.ts'
import { findSyntaxIssue } from '../../shell/parse/syntax.ts'
import { DiscardSignal, ExitSignal } from '../../shell/errors.ts'
import { formatFsError } from '../../errors/render.ts'
import { isFsError } from '../../errors/fs.ts'
import {
  hasAborted,
  lineStatusWriter,
  makeAbortError,
  mergeSignals,
  runWithLineAbort,
} from '../abort.ts'
import type { Dispatcher } from '../dispatcher/index.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { RouteDecision } from '../../runtime/routing/index.ts'
import type { Deny, HandOff } from '../../policy/index.ts'
import type { Refusal } from '../../types.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { inputSubstitutionRedirect } from '../../shell/helpers.ts'
import {
  recordStatus,
  restoreStatus,
  snapshotStatus,
  type StatusSnapshot,
} from '../executor/statement.ts'
import type { ExecuteFn } from '../expand/node.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import { withHandOff } from '../node/execute_node.ts'
import type { ExecuteNodeDeps } from '../node/execute_node.ts'
import {
  lineHeld,
  lineJudgments,
  prejudgeLine,
  unrefusedNodes,
  type Judged,
  type Walked,
} from '../node/explain.ts'
import { runCommandTree } from '../node/run_tree.ts'
import type { DriftQueue } from '../snapshot/drift.ts'
import type { SessionManager } from '../session/manager.ts'
import { type SessionState } from '../session/session.ts'
import { type StatusWriter, newStatusWriter } from '../abort.ts'
import { ExecutionNode } from '../types.ts'
import { abortable, joinOrAbort } from '../abort.ts'
import { failureResult, isControlFlowError, placementRefused } from './failure.ts'
import { ended, isUnwinding } from '../executor/control.ts'
import { finishShell, inheritExitTrap } from '../executor/traps.ts'
import { expandingAliases } from '../executor/builtins/alias/index.ts'
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
import { encodeText } from '../../shell/bytes.ts'

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
  invalidateAllAfterRemote(): Promise<void>
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

/**
 * What a line showed, for its record: what waits on its terminal for it
 * to take, then what it answers with besides. Mirrors Python's `_shown`.
 */
async function shown(io: IOResult, sink: JobConsole | undefined): Promise<IOResult> {
  if (!(sink instanceof Terminal) || sink.reader !== null) return io
  const [out, err] = sink.drain()
  sink.putBack(out, err)
  return new IOResult({
    stdout: concat([out, await io.materializeStdout()]),
    exitCode: io.exitCode,
  })
}

/**
 * A line answered before its tree runs, a syntax error or a policy deny:
 * `$?` takes its status and the typed line still records, as on every
 * path through Python's `finally`.
 */
async function answerLine(
  env: ExecuteEnv,
  command: string,
  options: ExecuteOptions,
  session: SessionState,
  result: ExecuteResult,
): Promise<ExecuteResult> {
  recordStatus(session, result.exitCode)
  if (options.record !== false) {
    await joinOrAbort(
      env.observer.logExecution(
        command,
        await shown(
          new IOResult({
            exitCode: result.exitCode,
            stderr: result.stderr,
            refusal: result.refusal,
          }),
          options.sink,
        ),
        [],
        options.agentId ?? env.agentId ?? '',
        session.sessionId,
        options.cwd ?? session.cwd,
      ),
      options.signal,
    )
  }
  return result
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
 * The body of `Workspace.shell`; see its docstring for the argument
 * contract. Runs the line, then honors the sink contract for every path
 * `runLine` can answer on.
 */
export async function executeLine(
  env: ExecuteEnv,
  command: string,
  options: ExecuteOptions,
  argv?: readonly string[],
): Promise<ExecuteResult> {
  const frame: LineFrame = { session: null, statusBefore: null, writer: newStatusWriter() }
  try {
    let result = await runLine(env, command, options, frame, argv)
    // The drain is the last await of the line, and a stalled store would
    // hold `shell` open past an abort; it joins under the same grace as
    // the tree.
    const sink = options.sink
    if (sink !== undefined) {
      result = await joinOrAbort(drainToSink(sink, result), options.signal)
    }
    if (hasAborted(options.signal)) throw makeAbortError(options.signal)
    return result
  } catch (error) {
    // Once the caller aborted, the line's answer is the abort whichever
    // await it landed on, tree, record, flush or drain, whether that
    // await settled inside the grace or was left behind, and `$?` is
    // what the line found. One place, after the last of them, so no
    // path can forget it.
    if (!hasAborted(options.signal)) throw error
    // Only the typed line puts `$?` back; a nested evaluation's signal
    // may be a bound the statement set (`timeout`), not the caller's.
    if (options.record !== false && frame.session !== null && frame.statusBefore !== null) {
      restoreStatus(frame.session, frame.statusBefore, frame.writer)
    }
    throw makeAbortError(options.signal)
  }
}

/**
 * What `executeLine` needs from the line to answer an abort: the shell
 * it ran on and the status that shell had before it, filled as soon as
 * the line knows them and before anything stamps.
 */
interface LineFrame {
  session: SessionState | null
  statusBefore: StatusSnapshot | null
  // Minted per call, never on the session, so two lines on one session
  // each keep their own and neither restores over the other.
  writer: StatusWriter
}

/**
 * Order of gates: hydrate stores, drain any queued drift check, resolve
 * the session, parse, syntax gate, policy, then the strategies (whole-line
 * runtime or command tree). Failures fold into the line's result via
 * `failureResult`, except the kinds that are the caller's problem (abort,
 * drift), which propagate.
 */
async function runLine(
  env: ExecuteEnv,
  command: string,
  options: ExecuteOptions,
  frame: LineFrame,
  argv?: readonly string[],
): Promise<ExecuteResult> {
  if (options.signal?.aborted === true) {
    throw makeAbortError(options.signal)
  }
  // Loads nothing the shell observes, so a stalled state store loses to
  // the signal at once rather than holding the caller.
  await abortable(preflight(env), options.signal)
  // Evaluator calls carry their exact session, including ephemeral forks.
  // Ambient re-entry is safe only with task-local storage: the browser
  // fallback's newest frame may belong to an unrelated shell call.
  const ambient = asyncContextIsolatesTasks ? getCurrentSessionFor(env.sessions) : null
  const inPlace =
    ambient !== null && (options.sessionId === undefined || options.sessionId === ambient.sessionId)
  const targetSession =
    options.session ??
    (inPlace ? ambient : env.sessions.get(options.sessionId ?? env.sessions.defaultId))
  frame.session = targetSession
  const executionScope = options.executionScope ?? new ExecutionScope()
  await executionScope.start()
  // A typed line writes to its session's terminal, and so do the jobs it
  // starts, as they write; the line answers with whatever reached the
  // terminal while it ran, a job's output from before it first.
  const tty = options.session === undefined && !inPlace ? targetSession.tty : null
  const lineOptions: ExecuteOptions = {
    ...options,
    executionScope,
    ...(tty !== null ? { sink: tty } : {}),
  }
  const run = async (): Promise<ExecuteResult> => {
    if (targetSession.processId !== null) {
      return runPreparedLine(env, command, targetSession, lineOptions, frame, argv)
    }
    const abort = new AbortController()
    const combined =
      lineOptions.signal === undefined
        ? abort.signal
        : AbortSignal.any([lineOptions.signal, abort.signal])
    let result: ExecuteResult | undefined
    let process: ProcessHandle
    try {
      process = env.jobTable.processes.start({
        sessionId: targetSession.sessionId,
        limit: targetSession.processes.max,
        command,
        cwd: PathSpec.fromStrPath(lineOptions.cwd ?? targetSession.cwd),
        cancel: () => {
          abort.abort()
        },
        run: async () => {
          result = await runWithSession(
            targetSession,
            () =>
              runPreparedLine(
                env,
                command,
                targetSession,
                { ...lineOptions, signal: combined },
                frame,
                argv,
              ),
            env.sessions,
          )
          return result.exitCode
        },
      })
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EAGAIN') throw error
      recordStatus(targetSession, FORK_FAILED_STATUS)
      return new ExecuteResult(new Uint8Array(), encodeText(FORK_FAILED), FORK_FAILED_STATUS)
    }
    targetSession.processId = process.info.pid
    targetSession.shellPid ??= process.info.pid
    try {
      await process.task
      if (result === undefined) throw new Error('process completed without a result')
      return result
    } finally {
      targetSession.processId = null
    }
  }
  if (tty === null) return run()
  let result: ExecuteResult
  try {
    // What reaches a streaming caller goes under the line's grace, as the
    // sink drain does: a stalled reader releases an aborted caller.
    await joinOrAbort(tty.attach(options.sink ?? null), options.signal)
    result = await run()
    const answered = result
    await joinOrAbort(
      tty
        .emit(Channel.STDOUT, answered.stdout)
        .then(() => tty.emit(Channel.STDERR, answered.stderr)),
      options.signal,
    )
  } catch (error) {
    tty.dropLine()
    throw error
  }
  const [stdout, stderr] = tty.take()
  return new ExecuteResult(stdout, stderr, result.exitCode, result.refusal)
}

/**
 * Run a line on the session it acquired, after admission is published.
 * Both paths of `runLine`, inside the managed process or not, end here.
 */
async function runPreparedLine(
  env: ExecuteEnv,
  command: string,
  targetSession: SessionState,
  options: ExecuteOptions,
  frame: LineFrame,
  argv?: readonly string[],
): Promise<ExecuteResult> {
  const stdin = options.stdin ?? null
  frame.statusBefore = snapshotStatus(targetSession)
  // The line runs as its own fork of the session, and everything that
  // judges it runs bound to that fork: admission and the policies it
  // consults (a profile policy reads the mounts as the session it judges
  // for, so a path the session cannot see is one its policy cannot read
  // either), a whole-line runtime, and the tree. Python binds the
  // effective session the same way before it parses.
  const effectiveSession = forkForCall(targetSession, options.cwd, options.env)
  const bound = options.evaluation ?? getCurrentEvaluation()
  const parent = bound?.session === targetSession ? bound : null
  const context =
    parent?.session === effectiveSession
      ? parent
      : new EvaluationContext(effectiveSession, parent?.frame.fork(), parent)
  try {
    // The line's signal, the caller's folded with the session's kill
    // channel, rides the async context so the status door can refuse an
    // orphan of this line and no other, and every status the line stamps,
    // a syntax error's or a deny's included, is the line's to put back.
    // Python sets the line writer at the same point.
    return await runWithLineAbort(
      mergeSignals(options.signal, context.frame.abortSignal),
      [targetSession, effectiveSession],
      frame.writer,
      async () => {
        const parser = new ParseScope(await abortable(env.parser(), options.signal))
        try {
          const root = argv === undefined ? parser.parse(command) : literalTree(argv)
          // Syntax gates before policy, mirroring bash: an unparsable line exits 2
          // and the policy is never consulted about it. bash's reading of the
          // line decides; the grammar's own errors only stop a line it cannot
          // build.
          const found =
            argv === undefined
              ? (checkSyntax(command, expandingAliases(effectiveSession)) ?? findSyntaxIssue(root))
              : null
          if (found !== null) {
            const io = syntaxErrorResult(found)
            const callStack = options.callStack
            // A substitution bash cannot parse ends the shell, from `eval` and
            // `source` too: 127, or 1 out of a child.
            if (callStack !== undefined && io.exitCode === 127)
              throw new ExitSignal(127, await materialize(io.stderr), null, 1)
            // An array bash cannot read discards its line: `eval` and `source`
            // return 1, and a child shell ends there.
            if (callStack?.subshell === true && io.exitCode === 1)
              throw new DiscardSignal(await materialize(io.stderr))
            return await answerLine(
              env,
              command,
              options,
              targetSession,
              new ExecuteResult(new Uint8Array(), await materialize(io.stderr), io.exitCode),
            )
          }
          const rootNode = root as unknown as TSNodeLike
          const reparse = (source: string): TSNodeLike =>
            parser.parse(source) as unknown as TSNodeLike
          const nested: NestedRefusal = { latest: null }

          // The line's hand-off: the grants its passes and gates claim for its
          // commands, which the gates run on and the line's end spends. A
          // nested evaluation runs on one made under the hand-off of the node
          // that runs it, which the walker binds into the door (`withHandOff`),
          // not this line's: a background job's subtree runs on a hand-off of
          // the job's own.
          const handed: HandOff = options.handed ?? { claimed: [], parent: null, origin: null }
          // The line's commands judged once, for placement and the pass that
          // refuses the line alike.
          let judgments: [Walked, Judged[]][] | null = null
          const judged = async (): Promise<[Walked, Judged[]][]> =>
            (judgments ??= await lineJudgments(
              rootNode,
              effectiveSession,
              env.registry,
              env.namespace,
              options.agentId ?? env.agentId ?? '',
              handed,
              reparse,
            ))
          // Placement waits on admission, judged with the line's refusal sink
          // bound, so an op a policy script makes while the line is judged is
          // inside the line, never a question of its own.
          const held = (): Promise<boolean> =>
            runWithRefusalSink(
              (refusal: Refusal) => {
                nested.latest = refusal
              },
              async () =>
                lineHeld(
                  await judged(),
                  env.registry,
                  handed,
                  mergeSignals(options.signal, context.frame.abortSignal),
                ),
            )
          // A line placement refuses ends here, so what admission claimed
          // for it is swept as the line's end sweeps it.
          const sweep = async (): Promise<void> => {
            if (handed.parent !== null)
              env.registry.decisions.handUp(effectiveSession.sessionId, handed)
            else await env.registry.decisions.revoke(effectiveSession.sessionId, handed)
          }
          let placed: RouteDecision | Deny | null
          try {
            placed = await abortable(
              env.router.decide(rootNode, command, options, targetSession, held),
              options.signal,
            )
          } catch (err) {
            await sweep()
            throw err
          }
          if (placed !== null && 'kind' in placed) {
            await sweep()
            return await answerLine(
              env,
              command,
              options,
              targetSession,
              placementRefused(placed, command),
            )
          }
          const routingDecision: RouteDecision | null = placed

          const dispatch: DispatchFn = env.dispatcher.dispatch

          const executeFn: ExecuteFn = async (cmd, opts) => {
            // The executor's internal evals ($(), eval, source, xargs) are
            // never a typed line: they must not record a history entry or open
            // their own recording context, so their ops flow into this line's
            // recorder (GNU: history is appended by the line reader).
            const innerOpts: ExecuteOptions = {
              record: false,
              sessionId: opts.sessionId,
              session: opts.session ?? opts.context?.session ?? effectiveSession,
              evaluation: opts.context ?? context,
            }
            // The walker already merged its signal into this one (`executeNode`),
            // so a `timeout` bound and a background job's own abort both reach it.
            const innerSignal = opts.signal
            if (innerSignal !== undefined) innerOpts.signal = innerSignal
            if (opts.executionScope !== undefined) innerOpts.executionScope = opts.executionScope
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
            // A line run in place under a sink (eval, source, a nested shell)
            // writes its statements there as they finish.
            if (opts.sink !== undefined) innerOpts.sink = opts.sink
            if (opts.callStack !== undefined) innerOpts.callStack = opts.callStack
            // A nested shell's jobs are its own: its `jobs` and `wait` see
            // only them, and its caller's never see them.
            const jobs = opts.jobTable ?? options.jobTable
            if (jobs !== undefined) innerOpts.jobTable = jobs
            let innerContext = opts.context ?? context
            let session = opts.session ?? innerContext.session
            if (session !== innerContext.session)
              innerContext = new EvaluationContext(session, innerContext.frame.fork(), innerContext)
            innerOpts.evaluation = innerContext
            if (opts.substitution === true && opts.node?.type === NT.COMMAND_SUBSTITUTION) {
              // A background evaluation can outlive the line that created this door.
              const substitutionParser = parser.fork()
              try {
                const substitutionTree = substitutionParser.parse(cmd)
                if (inputSubstitutionRedirect(substitutionTree) !== null) {
                  // The file is the substitution's value, never what the line
                  // shows: the read runs with no sink, the line's terminal least
                  // of all.
                  const [stdout, io] = await runCommandTree(
                    withHandOff(
                      {
                        ...lineDeps,
                        parser: substitutionParser,
                        ...(innerSignal !== undefined ? { signal: innerSignal } : {}),
                        ...(opts.executionScope !== undefined
                          ? { executionScope: opts.executionScope }
                          : {}),
                      },
                      innerOpts.handed ?? handed,
                    ),
                    substitutionTree,
                    innerContext,
                    null,
                    true,
                  )
                  io.stdout = stdout
                  recordStatus(session, io.exitCode, true)
                  if (io.refusal !== null) nested.latest = io.refusal
                  return io
                }
              } finally {
                substitutionParser.release()
              }
            }
            const substitution = opts.substitution === true
            if (substitution) {
              innerContext = childContext(innerContext)
              session = innerContext.session
              innerOpts.session = session
              innerOpts.evaluation = innerContext
            }
            const capture = new Terminal()
            const waits = new JobWaits(capture.jobs)
            const rest = session.jobOutput ?? session.tty.jobs
            if (substitution) {
              session.terminalOutput = false
              inheritExitTrap(session)
              // A substitution reads its pipe until every writer has closed
              // it, so what a job it started writes is part of its value,
              // and it ends when its jobs do. They are its own jobs.
              session.jobOutput = capture.jobs
              session.jobWaits = waits
              const caller = innerOpts.jobTable ?? env.jobTable
              innerOpts.jobTable = caller.child(caller)
              innerOpts.sink = capture
            }

            let io: IOResult
            try {
              const res = await env.execute(cmd, innerOpts)
              // The record rides back with the streams: a refusal the inner
              // line earned is the outer line's to report.
              if (res.refusal !== null) nested.latest = res.refusal
              io = new IOResult({
                exitCode: res.exitCode,
                stdout: res.stdout,
                stderr: res.stderr,
                refusal: res.refusal,
              })
            } catch (err) {
              // A substitution runs on a copy of the caller's frames, and it
              // is a child shell: whatever unwinds out of it ends it.
              if (!substitution || !isUnwinding(err)) throw err
              io = ended(err)
            }
            if (!substitution) return io
            const { node, handed: outer, signal, executionScope } = opts
            const shellJobs = innerOpts.jobTable
            io = await finishShell(
              (action, o) =>
                executeFn(action, {
                  ...o,
                  session,
                  ...(node !== undefined ? { node } : {}),
                  ...(outer !== undefined ? { handed: outer } : {}),
                  ...(signal !== undefined ? { signal } : {}),
                  ...(executionScope !== undefined ? { executionScope } : {}),
                  ...(shellJobs !== undefined ? { jobTable: shellJobs } : {}),
                }),
              session,
              io,
              opts.stdin ?? null,
              opts.callStack ?? null,
            )
            await capture.emit(Channel.STDOUT, await io.materializeStdout())
            await capture.emit(Channel.STDERR, await io.materializeStderr())
            await waits.join(rest)
            const [out, err] = capture.take()
            io.stdout = out.byteLength > 0 ? out : null
            io.stderr = err.byteLength > 0 ? err : null
            return io
          }

          const lineDeps: ExecuteNodeDeps = {
            dispatch,
            registry: env.registry,
            namespace: env.namespace,
            jobTable: options.jobTable ?? env.jobTable,
            executeFn,
            agentId: options.agentId ?? env.agentId ?? '',
            workspaceId: env.workspaceId,
            executionScope: options.executionScope ?? new ExecutionScope(),
            registerCloser: (fn: () => Promise<void>) => {
              env.registerCloser(fn)
            },
            runtimeBindings: env.runtimes.bindings,
            // Alias expansion rewrites the head word and reads the result as a
            // fresh line, so it needs the same parser the line reader used. The
            // parser is already resolved by the time the tree runs.
            parser,
            ...(routingDecision !== null ? { routingDecision } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          }
          const deps = withHandOff(
            options.sink !== undefined ? { ...lineDeps, sink: options.sink } : lineDeps,
            handed,
          )
          return await runWithEvaluation(
            context,
            () =>
              runParsedLine(
                env,
                command,
                options,
                rootNode,
                deps,
                targetSession,
                context,
                stdin,
                (line) => parser.parse(line),
                nested,
                handed,
                judged,
              ),
            env.sessions,
          )
        } finally {
          parser.release()
        }
      },
    )
  } finally {
    // Durable session fields (cwd, env, grants) flush at the end of
    // every execute, success or failure, mirroring Python's finally. It
    // joins under the grace like the tree: a stalled store finishes in
    // the background instead of holding an aborted caller.
    await joinOrAbort(env.sessions.flush(targetSession.sessionId), options.signal)
  }
}

/** The state a line runs against, loaded before it is parsed. */
async function preflight(env: ExecuteEnv): Promise<void> {
  await env.namespace.ensureLoaded()
  await env.meta.ensure()
  await env.sessions.ensureLoaded()
  if (env.drift.pending) {
    await env.drift.drain(env.registry, (p) => env.statFn(p))
  }
}

async function runParsedLine(
  env: ExecuteEnv,
  command: string,
  options: ExecuteOptions,
  rootNode: TSNodeLike,
  deps: ExecuteNodeDeps,
  targetSession: SessionState,
  context: EvaluationContext,
  stdin: ByteSource | null,
  reparse: (line: string) => TSNodeLike,
  nested: NestedRefusal,
  handed: HandOff,
  judged: () => Promise<[Walked, Judged[]][]>,
): Promise<ExecuteResult> {
  const effectiveSession = context.session
  const cacheFacts = env.dispatcher.captureCacheFacts()
  const callAgentId = options.agentId ?? env.agentId ?? ''
  // An op a policy refuses inside a command prints the command's own GNU
  // line, so the door notes the record here, for the line to carry on its
  // result.
  const note = (refusal: Refusal): void => {
    nested.latest = refusal
  }
  // The line-reader decision (GNU: history is appended where the typed
  // line is read, never inside the evaluator). Internal evaluations run
  // with record:false: no new recording scope, so their ops land in the
  // caller's recorder, and no command entry is logged for them.
  const isLine = options.record !== false
  // A nested line collects no records of its own and hands only its
  // streams back, so it applies against the records added to the enclosing
  // line's since it began, copied at apply, reads left out: a concurrent
  // sibling stage records into the same list, and its read token would label
  // bytes this line read before the change.
  const nestedStart = isLine ? 0 : (activeRecords()?.length ?? 0)
  // The session's kill channel folded in, as the dispatcher folds it
  // for the tree: a question put to a host has to answer to both, and
  // both admission passes below can put one.
  const killed = mergeSignals(deps.signal, context.frame.abortSignal)
  const lineRuntime = env.runtimes.wholeLineFor(deps.routingDecision ?? null)
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
        const sources = await abortable(env.secretSources(), killed)
        await fillEnv(effectiveSession, names, sources, killed)
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
  const statusBefore = snapshotStatus(targetSession)
  let held = false
  let execResult: [[ByteSource | null, IOResult, ExecutionNode], OpRecord[]]
  let executionFailure: { error: unknown } | undefined
  try {
    if (lineRuntime?.runLine !== undefined) {
      // A whole line is a command like any other: the same visibility and
      // admission gate as the tree, per parsed command, before the
      // runtime sees a byte of it. No gate follows, so the pass claims on
      // the hand-off and the sweep below spends what it claimed, or keeps
      // it for the retry of a line held on a question.
      const refused = await admitLine(
        rootNode,
        context.session,
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
          await joinOrAbort(
            env.observer.logExecution(
              command,
              await shown(
                new IOResult({
                  exitCode: refused.exitCode,
                  stderr: refused.stderr,
                  refusal: refused.refusal,
                }),
                options.sink,
              ),
              [],
              callAgentId,
              targetSession.sessionId,
              effectiveSession.cwd,
            ),
            killed,
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
      const result = await abortable(
        runWithRefusalSink(note, () =>
          runWholeLine(
            lineRuntime,
            command,
            stdin,
            effectiveSession,
            env.registry.allMounts(),
            env.registry.policies,
            () => env.invalidateAllAfterRemote(),
            killed,
            env.registry.commandLimits,
          ),
        ),
        killed,
      )
      const refusal = result.refusal ?? nested.latest
      recordStatus(targetSession, result.exitCode)
      if (isLine) {
        const lineIo = new IOResult({
          exitCode: result.exitCode,
          stdout: result.stdout,
          refusal,
          ...(result.stderr !== null ? { stderr: result.stderr } : {}),
        })
        // Joined like the tree's record: a stalled store releases the
        // caller, a fast one records before history is read.
        await joinOrAbort(
          env.observer.logExecution(
            command,
            await shown(lineIo, options.sink),
            [],
            callAgentId,
            targetSession.sessionId,
            effectiveSession.cwd,
          ),
          killed,
        )
      }
      return new ExecuteResult(
        result.stdout,
        result.stderr ?? new Uint8Array(),
        result.exitCode,
        refusal,
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
      await judged(),
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
    const runBody = async (): Promise<[ByteSource | null, IOResult, ExecutionNode]> => {
      try {
        // The one cancellation seam, the twin of Python's run_cancellable:
        // a responsive tree unwinds at its checkpoints and reports its own
        // error; a leaf blocked past the grace is left behind and the
        // caller is released here. Leaf checks below this point exist to
        // stop side effects and free producers, not to release the caller.
        const release = deps.parser instanceof ParseScope ? deps.parser.retain() : undefined
        const running = runCommandTree(
          deps,
          rootNode,
          context,
          stdin,
          false,
          options.callStack ?? null,
        ).finally(release)
        const result = await joinOrAbort(running, killed)
        if (killed?.aborted === true) throw makeAbortError(killed)
        return result
      } catch (error) {
        // A line run in its caller's frame unwinds into the caller.
        if (options.callStack !== undefined && isUnwinding(error)) throw error
        // Return through the recording scope so completed op records survive
        // a throw. Once the caller aborted, the line's answer is the abort,
        // whatever a leaf threw while unwinding.
        const aborted = killed?.aborted === true
        executionFailure = { error: aborted ? makeAbortError(killed) : error }
        const failed = failureResult(executionFailure.error)
        if (aborted) failed.exitCode = 130
        return [null, new IOResult(failed), new ExecutionNode({ command, ...failed })]
      }
    }
    try {
      execResult = await runWithRefusalSink(note, async () =>
        isLine ? runWithRecording(runBody) : [await runBody(), []],
      )
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
      if (isControlFlowError(err) || (options.callStack !== undefined && isUnwinding(err)))
        throw err
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
    else
      await joinOrAbort(env.registry.decisions.revoke(effectiveSession.sessionId, handed), killed)
  }
  const [[materialized, io], opRecords] = execResult
  const callerError =
    executionFailure !== undefined &&
    (isControlFlowError(executionFailure.error) || killed?.aborted === true)
  let stdoutBytes: Uint8Array
  let stderrBytes: Uint8Array
  try {
    // The program loop stamped each statement; the line as a whole is a
    // wrapper around them, like a group.
    // A rejected invocation records its outcome without changing shell status.
    if (rootNode.warnings)
      io.stderr = concat([encodeText(rootNode.warnings), await io.materializeStderr()])
    if (!callerError) recordStatus(targetSession, io.exitCode, true)
    try {
      if (executionFailure === undefined) {
        const applied = isLine
          ? opRecords
          : activeRecords()
              ?.slice(nestedStart)
              .filter((r) => !READ_FINGERPRINT_OPS.has(r.op))
        await abortable(env.dispatcher.applyIo(io, applied, cacheFacts), killed)
      }
      stdoutBytes =
        materialized === null
          ? new Uint8Array()
          : await abortable(materialize(materialized), killed)
    } catch (err) {
      if (killed?.aborted === true) {
        // The command finished; the abort landed on the cache fill or the drain.
        // An aborted invocation is the caller's outcome, not the shell's.
        if (isLine) restoreStatus(targetSession, statusBefore, lineStatusWriter(targetSession))
        executionFailure = { error: makeAbortError(killed) }
        io.exitCode = 130
        stdoutBytes = new Uint8Array()
      } else {
        // Lazy reads can fail while draining (e.g. head/tail that open the
        // stream mid-pipeline, or a backend size guard thrown on the first
        // pull); surface that as a failed command, not a crash. The command
        // name is the first token of the pipeline's failing stage; for a bare
        // command it is simply the command.
        const cmdName = commandName(command) || command
        io.exitCode = 1
        io.stderr = isFsError(err)
          ? formatFsError(cmdName, err)
          : encodeText(`${err instanceof Error ? err.message : String(err)}\n`)
        recordStatus(targetSession, 1)
        stdoutBytes = new Uint8Array()
      }
    }
    stderrBytes = await materialize(io.stderr)
  } finally {
    // The marks were only for this line's applyIo, so they go however it
    // ends, after the line's last await, so a background job cannot mark
    // a record between the seal and the persist below; the seal stops a
    // background command that returns later from marking a record
    // persisted here, which nothing outside FUSE ever trims. A line whose
    // recording scope threw returned no records: they are neither applied
    // nor persisted.
    for (const rec of opRecords) {
      rec.claimed = null
      rec.sealed = true
    }
  }

  // One rule on every path: an op that happened is always accounted, in
  // byte accounting (which feeds snapshot fingerprints/drift) and as
  // observer op events. The command event's exit_code says whether the
  // line that emitted them succeeded. Internal evals (record:false) have
  // an empty opRecords here: their ops were accounted by the line above.
  env.records.push(...opRecords)
  // bash adds a line to history only when it is non-empty
  // (anything before its newline): a blank line is skipped, while a
  // whitespace-only or comment-only line is kept.
  if (isLine && command.replaceAll('\n', '') !== '') {
    io.stdout = stdoutBytes
    // Joined, not raced: a fast store still records the line before the
    // caller reads history, and a stalled one releases the caller.
    await joinOrAbort(
      env.observer.logExecution(
        command,
        await shown(io, options.sink),
        opRecords,
        callAgentId,
        targetSession.sessionId,
        effectiveSession.cwd,
      ),
      killed,
    )
  }
  // The line finished and the abort landed on the record: the answer is
  // still the abort, as it is for one that lands on the drain.
  if (executionFailure === undefined && killed?.aborted === true) {
    executionFailure = { error: makeAbortError(killed) }
  }

  if (executionFailure !== undefined && (callerError || killed?.aborted === true)) {
    // Statements before the abort may have stamped; an aborted
    // invocation is the caller's outcome, not the shell's. Only the
    // typed line's, though: a nested evaluation runs under whatever
    // signal the statement that launched it supplied, and `timeout`
    // supplies one of its own to stop the inner run at the deadline.
    // Restoring there would put the shell back to what the *inner*
    // line found, over the 124 the `timeout` statement just stamped,
    // which is how `timeout 0.2 sleep 5; echo $?` printed 0.
    if (isLine && killed?.aborted === true)
      restoreStatus(targetSession, statusBefore, lineStatusWriter(targetSession))
    throw executionFailure.error
  }
  return new ExecuteResult(stdoutBytes, stderrBytes, io.exitCode, io.refusal)
}
