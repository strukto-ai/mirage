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

import { type EvaluationContext, childContext } from '../evaluation.ts'
import type { ParseScope } from '../../shell/parse/scope.ts'

import { ExecutionScope } from '../execution.ts'
import { timingReport } from './timing.ts'
import { PathSpec } from '../../types.ts'
import { runInCommandScope } from '../../cache/index/scope.ts'

import {
  isProgramInvocation,
  runAsProgram,
  runWithEvaluation,
} from '../../context/session_context.ts'
import type { ProcessHandle } from '../../process/handle.ts'
import type { ProcessSupervisor } from '../../process/supervisor.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { RouteDecision } from '../../runtime/routing/index.ts'
import { share } from '../../io/async_line_iterator.ts'
import { type ByteSource, IOResult } from '../../io/types.ts'
import { makeAbortError, mergeSignals } from '../../utils/abort.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { literalText } from '../../shell/parse/names.ts'
import { BASH_BUILTINS } from '../lookup/constants.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import { assignmentStatus, ignoringErrexit, recordStatus } from '../executor/statement.ts'
import {
  getCaseItems,
  getCaseWord,
  getCforParts,
  getForParts,
  getFunctionSource,
  getFunctionName,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getPipelineStages,
  getRedirects,
  readRow,
  takeContinuation,
  getText,
  getParts,
  getUnsetArgs,
  getWhileParts,
} from '../../shell/helpers.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { FORK_FAILED, FORK_FAILED_STATUS } from '../../shell/constants.ts'
import { NodeType as NT, type PipelineStages, Redirect, RedirectKind } from '../../shell/types.ts'
import { NodeKind, nodeKind, pipelineTransparent } from '../../shell/node_kind.ts'
import {
  runWithRedirectPaths,
  redirectPathsFor,
  redirectSyntaxFor,
  type RedirectRunner,
} from '../../context/session_context.ts'
import { expandRedirect } from '../expand/redirects.ts'
import { type ExecuteFn, expandArith, expandNode } from '../expand/node.ts'
import { expandPattern } from '../expand/pattern.ts'
import type { ArithWrite } from '../../shell/types.ts'
import { ExitSignal, ArithError, ReadonlyError } from '../../shell/errors.ts'
import { expandAndClassify } from '../expand/parts.ts'
import { landArith } from '../session/elements.ts'
import type { ArithResult, TSNodeLike } from '../../shell/types.ts'
import {
  type CforEval,
  executeBody,
  handleCase,
  handleCfor,
  handleFor,
  handleIf,
  handleSelect,
  handleUntil,
  handleWhile,
} from '../executor/control.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { handleTest, handleUnset } from '../executor/builtins/index.ts'
import { aliasMark, aliasView } from '../executor/builtins/alias/index.ts'
import { isValidName } from '../executor/builtins/shared.ts'
import { handleConnection, handlePipe, handleSubshell } from '../executor/pipes.ts'
import { handleRedirect } from '../executor/redirect.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'

import { ExecutionNode } from '../types.ts'
import { globOptions, resolveGlobs } from '../expand/globs.ts'
import { expandDoubleBracket, expandTestExpr } from './test_expr.ts'
import { executeProgram } from './program.ts'
import { installExecRedirects } from '../executor/builtins/exec/index.ts'
import { executeCommand } from './command_dispatch.ts'
import { executeAssignment } from './assignment.ts'
import { executeDeclaration } from './declaration.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import type { HandOff } from '../../policy/types.ts'
import { definedAt } from './occurrence.ts'
import type { SessionView } from '../../view/types.ts'
import { randomReader, sessionArith, sessionView } from '../session/state.ts'
import type { JobConsole } from '../../shell/console/index.ts'
import { drained } from '../executor/jobs.ts'
import type { ExecuteNodeOpts } from '../executor/command/types.ts'
import { endShell } from '../executor/traps.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { encodeText } from '../../shell/bytes.ts'

const STREAMING_KINDS: ReadonlySet<NodeKind> = new Set([
  NodeKind.PROGRAM,
  NodeKind.COMPOUND,
  NodeKind.LIST,
  NodeKind.SUBSHELL,
  NodeKind.IF,
  NodeKind.FOR,
  NodeKind.CFOR,
  NodeKind.SELECT,
  NodeKind.WHILE,
  NodeKind.UNTIL,
  NodeKind.CASE,
  NodeKind.NEGATED,
])

type Result = [ByteSource | null, IOResult, ExecutionNode]
type Recurse = (
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
) => Promise<Result>

/**
 * The deps for a subtree that runs on `handed`.
 *
 * The hand-off a subtree's gates read and the one its nested
 * evaluations run under are one fact, set together here so the walker
 * can never carry one hand-off and evaluate under another. Everything a
 * command hands a line to (eval, source, xargs, command, a substitution,
 * a herestring, a redirect target) re-enters through `executeFn`, so the
 * hand-off is bound into it rather than into the line's closure: a
 * background job's subtree runs on a hand-off of the job's own, and a
 * line it evaluates after the typed line has ended has to stand under
 * that one. Under the line's, the inner gate could not see the grant the
 * job holds and asked again, and what it claimed went back to a hand-off
 * nothing revokes any more.
 */
export function withHandOff(deps: ExecuteNodeDeps, handed: HandOff): ExecuteNodeDeps {
  const inner = deps.executeFn
  const executeFn: ExecuteFn = (cmd, opts) => inner(cmd, { handed, ...opts })
  return { ...deps, handed, executeFn }
}

/**
 * Layer per-call overrides onto the walker's deps.
 *
 * Written field by field rather than spread so an explicitly undefined
 * override cannot erase a dep under exactOptionalPropertyTypes.
 */
function withOpts(base: ExecuteNodeDeps, opts?: ExecuteNodeOpts): ExecuteNodeDeps {
  if (opts === undefined) return base
  let next: ExecuteNodeDeps = { ...base }
  if (opts.sink !== undefined) next.sink = opts.sink
  if (opts.signal !== undefined) next.signal = opts.signal
  if (opts.executionScope !== undefined) next.executionScope = opts.executionScope
  if (opts.handed !== undefined) next = withHandOff(next, opts.handed)
  return next
}

/**
 * Evaluate one C-style for expression slot: the slot's integer value,
 * or the default for an empty slot (1 for the condition so `for
 * ((;;))` loops, 0 for init/update). Re-raises ArithError with the
 * expression text prepended so the loop can print bash's
 * `((: expr: reason` diagnostic, and throws ReadonlyError when the
 * expression assigns to a readonly variable, once the writes before it
 * land (ExitSignal for one inside a subscript).
 */
async function evalCforExpr(
  exprs: readonly TSNodeLike[],
  dflt: number,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<number> {
  const session = context.session
  if (exprs.length === 0) return dflt
  // One comma expression, evaluated once, so an assignment early in the
  // slot is seen by the expressions after it.
  const parts: string[] = []
  for (const expr of exprs) parts.push(await expandArith(expr, context, executeFn, callStack, view))
  const text = parts.join(', ')
  const reader = randomReader(session)
  let error: ArithError | ReadonlyError | null = null
  let writes: readonly ArithWrite[] = []
  let value = 0n
  try {
    const result: ArithResult = sessionArith(session, text, reader)
    writes = result.writes
    value = result.value
  } catch (err) {
    if (!(err instanceof ArithError || err instanceof ReadonlyError)) throw err
    // bash bound the assignments made before the error; they land
    // before the error is reported.
    error = err
    writes = err.writes
  }
  // Through the session view, so a preSession rule governs an arithmetic assignment
  // exactly as it governs `X=1` and a hidden name refuses at its own
  // write; in evaluation order, so a bare name and its element 0 land as
  // the expression wrote them.
  await landArith(session, view ?? null, writes, reader)
  if (error instanceof ReadonlyError) {
    if (error.inSubscript) throw error.signal()
    throw error
  }
  if (error !== null) throw new ArithError(`${text}: ${error.message}`)
  return Number(value)
}

/**
 * Recurse wrapper for a re-associated trailing redirect: the list's right
 * operand runs under the hoisted redirects, bound by the same rule in turn
 * (`runRedirected`), so a pipeline there hands them to its last command
 * and a nested list to its own right operand; targets expand only at that
 * point (after the left side ran, so cwd changes apply). Every other node
 * recurses normally.
 */
async function recurseReassociated(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  redirects: readonly Redirect[],
  right: TSNodeLike,
  signal: AbortSignal | undefined,
  processes: ProcessSupervisor | undefined,
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
): Promise<Result> {
  if (node.id !== right.id) return recurse(node, context, stdin, callStack, opts)
  return runRedirected(
    recurse,
    dispatch,
    executeFn,
    registry,
    namespace,
    right,
    [...redirects],
    signal,
    processes,
    opts?.sink,
    context,
    stdin,
    callStack,
  )
}

/**
 * Recurse wrapper for a list the parse pulled into a pipeline's first
 * stage: the list's right operand, where the pipeline starts, runs the
 * pipeline; every other node recurses normally.
 */
async function recurseLifted(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  stages: PipelineStages,
  right: TSNodeLike,
  signal: AbortSignal | undefined,
  processes: ProcessSupervisor | undefined,
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
): Promise<Result> {
  if (node !== right) return recurse(node, context, stdin, callStack, opts)
  return runPipeline(
    recurse,
    dispatch,
    executeFn,
    registry,
    namespace,
    stages,
    context,
    stdin,
    callStack,
    signal,
    processes,
  )
}

/**
 * Recurse wrapper for one pipeline stage. A stage the parse hoisted
 * redirects off runs under them, with the `2>&1` of a `|&` after it
 * applied last, as bash applies it after the command's own redirections;
 * a stage holding its own redirects gets that `2>&1` from
 * `recursePipeStderr`.
 */
async function recurseStage(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  stages: PipelineStages,
  targets: readonly TSNodeLike[],
  signal: AbortSignal | undefined,
  processes: ProcessSupervisor | undefined,
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
): Promise<Result> {
  const index = stages.commands.indexOf(node)
  const hoisted = index < 0 ? [] : (stages.redirects[index] ?? [])
  if (hoisted.length === 0) {
    return recursePipeStderr(
      recurse,
      dispatch,
      executeFn,
      registry,
      namespace,
      targets,
      node,
      context,
      stdin,
      callStack,
      opts,
    )
  }
  const bound = [...hoisted]
  if (targets.includes(node)) {
    bound.push(new Redirect({ fd: 2, target: 1, kind: RedirectKind.STDERR_TO_STDOUT }))
  }
  return runRedirected(
    recurse,
    dispatch,
    executeFn,
    registry,
    namespace,
    node,
    bound,
    signal,
    processes,
    undefined,
    context,
    stdin,
    callStack,
  )
}

/**
 * Run a pipeline as bash reads it (`getPipelineStages`). A list the parse
 * pulled into the first stage runs as the list it is, its right operand
 * standing for the pipeline, so the pipeline runs only when the list's
 * operator says it does and its status is the list's. A leading `!`
 * negates the whole pipeline's status.
 */
async function runPipeline(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  stages: PipelineStages,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  signal?: AbortSignal,
  processes?: ProcessSupervisor,
): Promise<Result> {
  const session = context.session
  if (stages.lead !== null) {
    const [left, op, right] = stages.lead
    const wrapped = recurseLifted.bind(
      null,
      recurse,
      dispatch,
      executeFn,
      registry,
      namespace,
      { ...stages, lead: null },
      right,
      signal,
      processes,
    )
    return handleConnection(wrapped, left, op, right, context, stdin, callStack, executeFn)
  }
  const targets = stages.commands.filter((_, i) => stages.stderrFlags[i] === true)
  const pipeRecurse = recurseStage.bind(
    null,
    recurse,
    dispatch,
    executeFn,
    registry,
    namespace,
    stages,
    targets,
    signal,
    processes,
  )
  const piped = (): Promise<Result> =>
    handlePipe(
      pipeRecurse,
      stages.commands,
      stages.stderrFlags,
      context,
      stdin,
      callStack,
      signal,
      processes,
      executeFn,
    )
  const [stdout, io, execNode] = stages.negated
    ? await ignoringErrexit(context.session, piped)
    : await piped()
  if (!stages.negated) return [stdout, io, execNode]
  const flipped = new IOResult({
    exitCode: io.exitCode !== 0 ? 0 : 1,
    stderr: io.stderr,
    reads: io.reads,
    writes: io.writes,
    cache: io.cache,
    refusal: io.refusal,
  })
  execNode.exitCode = flipped.exitCode
  session.errexitImmune = true
  return [stdout, flipped, execNode]
}

type RunLeft = (
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
) => Promise<Result>

/** What `!` makes of the statement it wraps once that has run. */
async function negated(
  rawStdout: ByteSource | null,
  io: IOResult,
  execNode: ExecutionNode,
  context: EvaluationContext,
  inner: TSNodeLike,
): Promise<Result> {
  const session = context.session
  // Lazy exit codes (exitOnEmpty in grep) must be final before
  // inverting, or `! grep miss f` negates the provisional 0.
  const stdout = await applyBarrier(rawStdout, io, BarrierPolicy.VALUE)
  // bash reports the negated pipeline's own statuses in PIPESTATUS
  // (`! false` leaves `1`), so what `!` wraps is closed as a statement
  // of its own before `$?` inverts.
  recordStatus(session, io.exitCode, pipelineTransparent(inner))
  const flipped = new IOResult({
    exitCode: io.exitCode !== 0 ? 0 : 1,
    stderr: io.stderr,
    reads: io.reads,
    writes: io.writes,
    cache: io.cache,
    refusal: io.refusal,
  })
  execNode.exitCode = flipped.exitCode
  session.errexitImmune = true
  return [stdout, flipped, execNode]
}

/**
 * Run a redirected statement: the command under its redirects, then the
 * pipeline a heredoc's operator line fed it into.
 *
 * The parse hoists a trailing redirect over whatever precedes it, so the
 * redirects are bound where bash binds them first: past a list to its
 * right operand, past a pipeline to its last stage, and inside a `!` to
 * the command it negates, recursively, until they reach the command they
 * follow.
 */
async function runRedirected(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  command: TSNodeLike | null,
  redirects: Redirect[],
  signal: AbortSignal | undefined,
  processes: ProcessSupervisor | undefined,
  sink: JobConsole | undefined,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  const session = context.session
  if (command !== null && command.type === NT.REDIRECTED_STATEMENT) {
    const [inner, own] = getRedirects(command)
    return runRedirected(
      recurse,
      dispatch,
      executeFn,
      registry,
      namespace,
      inner,
      [...own, ...redirects],
      signal,
      processes,
      sink,
      context,
      stdin,
      callStack,
    )
  }
  if (command !== null && command.type === NT.FUNCTION_DEFINITION) {
    // The redirects belong to the function, applied at each call
    // (getFunctionBody), not to the definition.
    return recurse(command, context, stdin, callStack)
  }
  if (command !== null && command.type === NT.LIST) {
    // tree-sitter hoists a trailing redirect over the whole &&/||
    // list; bash binds it to the last command:
    //   redirected(list(L, op, R), r) == list(L, op, redirected(R, r))
    // Re-associate and defer target expansion until R runs, so
    // `cd /x && echo hi > f` writes under /x. R is bound by this same
    // rule, so `a && b | c < f` reaches `c`, not the pipeline. Compound
    // and subshell bodies keep the whole-body redirect (bash group
    // semantics).
    const [left, op, right] = getListParts(command)
    const wrapped = recurseReassociated.bind(
      null,
      recurse,
      dispatch,
      executeFn,
      registry,
      namespace,
      redirects,
      right,
      signal,
      processes,
    )
    return handleConnection(wrapped, left, op, right, context, stdin, callStack, executeFn)
  }
  if (command !== null && command.type === NT.PIPELINE) {
    return runPipeline(
      recurse,
      dispatch,
      executeFn,
      registry,
      namespace,
      getPipelineStages(command, redirects),
      context,
      stdin,
      callStack,
      signal,
      processes,
    )
  }
  if (command !== null && command.type === NT.NEGATED_COMMAND) {
    // `! cmd < f` parses as redirected(negated(cmd), < f), but the
    // redirect is the command's: bash negates what `cmd < f` returns, a
    // redirect that failed to open included.
    const inner = getNegatedCommand(command)
    const [stdout, io, execNode] = await ignoringErrexit(context.session, () =>
      runRedirected(
        recurse,
        dispatch,
        executeFn,
        registry,
        namespace,
        inner,
        redirects,
        signal,
        processes,
        sink,
        context,
        stdin,
        callStack,
      ),
    )
    return negated(stdout, io, execNode, context, inner)
  }
  const pipeNode =
    (redirects.find((r) => r.pipeline != null)?.pipeline as TSNodeLike | null) ?? null
  const expand = (redirect: Redirect) =>
    expandRedirect(
      redirect,
      context,
      executeFn,
      registry,
      callStack,
      sessionView(session, registry.policies, context.frame.diagnostics),
      forks(command, context),
      namespace,
    )
  // `exec > file` with no command installs the redirects on the shell
  // for every later statement, rather than applying them to one
  // command. `exec cmd > file` still has a command and falls through
  // to the ordinary path, which refuses the command form.
  if (isBareExec(command)) {
    return await installExecRedirects(dispatch, session, redirects, stdin, expand)
  }
  // A heredoc's operator line reads the routed stdout, so then it is
  // returned rather than written. A simple command expands its words
  // before its redirects apply, so what that printed (a substitution's
  // stderr) goes around them; a compound body expands inside them.
  const simple =
    command !== null &&
    (command.type === NT.COMMAND ||
      command.type === NT.VARIABLE_ASSIGNMENT ||
      command.type === NT.VARIABLE_ASSIGNMENTS)
  const outer = context.frame.diagnostics
  if (simple) context.frame.diagnostics = []
  let stdout: ByteSource | null
  let io: IOResult
  let execNode: ExecutionNode
  try {
    if (command !== null && command.type === NT.COMMAND) {
      const underRedirects: RedirectRunner = (run, guard, name, args) =>
        handleRedirect(
          (_node, _current, given, _stack, options) =>
            run(given, options?.sink, redirectPathsFor(command)),
          dispatch,
          command,
          redirects,
          context,
          stdin,
          callStack,
          false,
          pipeNode === null ? sink : undefined,
          expand,
          guard,
          name,
          args,
        )
      ;[stdout, io, execNode] = await runWithRedirectPaths(
        command,
        [],
        () =>
          recurse(command, context, stdin, callStack, {
            ...(pipeNode === null && sink ? { sink } : {}),
            ownDiagnostics: false,
          }),
        underRedirects,
        redirects,
      )
    } else {
      ;[stdout, io, execNode] = await handleRedirect(
        simple
          ? (n, s, i, cs, opts) => recurse(n, s, i, cs, { ...opts, ownDiagnostics: false })
          : recurse,
        dispatch,
        command,
        redirects,
        context,
        stdin,
        callStack,
        false,
        pipeNode === null ? sink : undefined,
        expand,
      )
    }
    if (simple && context.frame.diagnostics.length > 0) {
      const err = diagnosticStderr(command, context)
      io.stderr = concat([err, await io.materializeStderr()])
      execNode.stderr = concat([err, execNode.stderr])
    }
  } catch (err) {
    if (simple && err instanceof ExitSignal) {
      err.stderr = concat([diagnosticStderr(command, context), err.stderr])
    }
    throw err
  } finally {
    context.frame.diagnostics = outer
  }
  if (pipeNode !== null && stdout !== null) {
    const [stdout2, io2, execNode2] = await recurse(pipeNode, context, stdout, callStack)
    stdout = stdout2
    io = await io.merge(io2)
    execNode = execNode2
  }
  return [stdout, io, execNode]
}

/**
 * Fold the `&&`/`||` steps a heredoc's operator line carried around the
 * statement, left to right.
 *
 * The last step's operator joins everything before it to its right
 * operand, so the fold is `handleConnection` with the statement's node
 * standing for that left side; `recurseContinuation` runs the remaining
 * steps when asked for it and recurses normally for the right operand.
 * The list semantics (short-circuit, `$?`, `PIPESTATUS`, `set -e`
 * immunity) are therefore the `list` node's own, not a second copy.
 */
async function runContinuation(
  recurse: Recurse,
  runLeft: RunLeft,
  left: TSNodeLike,
  steps: readonly (readonly [string, TSNodeLike])[],
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  executeFn: ExecuteFn | null = null,
): Promise<Result> {
  const last = steps[steps.length - 1]
  if (last === undefined) return runLeft(context, stdin, callStack)
  const [op, right] = last
  const wrapped = recurseContinuation.bind(
    null,
    recurse,
    runLeft,
    left,
    steps.slice(0, -1),
    executeFn,
  )
  return handleConnection(wrapped, left, op, right, context, stdin, callStack, executeFn)
}

async function recurseContinuation(
  recurse: Recurse,
  runLeft: RunLeft,
  left: TSNodeLike,
  steps: readonly (readonly [string, TSNodeLike])[],
  executeFn: ExecuteFn | null,
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  if (node === left)
    return runContinuation(recurse, runLeft, left, steps, context, stdin, callStack, executeFn)
  return recurse(node, context, stdin, callStack)
}

async function recursePipeStderr(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  targets: readonly TSNodeLike[],
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
): Promise<Result> {
  if (!targets.includes(node) || nodeKind(node) !== NodeKind.REDIRECT) {
    return recurse(node, context, stdin, callStack, opts)
  }
  const [command, redirects] = getRedirects(node)
  redirects.push(new Redirect({ fd: 2, target: 1, kind: RedirectKind.STDERR_TO_STDOUT }))
  return runRedirected(
    recurse,
    dispatch,
    executeFn,
    registry,
    namespace,
    command,
    redirects,
    undefined,
    undefined,
    opts?.sink,
    context,
    stdin,
    callStack,
  )
}

export interface ExecuteNodeDeps {
  /** @internal Scheduling scope; background jobs create their own. */
  executionScope?: ExecutionScope
  dispatch: DispatchFn
  registry: MountRegistry
  namespace: Namespace
  jobTable: JobTable
  executeFn: ExecuteFn
  agentId: string
  workspaceId: string
  registerCloser: (fn: () => Promise<void>) => void
  runtimeBindings?: Record<string, Runtime>
  routingDecision?: RouteDecision<Runtime>
  signal?: AbortSignal
  /**
   * The hand-off this subtree runs on, carried to every command's gate
   * so it runs on the grants claimed for this line and never another's,
   * and bound into `executeFn` by `withHandOff` so every line the
   * subtree evaluates stands under it too.
   */
  handed?: HandOff
  /**
   * The shell parser. Only alias expansion needs it: an alias rewrites the
   * head word textually and the result is read as a fresh line, so a value
   * holding a pipe is a pipe. Absent (a unit test driving the walker
   * directly) means an alias definition is stored and printed but never
   * expanded.
   */
  parser?: ParseScope
  /**
   * Console this node writes its output to as it is produced.
   * When set, the node emits and returns no stdout; when unset
   * it returns stdout as a value, which is what capture sites
   * (command substitution, pipe stages, redirects) rely on.
   */
  sink?: JobConsole
}

/**
 * Whether a redirected statement's command is a bare `exec`: a command
 * name and no arguments, so its redirects are the shell's own rather
 * than one command's. `exec cmd` is not bare and falls through to the
 * command path, which refuses it.
 */
function isBareExec(command: TSNodeLike | null): boolean {
  if (command?.type !== NT.COMMAND) return false
  const named = getParts(command)
  return named.length === 1 && named[0]?.type === NT.COMMAND_NAME && getText(named[0]) === 'exec'
}

/**
 * Whether bash forks to run a redirected command, so its redirects expand
 * in the child and an error there fails that command alone: a subshell or a
 * program. A builtin, a function or another compound command is the shell's
 * own, which expands its redirects itself and discards the line on an
 * error. `command -v` is the builtin itself; `command X` is X with functions
 * masked; a name only an expansion spells is taken for a program. Mirrors
 * Python's _forks.
 */
function forks(command: TSNodeLike | null, context: EvaluationContext): boolean {
  const session = context.session
  if (command?.type !== NT.COMMAND) return command?.type === NT.SUBSHELL
  let words = getParts(command).filter((part) => part.type !== NT.VARIABLE_ASSIGNMENT)
  let functions = true
  while (words[0] !== undefined && getText(words[0]) === 'command') {
    words = words.slice(1)
    functions = false
    while (words[0] !== undefined && getText(words[0]).startsWith('-')) {
      const option = getText(words[0])
      words = words.slice(1)
      if (option === '--') break
      if (option.includes('v') || option.includes('V')) return false
    }
  }
  let head = words[0]
  if (head === undefined) return false
  if (head.type === NT.COMMAND_NAME && head.namedChildren[0] !== undefined) {
    head = head.namedChildren[0]
  }
  const name = literalText(head)
  return (
    name === null ||
    (!BASH_BUILTINS.has(name) && !(functions && session.functions[name] !== undefined))
  )
}

export async function executeNode(
  deps: ExecuteNodeDeps,
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  // What expanding the node printed (a substitution's stderr) goes out with
  // the node's own stderr, unless its caller collects it: a simple
  // command's words expand before its redirects apply.
  ownDiagnostics = true,
  // The node is the whole of a child shell (a background job), which runs
  // its EXIT action when the node ends, its evaluator bound the way
  // `executeNodeBody` binds it for the node's own lines.
  endsShell = false,
): Promise<Result> {
  const session = context.session
  if (endsShell) {
    const { signal, executionScope } = deps
    const executeFn: ExecuteFn = (cmd, opts) =>
      deps.executeFn(cmd, {
        context,
        ...(signal !== undefined ? { signal } : {}),
        ...(executionScope !== undefined ? { executionScope } : {}),
        ...opts,
      })
    return endShell(
      executeFn,
      session,
      stdin,
      callStack,
      executeNode(deps, node, context, stdin, callStack, ownDiagnostics),
    )
  }
  const executionScope = deps.executionScope ?? new ExecutionScope()
  await executionScope.checkpoint(deps.signal ?? context.frame.abortSignal ?? undefined)
  if (!ownDiagnostics) {
    const result = await executeNodeBody(deps, node, context, stdin, callStack, executionScope)
    if (deps.signal?.aborted === true || context.frame.abortSignal?.aborted === true) {
      throw makeAbortError(
        deps.signal?.aborted === true ? deps.signal : (context.frame.abortSignal ?? undefined),
      )
    }
    return result
  }
  const outer = context.frame.diagnostics
  context.frame.diagnostics = []
  try {
    const [stdout, io, execNode] = await executeNodeBody(
      deps,
      node,
      context,
      stdin,
      callStack,
      executionScope,
    )
    // A statement that settles after the caller aborted is an orphan: its
    // status must not reach the shell the caller was already released from.
    if (deps.signal?.aborted === true || context.frame.abortSignal?.aborted === true) {
      throw makeAbortError(
        deps.signal?.aborted === true ? deps.signal : (context.frame.abortSignal ?? undefined),
      )
    }
    if (context.frame.diagnostics.length > 0) {
      const err = diagnosticStderr(node, context)
      const existing = await io.materializeStderr()
      const merged = new Uint8Array(err.length + existing.length)
      merged.set(err)
      merged.set(existing, err.length)
      io.stderr = merged
      execNode.stderr = merged
    }
    return [stdout, io, execNode]
  } catch (err) {
    if (err instanceof ExitSignal) {
      const extra = diagnosticStderr(node, context)
      const merged = new Uint8Array(extra.length + err.stderr.length)
      merged.set(extra)
      merged.set(err.stderr, extra.length)
      err.stderr = merged
    }
    throw err
  } finally {
    context.frame.diagnostics = outer
  }
}

function diagnosticStderr(node: TSNodeLike, context: EvaluationContext): Uint8Array {
  const head = getText(node).trimStart().split(/\s+/, 1)[0] ?? ''
  const builtin = ['export', 'declare', 'local', 'readonly', 'read', 'printf', 'let'].includes(head)
    ? head
    : ''
  const prefix = builtin === '' ? 'bash: ' : `bash: ${builtin}: `
  const parts = context.frame.diagnostics.map((message) =>
    typeof message === 'string' ? encodeText(prefix + message + '\n') : message,
  )
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

async function executeNodeBody(
  deps: ExecuteNodeDeps,
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  executionScope: ExecutionScope,
): Promise<Result> {
  const session = context.session
  // The scope and signal this subtree runs under are the ones its nested
  // evaluations run under, bound into `executeFn` here, at the one entry point
  // every node goes through, as Python binds them into `execute_fn`: a
  // background job runs without the caller's signal, and so must the lines
  // it evaluates, or a `$(...)` inside the job would die of an abort that
  // was never the job's.
  const inner = deps.executeFn
  const signal = deps.signal
  deps = {
    ...deps,
    executionScope,
    executeFn: (cmd, opts) => {
      if (opts.executionScope !== undefined) return inner(cmd, opts)
      const merged = mergeSignals(signal, opts.signal)
      return inner(cmd, {
        ...opts,
        executionScope,
        ...(merged !== undefined ? { signal: merged } : {}),
      })
    },
  }
  const { sink, ...captureDeps } = deps
  const recurse = (
    n: TSNodeLike,
    s: EvaluationContext,
    i: ByteSource | null,
    cs: CallStack | null,
    opts?: ExecuteNodeOpts,
  ): Promise<Result> =>
    executeNode(
      withOpts(captureDeps, opts),
      n,
      s,
      i,
      cs,
      opts?.ownDiagnostics !== false,
      opts?.endsShell === true,
    )
  const stream =
    sink === undefined
      ? recurse
      : (
          n: TSNodeLike,
          s: EvaluationContext,
          i: ByteSource | null,
          cs: CallStack | null,
          opts?: ExecuteNodeOpts,
        ): Promise<Result> =>
          executeNode(
            withOpts(deps, opts),
            n,
            s,
            i,
            cs,
            opts?.ownDiagnostics !== false,
            opts?.endsShell === true,
          )

  const { dispatch, registry, jobTable, agentId } = deps
  // Capture the walker's session before any await; a concurrent line's
  // ambient frame cannot identify this node's nested evaluations.
  const executeFn: ExecuteFn = (cmd, opts) => deps.executeFn(cmd, { context, ...opts })
  const kind = nodeKind(node)
  // A root run on a caller's frames is the caller's own line (eval,
  // source, an alias, `$( )`); one given none is a shell of its own.
  const inline = callStack !== null
  callStack ??= new CallStack()

  // The statements a construct runs all read one descriptor, as bash's
  // do: `read` takes its line and the command after it gets the rest, in
  // a group, a loop, a list, a subshell or a nested shell alike.
  if (STREAMING_KINDS.has(kind)) stdin = share(stdin)

  // `set -n` reads without executing, and it stops *everything* after
  // it, at every depth: GNU answers `if true; then set -n; echo BAD; fi`
  // and `f(){ set -n; echo BAD; }; f` with nothing at all. Stated here,
  // at the one entry point every node goes through, rather than in each
  // statement runner — the program loop, the subshell body, a group, a
  // function body and every loop body are five places for one rule to
  // drift, and it did: the check lived in the program loop alone, so
  // `set -n` worked flat and did nothing one construct deep. The program
  // loop keeps its own `break` as the reader-level stop, which is also
  // what silences `set -v` for the lines it never reads.
  if (session.shellOptions.noexec === true) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }
  if (deps.signal?.aborted === true || context.frame.abortSignal?.aborted === true) {
    throw makeAbortError(
      deps.signal?.aborted === true ? deps.signal : (context.frame.abortSignal ?? undefined),
    )
  }
  session.errexitImmune = false

  // A sink turns this walk from "return your output" into "write your
  // output". Sequencing constructs pass it to their children so each
  // statement lands as it finishes; everything else runs unchanged and
  // has its result drained here. Only STREAMING_KINDS inherit a sink,
  // so capture sites keep receiving their output as a value.
  if (
    sink !== undefined &&
    !STREAMING_KINDS.has(kind) &&
    kind !== NodeKind.COMMAND &&
    kind !== NodeKind.REDIRECT &&
    kind !== NodeKind.VAR_ASSIGN &&
    kind !== NodeKind.VAR_ASSIGNS
  ) {
    return drained(sink, ...(await recurse(node, context, stdin, callStack)))
  }

  if (kind === NodeKind.TIMED) {
    const started = performance.now()
    const inner = node.namedChildren[0]
    if (inner === undefined) throw new Error('timed statement has no body')
    const [body, io, execNode] = await stream(inner, context, stdin, callStack)
    const stdout = await applyBarrier(body, io, BarrierPolicy.VALUE)
    const elapsed = (performance.now() - started) / 1000
    const stderr = await io.materializeStderr()
    const reports = [...(node.timing ?? [])]
      .reverse()
      .map((portable) => timingReport(elapsed, portable, session.env.TIMEFORMAT))
    const merged = new Uint8Array(
      stderr.length + reports.reduce((n, report) => n + report.length, 0),
    )
    merged.set(stderr)
    let offset = stderr.length
    for (const report of reports) {
      merged.set(report, offset)
      offset += report.length
    }
    io.stderr = merged
    return [stdout, io, execNode]
  }

  if (kind === NodeKind.COMMENT) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }

  if (kind === NodeKind.PROGRAM) {
    const pending = redirectSyntaxFor(node)
    const statements = node.namedChildren.filter((child) => child.type !== NT.COMMENT)
    const last = statements.at(-1)
    if (pending.length > 0 && last === undefined) {
      return runRedirected(
        recurse,
        dispatch,
        executeFn,
        registry,
        deps.namespace,
        null,
        [...pending],
        deps.signal,
        jobTable.processes,
        sink,
        context,
        stdin,
        callStack,
      )
    }
    const programRecurse: Recurse =
      pending.length > 0 && last !== undefined
        ? (child, current, given, stack, options) =>
            recurseReassociated(
              recurse,
              dispatch,
              executeFn,
              registry,
              deps.namespace,
              pending,
              last,
              deps.signal,
              jobTable.processes,
              child,
              current,
              given,
              stack,
              options,
            )
        : recurse
    return executeProgram(
      programRecurse,
      node,
      context,
      stdin,
      callStack,
      jobTable,
      agentId,
      dispatch,
      deps.handed ?? null,
      registry.decisions,
      sink ?? null,
      inline,
      executeFn,
    )
  }

  if (kind === NodeKind.COMMAND) {
    const result = await runInCommandScope(() =>
      executeCommand(
        recurse,
        dispatch,
        registry,
        deps.namespace,
        executeFn,
        node,
        context,
        stdin,
        callStack,
        jobTable,
        deps.runtimeBindings,
        deps.routingDecision,
        deps.signal,
        deps.parser,
        agentId,
        deps.handed,
        sink,
      ),
    )
    return sink === undefined ? result : drained(sink, ...result)
  }

  if (kind === NodeKind.PIPELINE) {
    // `! a | b` parses as pipeline(negated_command(a), b), and a redirect
    // followed by `|` closes over everything to its left, so the stages
    // are read the way bash reads them rather than as the parse nested
    // them (see getPipelineStages).
    return runPipeline(
      recurse,
      dispatch,
      executeFn,
      registry,
      deps.namespace,
      getPipelineStages(node),
      context,
      stdin,
      callStack,
      deps.signal,
      jobTable.processes,
    )
  }

  if (kind === NodeKind.LIST) {
    const [left, op, right] = getListParts(node)
    return handleConnection(stream, left, op, right, context, stdin, callStack, executeFn)
  }

  if (kind === NodeKind.REDIRECT) {
    const [command, redirects] = getRedirects(node)
    // The `&&`/`||` steps a heredoc's operator line carried
    // (`false <<EOF || echo x`) wrap the whole statement, hoisted list
    // and all, exactly as a `list` node would have wrapped it had the
    // parser read the line the way bash does.
    const continuation = takeContinuation(redirects)
    const runLeft = runRedirected.bind(
      null,
      recurse,
      dispatch,
      executeFn,
      registry,
      deps.namespace,
      command,
      redirects,
      deps.signal,
      jobTable.processes,
      sink,
    )
    const result =
      continuation.length === 0
        ? await runLeft(context, stdin, callStack)
        : await runContinuation(
            recurse,
            runLeft,
            node,
            continuation,
            context,
            stdin,
            callStack,
            executeFn,
          )
    return sink === undefined ? result : drained(sink, ...result)
  }

  if (kind === NodeKind.SUBSHELL) {
    // A subshell is its own shell: background jobs started inside live
    // in a private job table (`$!`/`wait`/`kill` in the body see them;
    // the parent's table never does), mirroring bash's forked process.
    const subTable = jobTable.child()
    const abort = new AbortController()
    const subDeps: ExecuteNodeDeps = {
      ...captureDeps,
      jobTable: subTable,
      signal:
        deps.signal === undefined ? abort.signal : AbortSignal.any([deps.signal, abort.signal]),
    }
    // The opts parameter is load-bearing, not decoration: a job started
    // inside the subshell body hands `handleBackground` its own console
    // and abort signal through it. Dropping it (a 4-parameter closure
    // still satisfies ExecuteNodeFn, since function parameters are
    // bivariant) would run the nested job against the enclosing job's
    // sink and signal instead.
    const subRecurse = (
      n: TSNodeLike,
      s: EvaluationContext,
      inp: ByteSource | null,
      cs: CallStack | null,
      opts?: ExecuteNodeOpts,
    ): Promise<Result> =>
      executeNode(
        withOpts(subDeps, opts),
        n,
        s,
        inp,
        cs,
        opts?.ownDiagnostics !== false,
        opts?.endsShell === true,
      )
    const child = childContext(context)
    const asProgram = isProgramInvocation(session)
    let result: Result | undefined
    let process: ProcessHandle
    try {
      process = subTable.processes.start({
        sessionId: session.sessionId,
        command: node.text,
        cwd: PathSpec.fromStrPath(session.cwd),
        parentPid: session.processId,
        cancel: () => {
          abort.abort()
        },
        limit: session.processes.max,
        run: async () => {
          const body = () =>
            handleSubshell(
              subRecurse,
              node.children,
              child,
              stdin,
              callStack,
              subTable,
              agentId,
              dispatch,
              deps.handed ?? null,
              registry.decisions,
              sink ?? null,
              executeFn,
            )
          result = await runWithEvaluation(child, () =>
            asProgram ? runAsProgram(child.session, body) : body(),
          )
          return result[1].exitCode
        },
      })
    } catch (error) {
      if ((error as { code?: unknown }).code === 'EAGAIN')
        throw new ExitSignal(FORK_FAILED_STATUS, encodeText(FORK_FAILED))
      throw error
    }
    child.session.processId = process.info.pid

    await process.task
    if (result === undefined) throw new Error('subshell completed without a result')
    return result
  }

  if (kind === NodeKind.COMPOUND && node.children[0]?.type === NT.ARITH_OPEN) {
    const text = getText(node)
    const expr = await expandArith(
      node,
      context,
      executeFn,
      callStack,
      sessionView(session, registry.policies, context.frame.diagnostics),
    )
    const reader = randomReader(session)
    let error: ArithError | ReadonlyError | null = null
    let writes: readonly ArithWrite[] = []
    let value = 0n
    try {
      // Reads resolve against the visible env so a hidden name counts
      // as unset; a hidden write refuses at its own write below, in this
      // command's own voice like the readonly one.
      const result: ArithResult = sessionArith(session, expr, reader)
      writes = result.writes
      value = result.value
    } catch (err) {
      if (!(err instanceof ArithError || err instanceof ReadonlyError)) throw err
      // bash bound the assignments made before the error; they land
      // before the error is reported.
      error = err
      writes = err.writes
    }
    try {
      await landArith(
        session,
        sessionView(session, registry.policies, context.frame.diagnostics),
        writes,
        reader,
      )
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      const errBytes = encodeText(`bash: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
      ]
    }
    if (error instanceof ReadonlyError) {
      if (error.inSubscript) throw error.signal()
      const errBytes = encodeText(`bash: ${error.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
      ]
    }
    if (error !== null) {
      const errBytes = encodeText(`bash: ((: ${expr}: ${error.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
      ]
    }
    const code = value !== 0n ? 0 : 1
    return [
      null,
      new IOResult({ exitCode: code }),
      new ExecutionNode({ command: text, exitCode: code }),
    ]
  }

  if (kind === NodeKind.COMPOUND) {
    return executeBody(
      stream,
      node.namedChildren,
      context,
      stdin,
      callStack,
      jobTable,
      agentId,
      deps.handed ?? null,
      registry.decisions,
      executeFn,
      sink ?? null,
    )
  }

  if (kind === NodeKind.IF) {
    const [branches, elseBody] = getIfBranches(node)
    return handleIf(
      stream,
      branches,
      elseBody,
      context,
      stdin,
      callStack,
      jobTable,
      agentId,
      deps.handed ?? null,
      registry.decisions,
      executeFn,
      sink ?? null,
    )
  }

  if (kind === NodeKind.CFOR) {
    const [exprs, body] = getCforParts(node)
    const evalExpr: CforEval = (e, d) =>
      evalCforExpr(
        e,
        d,
        context,
        executeFn,
        callStack,
        sessionView(session, registry.policies, context.frame.diagnostics),
      )
    return callStack.loop(() =>
      handleCfor(
        stream,
        exprs,
        body,
        evalExpr,
        context,
        stdin,
        callStack,
        jobTable,
        agentId,
        deps.handed ?? null,
        registry.decisions,
        executeFn,
        sink ?? null,
      ),
    )
  }

  if (kind === NodeKind.FOR || kind === NodeKind.SELECT) {
    const [variable, values, body] = getForParts(node)
    if (!isValidName(variable)) {
      const err = encodeText(`bash: \`${variable}': not a valid identifier\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: kind, exitCode: 1, stderr: err }),
      ]
    }
    const resolved = await runInCommandScope(async () => {
      const classified = await expandAndClassify(
        values,
        context,
        executeFn,
        registry,
        session.cwd,
        callStack,
        sessionView(session, registry.policies, context.frame.diagnostics),
      )
      // The loop word list is consumed by the shell (WordPolicy.SHELL):
      // globs resolve to matches before iteration starts.
      return resolveGlobs(
        classified,
        registry,
        session.shellOptions.noglob === true,
        deps.namespace,
        globOptions(session),
      )
    })
    if (kind === NodeKind.SELECT) {
      return callStack.loop(() =>
        handleSelect(
          stream,
          variable,
          resolved,
          body,
          context,
          stdin,
          callStack,
          registry.policies,
          jobTable,
          agentId,
          deps.handed ?? null,
          registry.decisions,
          mergeSignals(deps.signal, context.frame.abortSignal),
          sink,
          executeFn,
        ),
      )
    }
    return callStack.loop(() =>
      handleFor(
        stream,
        variable,
        resolved,
        body,
        context,
        stdin,
        callStack,
        registry.policies,
        jobTable,
        agentId,
        deps.handed ?? null,
        registry.decisions,
        executeFn,
        sink ?? null,
      ),
    )
  }

  if (kind === NodeKind.WHILE || kind === NodeKind.UNTIL) {
    const [test, body] = getWhileParts(node)
    if (kind === NodeKind.UNTIL) {
      return callStack.loop(() =>
        handleUntil(
          stream,
          test,
          body,
          context,
          stdin,
          callStack,
          jobTable,
          agentId,
          deps.handed ?? null,
          registry.decisions,
          executeFn,
          sink ?? null,
        ),
      )
    }
    return callStack.loop(() =>
      handleWhile(
        stream,
        test,
        body,
        context,
        stdin,
        callStack,
        jobTable,
        agentId,
        deps.handed ?? null,
        registry.decisions,
        executeFn,
        sink ?? null,
      ),
    )
  }

  if (kind === NodeKind.CASE) {
    const wordNode = getCaseWord(node)
    const word = await expandNode(
      wordNode,
      context,
      executeFn,
      callStack,
      sessionView(session, registry.policies, context.frame.diagnostics),
    )
    const items: [string[], TSNodeLike[], string][] = []
    for (const [patternNodes, body, terminator] of getCaseItems(node)) {
      const patterns: string[] = []
      for (const patternNode of patternNodes) {
        patterns.push(
          await expandPattern(
            patternNode,
            context,
            executeFn,
            callStack,
            sessionView(session, registry.policies, context.frame.diagnostics),
          ),
        )
      }
      items.push([patterns, body, terminator])
    }
    return handleCase(
      stream,
      word,
      items,
      context,
      stdin,
      callStack,
      jobTable,
      agentId,
      deps.handed ?? null,
      registry.decisions,
      executeFn,
      sink ?? null,
    )
  }

  if (kind === NodeKind.FUNCTION_DEF) {
    const name = getFunctionName(node)
    if (session.readonlyFunctions.has(name)) {
      // `readonly -f f` froze the body: either definition syntax refuses
      // with `f: readonly function`, exit 1, and the old body stays,
      // pinned on 5.2.37.
      const err = encodeText(`bash: ${name}: readonly function\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: `function ${name}`, exitCode: 1, stderr: err }),
      ]
    }
    const source = getFunctionSource(node)
    session.functions[name] = source
    const mark: [number, number] = [
      session.parseCurrent,
      session.parseRow + (node.startPosition?.row ?? 0),
    ]
    session.functionSites.set(name, {
      source,
      mark,
      origin: definedAt(node, deps.handed ?? null),
      aliases: aliasView(session, node, aliasMark(session, readRow(node))),
    })
    return [null, new IOResult(), new ExecutionNode({ command: `function ${name}`, exitCode: 0 })]
  }

  if (kind === NodeKind.DECLARATION) {
    return await runInCommandScope(() =>
      executeDeclaration(
        node,
        context,
        executeFn,
        registry,
        deps.namespace,
        callStack,
        deps.parser,
      ),
    )
  }

  if (kind === NodeKind.UNSET) {
    return handleUnset(
      getUnsetArgs(node),
      session,
      sessionView(session, registry.policies, context.frame.diagnostics),
    )
  }

  if (kind === NodeKind.TEST) {
    const opener = node.children[0]?.type ?? '['
    if (opener === '[[') {
      const tree = await expandDoubleBracket(
        node,
        context,
        executeFn,
        callStack,
        sessionView(session, registry.policies, context.frame.diagnostics),
      )
      return handleTest(
        dispatch,
        deps.namespace,
        tree,
        session,
        '[[',
        sessionView(session, registry.policies, context.frame.diagnostics),
      )
    }
    const expanded = await expandTestExpr(
      node,
      context,
      executeFn,
      callStack,
      sessionView(session, registry.policies, context.frame.diagnostics),
    )
    return handleTest(
      dispatch,
      deps.namespace,
      expanded,
      session,
      '[',
      sessionView(session, registry.policies, context.frame.diagnostics),
    )
  }

  if (kind === NodeKind.NEGATED) {
    const inner = getNegatedCommand(node)
    const [stdout, io, execNode] = await ignoringErrexit(context.session, () =>
      stream(inner, context, stdin, callStack),
    )
    return negated(stdout, io, execNode, context, inner)
  }

  if (kind === NodeKind.VAR_ASSIGN) {
    return await executeAssignment(node, context, executeFn, registry, deps.namespace, callStack)
  }

  // Assignment-only statement (a=1 b=2).
  if (kind === NodeKind.VAR_ASSIGNS) {
    const subSeq = context.frame.cmdsubSeq
    let mergedIo = new IOResult()
    for (const child of node.namedChildren) {
      if (child.type !== NT.VARIABLE_ASSIGNMENT) continue
      const [, io] = await recurse(child, context, stdin, callStack, { ownDiagnostics: false })
      mergedIo = await mergedIo.merge(io)
    }
    // The statement's status follows the last command substitution
    // performed across ALL its assignments, not the last child's.
    const code = assignmentStatus(context.frame, subSeq)
    mergedIo.exitCode = code
    return [null, mergedIo, new ExecutionNode({ command: getText(node), exitCode: code })]
  }

  // Constructs the parser accepts but the executor cannot honor (e.g.
  // C-style `for ((;;))`). Mirrors the unsupported-builtin diagnostic
  // so agents see a capability gap, not a crash.
  const unsupportedErr = encodeText(`mirage: unsupported shell construct: ${node.type}\n`)
  return [
    null,
    new IOResult({ exitCode: 2, stderr: unsupportedErr }),
    new ExecutionNode({ command: node.text, exitCode: 2, stderr: unsupportedErr }),
  ]
}
